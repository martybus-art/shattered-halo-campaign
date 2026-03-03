// supabase/functions/create-campaign/index.ts
// Creates a campaign, adds the creator as lead, stores pending invites,
// creates a map record, and fires generate-map as a background task.
//
// changelog:
//   2026-03-03 — added campaign_narrative field (stored on campaigns row);
//                added layout/zone_count/biome/mixed_biomes params;
//                added map record creation (maps table insert);
//                added background call to generate-map edge function so the
//                map image starts generating immediately after campaign creation;
//                returns map_id in response so frontend can poll MapImageDisplay.

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

  // ── Extract params ────────────────────────────────────────────────────────

  const template_id         = body?.template_id;
  const campaign_name       = body?.campaign_name;
  const campaign_narrative  = body?.campaign_narrative ?? "";
  const player_emails       = Array.isArray(body?.player_emails) ? body.player_emails : [];

  const ruleset_id          = body?.ruleset_id ?? null;
  const rules_overrides     = body?.rules_overrides ?? {};
  const map_id_override     = body?.map_id ?? null;   // allow pre-existing map (legacy)

  // Map generation params
  const layout              = body?.layout        ?? "ring";
  const zone_count          = Number(body?.zone_count ?? 8);
  const biome               = body?.biome         ?? "ash_wastes";
  const mixed_biomes        = Boolean(body?.mixed_biomes ?? false);

  // ── Validate ──────────────────────────────────────────────────────────────

  if (!template_id || !campaign_name) {
    return json(400, { ok: false, error: "Missing template_id or campaign_name" });
  }
  if (typeof rules_overrides !== "object" || Array.isArray(rules_overrides)) {
    return json(400, { ok: false, error: "rules_overrides must be an object" });
  }

  // Validate template exists
  const { data: tpl, error: tplErr } = await admin
    .from("templates").select("id").eq("id", template_id).maybeSingle();
  if (tplErr) return json(500, { ok: false, error: "Template lookup failed", details: tplErr.message });
  if (!tpl)   return json(400, { ok: false, error: "Template not found" });

  // Validate ruleset if provided
  if (ruleset_id) {
    const { data: rs, error: rsErr } = await admin
      .from("rulesets").select("id").eq("id", ruleset_id).maybeSingle();
    if (rsErr) return json(500, { ok: false, error: "Ruleset lookup failed", details: rsErr.message });
    if (!rs)   return json(400, { ok: false, error: "Ruleset not found" });
  }

  // ── Create campaign ───────────────────────────────────────────────────────

  const { data: campaign, error: cErr } = await admin
    .from("campaigns")
    .insert({
      template_id,
      name:               String(campaign_name),
      campaign_narrative: String(campaign_narrative),
      phase:              1,
      round_number:       0,   // 0 = not yet started; start-campaign sets this to 1
      instability:        0,
      ruleset_id,
      rules_overrides,
      map_id:             map_id_override,
    })
    .select()
    .single();

  if (cErr || !campaign) {
    return json(500, { ok: false, error: "Campaign insert failed", details: cErr?.message });
  }

  // ── Add creator as lead ───────────────────────────────────────────────────

  const { error: memErr } = await admin.from("campaign_members").insert({
    campaign_id: campaign.id,
    user_id:     user.id,
    role:        "lead",
  });
  if (memErr) {
    return json(500, { ok: false, error: "Lead membership insert failed", details: memErr.message });
  }

  // ── Store pending invites ─────────────────────────────────────────────────

  const invites = player_emails
    .map((e: any) => String(e).trim().toLowerCase())
    .filter(Boolean)
    .map((email: string) => ({ campaign_id: campaign.id, email }));

  if (invites.length) {
    const { error: invErr } = await admin.from("pending_invites").insert(invites);
    if (invErr) {
      return json(500, { ok: false, error: "Invite insert failed", details: invErr.message });
    }
  }

  // ── Create map record ─────────────────────────────────────────────────────
  // Creates the map row immediately so generate-map has a target to update.

  let newMapId: string | null = map_id_override;

  if (!map_id_override) {
    const { data: mapRow, error: mapErr } = await admin
      .from("maps")
      .insert({
        campaign_id:          campaign.id,
        name:                 `${String(campaign_name)} Map`,
        description:          campaign_narrative ? String(campaign_narrative).slice(0, 200) : null,
        map_json:             {},
        visibility:           "private",
        recommended_players:  zone_count,
        max_players:          zone_count,
        created_by:           user.id,
        status:               "pending",
      })
      .select("id")
      .single();

    if (mapErr || !mapRow) {
      // Non-fatal — campaign was created, map generation just won't start
      console.error("[create-campaign] Map insert failed:", mapErr?.message);
    } else {
      newMapId = mapRow.id;

      // Link the map back to the campaign
      await admin
        .from("campaigns")
        .update({ map_id: newMapId })
        .eq("id", campaign.id);
    }
  }

  // ── Fire generate-map in background ──────────────────────────────────────
  // Uses EdgeRuntime.waitUntil so the response is returned immediately while
  // generation continues. Falls back to a detached fetch if not available.

  if (newMapId) {
    const supabaseUrl     = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";

    const generatePayload = JSON.stringify({
      map_id:             newMapId,
      campaign_id:        campaign.id,
      layout,
      zone_count,
      biome,
      mixed_biomes,
      campaign_name:      String(campaign_name),
      campaign_narrative: String(campaign_narrative),
      art_version:        "grimdark-v2",
    });

    const generateFetch = fetch(`${supabaseUrl}/functions/v1/generate-map`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "apikey":        serviceRoleKey,
      },
      body: generatePayload,
    }).catch((e) => {
      console.error("[create-campaign] Background generate-map call failed:", e?.message);
    });

    // Use EdgeRuntime.waitUntil if available (Supabase edge runtime v1.36+)
    try {
      (globalThis as any).EdgeRuntime?.waitUntil?.(generateFetch);
    } catch {
      // waitUntil not available — fetch is already in flight, ignore
    }
  }

  // ── Return ────────────────────────────────────────────────────────────────

  return json(200, {
    ok:          true,
    campaign_id: campaign.id,
    map_id:      newMapId,
  });
});
