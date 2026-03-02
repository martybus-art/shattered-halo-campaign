// supabase/functions/create-campaign/index.ts
// Creates a campaign row, lead membership, pending invites, a maps row,
// and fires generate-map asynchronously to produce the AI map image.
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

  const template_id:     string          = body?.template_id;
  const campaign_name:   string          = body?.campaign_name;
  const player_emails:   string[]        = Array.isArray(body?.player_emails) ? body.player_emails : [];
  const ruleset_id:      string | null   = body?.ruleset_id ?? null;
  const rules_overrides: Record<string, unknown> = body?.rules_overrides ?? {};

  // ── Map generation parameters ────────────────────────────────────────────
  // layout + zone_count come from the campaigns page layout selector.
  // legacy_map_id: if a caller passes a pre-existing map row UUID we skip
  // creation and just link it. In normal campaign creation this is null.
  const layout:        string       = body?.layout      ?? "ring";
  const zone_count:    number       = body?.zone_count  ?? 8;
  const legacy_map_id: string | null = body?.map_id     ?? null;

  // ── Validation ────────────────────────────────────────────────────────────

  if (!template_id || !campaign_name) {
    return json(400, { ok: false, error: "Missing template_id or campaign_name" });
  }
  if (typeof rules_overrides !== "object" || Array.isArray(rules_overrides)) {
    return json(400, { ok: false, error: "rules_overrides must be an object" });
  }

  // Validate template
  const { data: tpl, error: tplErr } = await admin
    .from("templates").select("id").eq("id", template_id).maybeSingle();
  if (tplErr) return json(500, { ok: false, error: "Template lookup failed",  details: tplErr.message });
  if (!tpl)   return json(400, { ok: false, error: "Template not found" });

  // Validate ruleset if provided
  if (ruleset_id) {
    const { data: rs, error: rsErr } = await admin
      .from("rulesets").select("id").eq("id", ruleset_id).maybeSingle();
    if (rsErr) return json(500, { ok: false, error: "Ruleset lookup failed", details: rsErr.message });
    if (!rs)   return json(400, { ok: false, error: "Ruleset not found" });
  }

  // ── Create campaign row (map_id set to null — patched below) ─────────────

  const { data: campaign, error: cErr } = await admin
    .from("campaigns")
    .insert({
      template_id,
      name:          String(campaign_name),
      phase:         1,
      round_number:  1,
      instability:   0,
      ruleset_id,
      rules_overrides,
      map_id:        null,   // patched after maps row is created
    })
    .select()
    .single();

  if (cErr || !campaign) {
    return json(500, { ok: false, error: "Campaign insert failed", details: cErr?.message });
  }

  // ── Lead membership ───────────────────────────────────────────────────────

  const { error: memErr } = await admin.from("campaign_members").insert({
    campaign_id: campaign.id,
    user_id:     user.id,
    role:        "lead",
  });
  if (memErr) {
    return json(500, { ok: false, error: "Lead membership insert failed", details: memErr.message });
  }

  // ── Pending invites ───────────────────────────────────────────────────────

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

  // ── Create maps row + trigger generation ─────────────────────────────────
  //
  // Normal flow:  create a maps row in "pending" state, patch campaign.map_id,
  //               then invoke generate-map via EdgeRuntime.waitUntil so the HTTP
  //               response returns immediately without waiting for OpenAI.
  //
  // Legacy flow:  caller passed an existing map_id — just link it and skip.

  let resolved_map_id: string | null = legacy_map_id;

  if (!legacy_map_id) {
    const seed = crypto.randomUUID();

    const { data: mapRow, error: mapErr } = await admin
      .from("maps")
      .insert({
        name:              String(campaign_name),
        layout,
        zone_count,
        seed,
        generation_status: "pending",
        art_version:       "grimdark-v2",
      })
      .select("id")
      .single();

    if (mapErr || !mapRow) {
      // Non-fatal: campaign is usable without a map, log and continue
      console.error("create-campaign: maps row insert failed —", mapErr?.message);
    } else {
      resolved_map_id = mapRow.id;
      console.log("create-campaign: maps row created —", resolved_map_id);

      // Patch campaign with its map_id
      const { error: patchErr } = await admin
        .from("campaigns")
        .update({ map_id: resolved_map_id })
        .eq("id", campaign.id);

      if (patchErr) {
        console.error("create-campaign: campaign map_id patch failed —", patchErr.message);
      }

      // Fire generate-map asynchronously — response returns to the user
      // immediately while generation runs in the background.
      // MapImageDisplay polls every 5 s and will show the image once complete.
      EdgeRuntime.waitUntil(
        admin.functions
          .invoke("generate-map", {
            body: {
              map_id:      resolved_map_id,
              campaign_id: campaign.id,
              seed,
              layout,
              zone_count,
              art_version: "grimdark-v2",
            },
          })
          .then(({ error: genErr }) => {
            if (genErr) {
              console.error(
                "create-campaign: generate-map invocation failed —",
                genErr.message ?? String(genErr),
              );
            } else {
              console.log("create-campaign: generate-map invoked OK — map", resolved_map_id);
            }
          })
      );
    }
  } else {
    // Legacy: pre-existing map_id passed in, just link it
    await admin
      .from("campaigns")
      .update({ map_id: legacy_map_id })
      .eq("id", campaign.id);
  }

  return json(200, {
    ok:          true,
    campaign_id: campaign.id,
    map_id:      resolved_map_id,
  });
});
