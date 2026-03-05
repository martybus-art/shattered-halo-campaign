// supabase/functions/submit-move/index.ts
// Validates and records a unit movement order.
//
// Rules enforced:
//   - Movement phase: any unit (scout or occupation), 1 step adjacency.
//   - Recon phase: scout units only, requires recon token purchased this round.
//   - Deep strike: occupation or scout can move anywhere on map if the player
//     has a deep_strike token this round. Occupation deep-striking into an
//     unscouted sector records a defensive_bonus flag on the resulting conflict.
//   - Occupation into undefended enemy sector: ownership auto-transferred.
//   - Scout or occupation into defended enemy sector: conflict record inserted.
//   - One move per unit per round (can update before phase ends).
//
// changelog:
//   2026-03-05 -- Initial implementation.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const SECTOR_KEYS = ["a", "b", "c", "d"];

type MapDef = {
  zones: { key: string; name: string; sectors?: { key: string }[] }[];
  adjacency?: Record<string, string[]>; // optional explicit adjacency override
};

// Ring adjacency: each zone is adjacent to the next and previous in the array.
// Same-zone moves are always valid.
function buildAdjacency(map: MapDef): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const zones = map.zones;
  const n = zones.length;
  for (let i = 0; i < n; i++) {
    const key = zones[i].key;
    if (!adj.has(key)) adj.set(key, new Set());
    adj.get(key)!.add(key); // same zone always adjacent to itself

    if (n > 1) {
      const prev = zones[(i - 1 + n) % n].key;
      const next = zones[(i + 1) % n].key;
      adj.get(key)!.add(prev);
      adj.get(key)!.add(next);
    }
  }

  // Apply explicit adjacency overrides from map_json if present
  if (map.adjacency) {
    for (const [zk, neighbours] of Object.entries(map.adjacency)) {
      if (!adj.has(zk)) adj.set(zk, new Set());
      for (const nb of neighbours) adj.get(zk)!.add(nb);
    }
  }

  return adj;
}

function isAdjacent(
  fromZone: string,
  toZone: string,
  adj: Map<string, Set<string>>
): boolean {
  return adj.get(fromZone)?.has(toZone) ?? false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorised" });
    const uid = result.user.id;

    const admin = adminClient();
    const body  = await req.json().catch(() => ({}));

    const {
      campaign_id,
      unit_id,
      to_zone_key,
      to_sector_key,
    } = body as {
      campaign_id:   string;
      unit_id:       string;
      to_zone_key:   string;
      to_sector_key: string;
    };

    if (!campaign_id || !unit_id || !to_zone_key || !to_sector_key) {
      return json(400, { ok: false, error: "Missing required fields: campaign_id, unit_id, to_zone_key, to_sector_key" });
    }

    // ── 1. Verify membership ─────────────────────────────────────────────────
    const { data: mem } = await admin
      .from("campaign_members").select("role")
      .eq("campaign_id", campaign_id).eq("user_id", uid).maybeSingle();
    if (!mem) return json(403, { ok: false, error: "Not a campaign member" });

    // ── 2. Load campaign + round ─────────────────────────────────────────────
    const { data: camp } = await admin
      .from("campaigns").select("round_number, map_id")
      .eq("id", campaign_id).single();
    if (!camp) return json(404, { ok: false, error: "Campaign not found" });

    const { data: round } = await admin
      .from("rounds").select("stage")
      .eq("campaign_id", campaign_id).eq("round_number", camp.round_number).maybeSingle();

    const stage = round?.stage ?? null;
    if (stage !== "movement" && stage !== "recon") {
      return json(400, {
        ok: false,
        error: `Movement orders can only be submitted during the movement or recon phase. Current stage: ${stage ?? "none"}.`,
      });
    }

    // ── 3. Load the unit ─────────────────────────────────────────────────────
    const { data: unit } = await admin
      .from("units").select("*")
      .eq("id", unit_id).eq("campaign_id", campaign_id).maybeSingle();

    if (!unit)               return json(404, { ok: false, error: "Unit not found" });
    if (unit.user_id !== uid) return json(403, { ok: false, error: "That unit does not belong to you" });
    if (unit.status !== "active") return json(400, { ok: false, error: `Unit is ${unit.status} and cannot move` });

    // ── 4. Recon phase: scout only, requires recon token ─────────────────────
    if (stage === "recon") {
      if (unit.unit_type !== "scout") {
        return json(400, { ok: false, error: "Only scout units can move during the recon phase" });
      }
      const { data: reconToken } = await admin
        .from("round_spends").select("id")
        .eq("campaign_id", campaign_id).eq("round_number", camp.round_number)
        .eq("user_id", uid).eq("spend_type", "recon").maybeSingle();
      if (!reconToken) {
        return json(403, { ok: false, error: "No recon token purchased this round. Buy one during the spend phase." });
      }
    }

    // ── 5. Check for deep strike token ───────────────────────────────────────
    const { data: dsToken } = await admin
      .from("round_spends").select("id")
      .eq("campaign_id", campaign_id).eq("round_number", camp.round_number)
      .eq("user_id", uid).eq("spend_type", "deep_strike").maybeSingle();
    const hasDeepStrike = !!dsToken;

    // ── 6. Load map for adjacency ────────────────────────────────────────────
    let mapDef: MapDef = { zones: [] };
    if (camp.map_id) {
      const { data: mapRow } = await admin
        .from("maps").select("map_json")
        .eq("id", camp.map_id).maybeSingle();
      if (mapRow?.map_json && (mapRow.map_json as any)?.zones?.length) {
        mapDef = mapRow.map_json as MapDef;
      }
    }
    // Fallback: treat from-zone and to-zone as always adjacent (single-zone campaign)
    const adj = buildAdjacency(mapDef);

    // ── 7. Adjacency check (skip if deep strike) ─────────────────────────────
    const moveType = hasDeepStrike ? "deep_strike" : (stage === "recon" ? "recon" : "normal");

    if (!hasDeepStrike) {
      const adjacent = isAdjacent(unit.zone_key, to_zone_key, adj);
      if (!adjacent) {
        return json(400, {
          ok: false,
          error: `${to_zone_key} is not adjacent to ${unit.zone_key}. Purchase a Deep Strike token to move anywhere.`,
        });
      }
    }

    // ── 8. Check what's at the destination ───────────────────────────────────
    const { data: destSector } = await admin
      .from("sectors").select("owner_user_id, fortified, revealed_public")
      .eq("campaign_id", campaign_id)
      .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key)
      .maybeSingle();

    const destOwner = destSector?.owner_user_id ?? null;
    const enemyHeld = destOwner !== null && destOwner !== uid;

    // Check if destination has an enemy occupation unit defending it
    const { data: defenderUnits } = await admin
      .from("units").select("id, unit_type, user_id")
      .eq("campaign_id", campaign_id)
      .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key)
      .eq("status", "active");

    const enemyOccupationPresent = (defenderUnits ?? []).some(
      (u: any) => u.user_id !== uid && u.unit_type === "occupation"
    );

    // Has this player's scout unit previously visited this sector?
    const { data: priorScout } = await admin
      .from("moves").select("id")
      .eq("campaign_id", campaign_id).eq("user_id", uid)
      .eq("to_zone_key", to_zone_key).eq("to_sector_key", to_sector_key)
      .limit(1);
    const hasScouted = (priorScout?.length ?? 0) > 0;

    let conflictId: string | null = null;
    let autoTransfer = false;
    let defensiveBonus = false;

    if (enemyHeld) {
      if (!enemyOccupationPresent) {
        // Enemy owns it but no occupation unit — auto-transfer ownership
        // (occupation unit is required to defend a territory)
        if (unit.unit_type === "occupation") {
          autoTransfer = true;
          await admin.from("sectors").update({ owner_user_id: uid })
            .eq("campaign_id", campaign_id)
            .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key);
        }
        // Scout moving into undefended enemy territory: record intel, flag as visible
        if (unit.unit_type === "scout") {
          await admin.from("sectors").update({ revealed_public: true })
            .eq("campaign_id", campaign_id)
            .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key);
        }
      } else {
        // Enemy has an occupation unit present — this is a conflict
        // Deep strike into unscouted territory gives defender a bonus
        defensiveBonus = hasDeepStrike && !hasScouted;

        const { data: conflict, error: cErr } = await admin
          .from("conflicts").insert({
            campaign_id,
            round_number:      camp.round_number,
            attacker_user_id:  uid,
            defender_user_id:  destOwner,
            zone_key:          to_zone_key,
            sector_key:        to_sector_key,
            status:            "pending",
            metadata: {
              unit_type:       unit.unit_type,
              move_type:       moveType,
              defensive_bonus: defensiveBonus,
            },
          }).select("id").single();

        if (!cErr && conflict) conflictId = conflict.id;
      }
    } else if (!destOwner && unit.unit_type === "scout") {
      // Scout moving into unclaimed territory: reveal it
      await admin.from("sectors")
        .upsert({
          campaign_id,
          zone_key:       to_zone_key,
          sector_key:     to_sector_key,
          owner_user_id:  null,
          revealed_public: true,
          fortified:      false,
        }, { onConflict: "campaign_id,zone_key,sector_key" });
    }

    // ── 9. Upsert move record (one move per unit per round) ───────────────────
    const { data: existingMove } = await admin
      .from("moves").select("id")
      .eq("campaign_id", campaign_id).eq("round_number", camp.round_number)
      .eq("user_id", uid).eq("unit_id", unit_id).maybeSingle();

    if (existingMove) {
      await admin.from("moves").update({
        from_zone_key:   unit.zone_key,
        from_sector_key: unit.sector_key,
        to_zone_key,
        to_sector_key,
        move_type:       moveType,
        spend_json:      { deep_strike: hasDeepStrike, defensive_bonus: defensiveBonus },
        submitted_at:    new Date().toISOString(),
      }).eq("id", existingMove.id);
    } else {
      await admin.from("moves").insert({
        campaign_id,
        round_number:    camp.round_number,
        user_id:         uid,
        unit_id,
        from_zone_key:   unit.zone_key,
        from_sector_key: unit.sector_key,
        to_zone_key,
        to_sector_key,
        move_type:       moveType,
        spend_json:      { deep_strike: hasDeepStrike, defensive_bonus: defensiveBonus },
      });
    }

    // ── 10. Update unit position ──────────────────────────────────────────────
    await admin.from("units").update({
      zone_key:   to_zone_key,
      sector_key: to_sector_key,
    }).eq("id", unit_id);

    // ── 11. Update player_state public location (occupation unit only) ────────
    if (unit.unit_type === "occupation") {
      await admin.from("player_state").update({
        current_zone_key:   to_zone_key,
        current_sector_key: to_sector_key,
      }).eq("campaign_id", campaign_id).eq("user_id", uid);
    }

    return json(200, {
      ok:              true,
      move_type:       moveType,
      auto_transfer:   autoTransfer,
      conflict_id:     conflictId,
      defensive_bonus: defensiveBonus,
    });

  } catch (e: any) {
    console.error("[submit-move] error:", e?.message ?? String(e));
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
