// supabase/functions/assign-zone-effects/index.ts
// One-time backfill edge function: assigns zone effects to campaigns that
// were created before the zone effects system existed.
//
// Accepts:
//   { campaign_id: string }           -- assign effects to one specific campaign
//   { mode: "backfill_all" }          -- assign effects to all active campaigns
//                                        that have at least one zone with no effect
//
// In both cases the function is fully idempotent:
//   - Zones that already have an effect assigned are skipped
//   - The same campaign_id can be sent multiple times safely
//
// Security: Lead or admin role required. In backfill_all mode the caller
// must be a lead/admin of at least one campaign; all active campaigns are
// processed regardless of the caller (intended for one-time setup by a
// system admin — tighten this if needed).
//
// changelog:
//   2026-03-15 -- Initial creation. Backfill companion to the zone effects
//                 assignment added to start-campaign. Uses the same
//                 assignZoneEffects() logic extracted to a shared helper.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

type MapZone = {
  key: string;
  name: string;
  sectors: { key: string; name?: string }[];
};

type MapDef = {
  zones: MapZone[];
};

function fallbackMap(): MapDef {
  const zones = [
    { key: "vault_ruins",         name: "Vault Ruins" },
    { key: "ash_wastes",          name: "Ash Wastes" },
    { key: "halo_spire",          name: "Halo Spire" },
    { key: "sunken_manufactorum", name: "Sunken Manufactorum" },
    { key: "warp_scar_basin",     name: "Warp Scar Basin" },
    { key: "obsidian_fields",     name: "Obsidian Fields" },
    { key: "signal_crater",       name: "Signal Crater" },
    { key: "xenos_forest",        name: "Xenos Forest" },
  ];
  const sectorLetters = ["a", "b", "c", "d"];
  return {
    zones: zones.map((z) => ({
      ...z,
      sectors: sectorLetters.map((s) => ({ key: `${z.key}:${s}` })),
    })),
  };
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// assignZoneEffects
// ---------------------------------------------------------------------------
// Core assignment logic — mirrors the function in start-campaign/index.ts.
// Kept in sync manually; if the logic changes, update both files.
// ---------------------------------------------------------------------------
async function assignZoneEffects(
  admin: ReturnType<typeof adminClient>,
  campaign_id: string,
  mapDef: MapDef
): Promise<{ assigned: number; skipped: number }> {
  // 1. Check which zones already have effects (idempotency guard)
  const { data: existing, error: existErr } = await admin
    .from("campaign_zone_effects")
    .select("zone_key, zone_effect_id")
    .eq("campaign_id", campaign_id);

  if (existErr) {
    console.error(`[assign-zone-effects] existing check error (${campaign_id}):`, existErr.message);
    return { assigned: 0, skipped: 0 };
  }

  const assignedZoneKeys    = new Set((existing ?? []).map((r: any) => r.zone_key as string));
  const usedEffectIds       = new Set((existing ?? []).map((r: any) => r.zone_effect_id as string));
  const zonesNeedingEffects = mapDef.zones.filter((z) => !assignedZoneKeys.has(z.key));
  const skipped             = mapDef.zones.length - zonesNeedingEffects.length;

  if (!zonesNeedingEffects.length) {
    return { assigned: 0, skipped };
  }

  // 2. Load active zone effects from the reference table
  const { data: effects, error: effectErr } = await admin
    .from("zone_effects")
    .select("id, slug, scope")
    .eq("is_active", true);

  if (effectErr || !effects?.length) {
    console.error(`[assign-zone-effects] could not load zone_effects:`, effectErr?.message ?? "empty");
    return { assigned: 0, skipped };
  }

  // 3. Build pool: prefer effects not yet used in this campaign; wrap if exhausted
  const preferredPool = shuffle((effects as any[]).filter((e) => !usedEffectIds.has(e.id as string)));
  const fallbackPool  = shuffle(effects as any[]);
  let   pool          = [...preferredPool];

  // 4. Build rows
  const rows: {
    campaign_id:    string;
    zone_key:       string;
    zone_name:      string;
    zone_effect_id: string;
  }[] = [];

  for (const zone of zonesNeedingEffects) {
    if (!pool.length) {
      pool = shuffle([...fallbackPool]);
    }
    const effect = pool.shift()!;

    rows.push({
      campaign_id,
      zone_key:              zone.key,
      zone_name:             zone.name ?? zone.key,
      zone_effect_id:        effect.id,
    });

    usedEffectIds.add(effect.id as string);
    pool = pool.filter((e) => e.id !== effect.id);
  }

  if (!rows.length) return { assigned: 0, skipped };

  const { error: insertErr } = await admin
    .from("campaign_zone_effects")
    .upsert(rows, { onConflict: "campaign_id,zone_key", ignoreDuplicates: true });

  if (insertErr) {
    console.error(`[assign-zone-effects] upsert error (${campaign_id}):`, insertErr.message);
    return { assigned: 0, skipped };
  }

  return { assigned: rows.length, skipped };
}

// ---------------------------------------------------------------------------
// Helper: resolve map_json for a campaign
// ---------------------------------------------------------------------------
async function resolveMap(
  admin: ReturnType<typeof adminClient>,
  campaign_id: string
): Promise<MapDef> {
  const { data: camp } = await admin
    .from("campaigns")
    .select("map_id")
    .eq("id", campaign_id)
    .maybeSingle();

  if (camp?.map_id) {
    const { data: mapRow } = await admin
      .from("maps")
      .select("map_json")
      .eq("id", camp.map_id)
      .maybeSingle();

    if (mapRow?.map_json) {
      try {
        const mj = mapRow.map_json as any;
        if (mj?.zones?.length) return mj as MapDef;
      } catch { /* fall through to fallback */ }
    }
  }

  return fallbackMap();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const admin = adminClient();
    const body  = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const mode        = (body.mode as string | undefined) ?? "single";
    const campaign_id = body.campaign_id as string | undefined;

    // ── Single campaign mode ──────────────────────────────────────────────────
    if (mode !== "backfill_all") {
      if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });

      // Verify caller is lead or admin of this campaign
      const { data: memberRow, error: memErr } = await admin
        .from("campaign_members")
        .select("role")
        .eq("campaign_id", campaign_id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (memErr) return json(500, { ok: false, error: memErr.message });
      if (!memberRow || !["lead", "admin"].includes(memberRow.role)) {
        return json(403, { ok: false, error: "Lead or admin role required" });
      }

      const map    = await resolveMap(admin, campaign_id);
      const result = await assignZoneEffects(admin, campaign_id, map);

      return json(200, {
        ok: true,
        campaign_id,
        assigned: result.assigned,
        skipped:  result.skipped,
        message:  `Assigned ${result.assigned} effect(s); ${result.skipped} zone(s) already had effects.`,
      });
    }

    // ── Backfill all mode ─────────────────────────────────────────────────────
    // Verify caller is lead/admin of at least one campaign
    const { data: callerMemberships, error: callerErr } = await admin
      .from("campaign_members")
      .select("campaign_id, role")
      .eq("user_id", user.id)
      .in("role", ["lead", "admin"]);

    if (callerErr) return json(500, { ok: false, error: callerErr.message });
    if (!callerMemberships?.length) {
      return json(403, { ok: false, error: "Lead or admin role required on at least one campaign" });
    }

    // Load all active campaigns
    const { data: campaigns, error: campErr } = await admin
      .from("campaigns")
      .select("id, status")
      .eq("status", "active");

    if (campErr) return json(500, { ok: false, error: campErr.message });
    if (!campaigns?.length) return json(200, { ok: true, results: [], message: "No active campaigns found." });

    const results: { campaign_id: string; assigned: number; skipped: number }[] = [];

    for (const camp of campaigns) {
      const map    = await resolveMap(admin, camp.id);
      const r      = await assignZoneEffects(admin, camp.id, map);
      results.push({ campaign_id: camp.id, assigned: r.assigned, skipped: r.skipped });
    }

    const totalAssigned = results.reduce((sum, r) => sum + r.assigned, 0);
    const totalSkipped  = results.reduce((sum, r) => sum + r.skipped, 0);

    return json(200, {
      ok:           true,
      campaigns:    results.length,
      totalAssigned,
      totalSkipped,
      results,
      message:      `Processed ${results.length} campaign(s). Assigned ${totalAssigned} effect(s); ${totalSkipped} zone(s) already had effects.`,
    });

  } catch (e) {
    return json(500, { ok: false, error: (e as Error).message ?? "Internal error" });
  }
});
