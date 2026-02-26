import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json, requireUser, adminClient } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const result = await requireUser(req);
  if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
  const user = result.user;

  const admin = adminClient();

  const body = await req.json().catch(() => ({}));
  const template_id = body?.template_id;
  const campaign_name = body?.campaign_name;
  const player_emails = Array.isArray(body?.player_emails) ? body.player_emails : [];

  const ruleset_id = body?.ruleset_id ?? null;
  const rules_overrides = body?.rules_overrides ?? {};
  const map_id = body?.map_id ?? null;

  if (!template_id || !campaign_name) {
    return json(400, { ok: false, error: "Missing template_id or campaign_name" });
  }
  if (typeof rules_overrides !== "object" || Array.isArray(rules_overrides)) {
    return json(400, { ok: false, error: "rules_overrides must be an object" });
  }

  // Validate template exists (nicer than FK error)
  const { data: tpl, error: tplErr } = await admin.from("templates").select("id").eq("id", template_id).maybeSingle();
  if (tplErr) return json(500, { ok: false, error: "Template lookup failed", details: tplErr.message });
  if (!tpl) return json(400, { ok: false, error: "Template not found" });

  // Optional validate ruleset/map when provided
  if (ruleset_id) {
    const { data: rs, error: rsErr } = await admin.from("rulesets").select("id").eq("id", ruleset_id).maybeSingle();
    if (rsErr) return json(500, { ok: false, error: "Ruleset lookup failed", details: rsErr.message });
    if (!rs) return json(400, { ok: false, error: "Ruleset not found" });
  }
  if (map_id) {
    const { data: mp, error: mpErr } = await admin.from("maps").select("id").eq("id", map_id).maybeSingle();
    if (mpErr) return json(500, { ok: false, error: "Map lookup failed", details: mpErr.message });
    if (!mp) return json(400, { ok: false, error: "Map not found" });
  }

  const { data: campaign, error: cErr } = await admin
    .from("campaigns")
    .insert({
      template_id,
      name: String(campaign_name),
      phase: 1,
      round_number: 1,
      instability: 0,
      ruleset_id,
      rules_overrides,
      map_id,     
    })
    .select()
    .single();

  if (cErr || !campaign) return json(500, { ok: false, error: "Campaign insert failed", details: cErr?.message });

  const { error: memErr } = await admin.from("campaign_members").insert({
    campaign_id: campaign.id,
    user_id: user.id,
    role: "lead",
  });
  if (memErr) return json(500, { ok: false, error: "Lead membership insert failed", details: memErr.message });

  const invites = player_emails
    .map((e: any) => String(e).trim().toLowerCase())
    .filter(Boolean)
    .map((email: string) => ({ campaign_id: campaign.id, email }));

  if (invites.length) {
    const { error: invErr } = await admin.from("pending_invites").insert(invites);
    if (invErr) return json(500, { ok: false, error: "Invite insert failed", details: invErr.message });
  }

  return json(200, { ok: true, campaign_id: campaign.id });
});
