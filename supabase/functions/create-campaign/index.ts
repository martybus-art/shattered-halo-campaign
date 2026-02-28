import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json, requireUser, adminClient } from "../_shared/utils.ts";

const REDIRECT_URL = "https://40kcampaigngame.fun";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const result = await requireUser(req);
  if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
  const user = result.user;

  const admin = adminClient();

  const body = await req.json().catch(() => ({}));
  const template_id     = body?.template_id;
  const campaign_name   = body?.campaign_name;
  const player_emails   = Array.isArray(body?.player_emails) ? body.player_emails : [];
  const ruleset_id      = body?.ruleset_id ?? null;
  const rules_overrides = body?.rules_overrides ?? {};
  const map_id          = body?.map_id ?? null;
  const invite_message  = typeof body?.invite_message === "string"
    ? body.invite_message.trim() || null
    : null;

  if (!template_id || !campaign_name) {
    return json(400, { ok: false, error: "Missing template_id or campaign_name" });
  }
  if (typeof rules_overrides !== "object" || Array.isArray(rules_overrides)) {
    return json(400, { ok: false, error: "rules_overrides must be an object" });
  }

  // Validate template
  const { data: tpl, error: tplErr } = await admin
    .from("templates").select("id").eq("id", template_id).maybeSingle();
  if (tplErr) return json(500, { ok: false, error: "Template lookup failed", details: tplErr.message });
  if (!tpl)   return json(400, { ok: false, error: "Template not found" });

  // Optional validate ruleset / map
  if (ruleset_id) {
    const { data: rs, error: rsErr } = await admin
      .from("rulesets").select("id").eq("id", ruleset_id).maybeSingle();
    if (rsErr) return json(500, { ok: false, error: "Ruleset lookup failed", details: rsErr.message });
    if (!rs)   return json(400, { ok: false, error: "Ruleset not found" });
  }
  if (map_id) {
    const { data: mp, error: mpErr } = await admin
      .from("maps").select("id").eq("id", map_id).maybeSingle();
    if (mpErr) return json(500, { ok: false, error: "Map lookup failed", details: mpErr.message });
    if (!mp)   return json(400, { ok: false, error: "Map not found" });
  }

  // Create campaign
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
      invite_message,
    })
    .select()
    .single();

  if (cErr || !campaign) {
    return json(500, { ok: false, error: "Campaign insert failed", details: cErr?.message });
  }

  // Add creator as lead
  const { error: memErr } = await admin.from("campaign_members").insert({
    campaign_id: campaign.id,
    user_id: user.id,
    role: "lead",
  });
  if (memErr) {
    return json(500, { ok: false, error: "Lead membership insert failed", details: memErr.message });
  }

  // Handle initial player invites
  const emails = player_emails
    .map((e: any) => String(e).trim().toLowerCase())
    .filter(Boolean);

  if (emails.length) {
    // Insert pending_invites rows
    const inviteRows = emails.map((email: string) => ({
      campaign_id: campaign.id,
      email,
    }));
    const { error: invErr } = await admin.from("pending_invites").insert(inviteRows);
    if (invErr) {
      return json(500, { ok: false, error: "Invite insert failed", details: invErr.message });
    }

    // Send invite emails via Supabase Auth (routes through configured SMTP/Resend)
    for (const email of emails) {
      try {
        const { error: authErr } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${REDIRECT_URL}?campaign_invite=1`,
          data: {
            campaign_id: campaign.id,
            campaign_name: String(campaign_name),
            invite_message: invite_message ?? "",
          },
        });

        if (authErr) {
          // Existing users won't get an email here — that's fine, they'll see
          // the invite on their next login via the pending_invites row.
          const alreadyExists =
            authErr.message.toLowerCase().includes("already") ||
            authErr.message.toLowerCase().includes("registered") ||
            authErr.message.toLowerCase().includes("exists");

          if (!alreadyExists) {
            console.warn(`invite email failed for ${email}: ${authErr.message}`);
          }
        }
      } catch (e: any) {
        console.warn(`invite email exception for ${email}: ${e?.message}`);
      }
    }
  }

  return json(200, { ok: true, campaign_id: campaign.id });
});
