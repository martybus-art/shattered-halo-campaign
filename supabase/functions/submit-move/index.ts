// supabase/functions/submit-move/index.ts
// Validates and records a unit movement order.
//
// Rules enforced:
//   - Movement phase: any unit (scout or occupation), 1 step adjacency.
//   - Recon phase: scout units only, requires recon token purchased this round.
//   - Deep strike: any unit can move anywhere on the map if the player has a
//     deep_strike token this round. Occupation deep-striking into an unscouted
//     sector records a defensive_bonus flag on the resulting conflict.
//   - Occupation into undefended enemy sector: ownership auto-transferred.
//   - Scout or occupation into defended enemy sector: conflict record inserted.
//   - One move per unit per round (can update before phase ends).
//
// Reveal rules (when revealed_public becomes true):
//   - Scout enters any unclaimed sector: sector upserted with revealed_public=true.
//   - Scout enters undefended enemy sector: revealed_public=true set.
//   - Any unit triggers a conflict (enemy occupation present): both
//     attacker and defender can now see each other -- revealed_public=true.
//   - Occupation captures undefended enemy sector: revealed_public=true
//     so the ex-owner (and anyone who has previously scouted it) can see
//     the ownership change.
//
// changelog:
//   2026-03-15 -- FIX: Two-layer sector adjacency enforced server-side (step 7).
//                 isCrossZoneSectorValid corrected for all four layout types:
//                 Ring: CW col1->col0, CCW col0->col1.
//                 Spoke: hub<->outer row1 (c/d face hub); outer ring uses col CW/CCW.
//                 Void_ship: within corridor row-based (forward=row1->row0,
//                   backward=row0->row1); bridge col-based (port->stbd col1->col0).
//                 Continent: within cluster mini-ring col CW/CCW;
//                   between-cluster bridge col (increasing=col1->col0).
//                 SECTOR_COL/SECTOR_ROW + isValidSectorMove mirror frontend exactly.
//   2026-03-15 -- BUG FIX: moves unique constraint was UNIQUE(campaign_id,
//                 round_number, user_id) -- one row per player per round. With 2
//                 units the second insert silently failed (no error check), but
//                 execution continued to step 10 so the unit position still moved
//                 with no move record. Schema migration applied:
//                 UNIQUE(campaign_id, round_number, user_id, unit_id).
//   2026-03-15 -- BUG FIX: Added explicit error throws on move INSERT and UPDATE
//                 (step 9). A DB error now returns 500 immediately instead of
//                 silently allowing unit position update to proceed.
//   2026-03-15 -- FIX: War Bulletin posts now deduplicate per unit per round
//                 (step 9b). Tags include "unit:{unit_id}" so existing posts are
//                 found and updated on move edits rather than accumulating
//                 duplicate entries.
//   2026-03-12 -- Added movement log post (private, tag:"movement") inserted
//                 after every successful move upsert. Visible only to the moving
//                 player in their War Bulletin. Includes conflict/capture notes.
//   2026-03-08 -- BUG FIX: conflicts insert now uses player_a / player_b
//                 (correct column names). Previously used attacker_user_id /
//                 defender_user_id / metadata which don't exist -- conflicts
//                 were never created.
//   2026-03-08 -- BUG FIX: buildAdjacency now reads the layout field from
//                 the maps table and applies the correct topology. Previously
//                 hardcoded to ring regardless of campaign layout type, so
//                 adjacency was wrong for spoke / continent / void_ship.
//   2026-03-08 -- BUG FIX (privacy): revealed_public=true now set on conflict
//                 creation (both players know about each other) and on
//                 occupation auto-capture (ex-owner sees ownership change).
//   2026-03-05 -- Initial implementation.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

type MapDef = {
  zones: { key: string; name: string; sectors?: { key: string }[] }[];
  adjacency?: Record<string, string[]>; // optional explicit adjacency override
};

// Builds the same adjacency topology as the frontend buildAdjacency function.
// layout values:
//   "ring"      -- each zone -> prev + next, wrapping (Halo Ring)
//   "spoke"     -- zones[0] = hub -> every outer; outer also ring among themselves
//   "void_ship" -- 2 parallel corridors bridged at bow and stern
//   "continent" -- clusters of ~3 internally ring-connected, bridged per cluster
function buildAdjacency(map: MapDef, layout: string): Map<string, Set<string>> {
  const adj   = new Map<string, Set<string>>();
  const zones = map.zones;
  const n     = zones.length;

  for (const z of zones) {
    adj.set(z.key, new Set([z.key])); // self-adjacency always valid
  }
  if (n <= 1) return adj;

  const link = (a: string, b: string) => {
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  switch (layout) {

    case "spoke": {
      const hub = zones[0].key;
      for (let i = 1; i < n; i++) {
        link(hub, zones[i].key);
        link(zones[i].key, zones[i === 1 ? n - 1 : i - 1].key);
      }
      break;
    }

    case "void_ship": {
      const perCol = Math.ceil(n / 2);
      for (let i = 0; i < perCol - 1; i++) link(zones[i].key, zones[i + 1].key);
      for (let i = perCol; i < n - 1; i++) link(zones[i].key, zones[i + 1].key);
      if (n > perCol) link(zones[0].key, zones[perCol].key);
      if (perCol > 1 && n > perCol) link(zones[perCol - 1].key, zones[n - 1].key);
      break;
    }

    case "continent": {
      const cs = Math.max(2, Math.round(n / Math.ceil(n / 3)));
      const nc = Math.ceil(n / cs);
      for (let c = 0; c < nc; c++) {
        const s  = c * cs;
        const e  = Math.min(s + cs, n);
        const cl = zones.slice(s, e);
        for (let i = 0; i < cl.length; i++) link(cl[i].key, cl[(i + 1) % cl.length].key);
        if (c < nc - 1) link(cl[cl.length - 1].key, zones[e].key);
      }
      break;
    }

    case "ring":
    default: {
      for (let i = 0; i < n; i++) link(zones[i].key, zones[(i + 1) % n].key);
      break;
    }
  }

  // Apply explicit adjacency overrides from map_json if present
  if (map.adjacency) {
    for (const [zk, neighbours] of Object.entries(map.adjacency)) {
      if (!adj.has(zk)) adj.set(zk, new Set([zk]));
      for (const nb of neighbours) adj.get(zk)!.add(nb);
    }
  }

  return adj;
}

// Sector grid geometry (2x2 per zone):
//   a(col0,row0) | b(col1,row0)
//   c(col0,row1) | d(col1,row1)
const SECTOR_COL: Record<string, number> = { a: 0, b: 1, c: 0, d: 1 };
const SECTOR_ROW: Record<string, number> = { a: 0, b: 0, c: 1, d: 1 };

// Returns true when moving ACROSS a zone boundary is valid at the sector level.
// Ring:      clockwise (i -> i+1): fromSector col1, toSector col0.
//            counter-cw (i -> i-1): fromSector col0, toSector col1.
// Spoke:     hub <-> outer: outer sector must be in row1 (c or d face hub).
//            outer-to-outer: ring rule on the outer zones.
// void_ship / continent: index ordering determines col direction.
function isCrossZoneSectorValid(
  fromZone: string, fromSector: string,
  toZone:   string, toSector:   string,
  zones:    MapDef["zones"],
  layout:   string,
): boolean {
  const n       = zones.length;
  const fromIdx = zones.findIndex((z) => z.key === fromZone);
  const toIdx   = zones.findIndex((z) => z.key === toZone);
  if (fromIdx < 0 || toIdx < 0) return false;

  switch (layout) {

    // Ring: CW (i->i+1) fromCol1->toCol0; CCW (i->i-1) fromCol0->toCol1.
    case "ring": {
      const isCW  = (fromIdx + 1) % n === toIdx;
      const isCCW = (toIdx   + 1) % n === fromIdx;
      if (isCW)  return SECTOR_COL[fromSector] === 1 && SECTOR_COL[toSector] === 0;
      if (isCCW) return SECTOR_COL[fromSector] === 0 && SECTOR_COL[toSector] === 1;
      return false;
    }

    // Spoke: hub<->outer uses row1 of outer zone (c/d face the hub).
    // Outer-to-outer ring portion uses CW/CCW col rule.
    case "spoke": {
      const isFromHub = fromIdx === 0;
      const isToHub   = toIdx   === 0;
      if (isFromHub || isToHub) {
        const outerSector = isFromHub ? toSector : fromSector;
        return SECTOR_ROW[outerSector] === 1;
      }
      const outerZones = zones.slice(1);
      const fOIdx = outerZones.findIndex((z) => z.key === fromZone);
      const tOIdx = outerZones.findIndex((z) => z.key === toZone);
      const nO    = outerZones.length;
      const isCW  = (fOIdx + 1) % nO === tOIdx;
      const isCCW = (tOIdx + 1) % nO === fOIdx;
      if (isCW)  return SECTOR_COL[fromSector] === 1 && SECTOR_COL[toSector] === 0;
      if (isCCW) return SECTOR_COL[fromSector] === 0 && SECTOR_COL[toSector] === 1;
      return false;
    }

    // Void ship: port (zones[0..perCol-1]) and starboard (zones[perCol..n-1])
    // are vertical corridors. Within a corridor (horizontal boundary) = row-based.
    // Cross-corridor bridge (vertical boundary) = col-based.
    // Forward (lower->higher index within corridor): fromRow1->toRow0.
    // Backward (higher->lower index within corridor): fromRow0->toRow1.
    // Port->Starboard bridge: fromCol1->toCol0. Starboard->Port: fromCol0->toCol1.
    case "void_ship": {
      const perCol     = Math.ceil(n / 2);
      const fromInPort = fromIdx < perCol;
      const toInPort   = toIdx   < perCol;
      if (fromInPort === toInPort) {
        // Same corridor -- horizontal shared boundary (row-based)
        if (fromIdx < toIdx) return SECTOR_ROW[fromSector] === 1 && SECTOR_ROW[toSector] === 0;
        if (fromIdx > toIdx) return SECTOR_ROW[fromSector] === 0 && SECTOR_ROW[toSector] === 1;
        return false;
      }
      // Cross-corridor bridge -- vertical shared boundary (col-based)
      if (fromInPort) return SECTOR_COL[fromSector] === 1 && SECTOR_COL[toSector] === 0;
      return SECTOR_COL[fromSector] === 0 && SECTOR_COL[toSector] === 1;
    }

    // Continent: clusters of ~cs zones each, internally ring-connected.
    // Within a cluster (mini-ring): CW/CCW col rule same as ring.
    // Between clusters (bridge): increasing cluster index -> col1->col0.
    case "continent": {
      const cs          = Math.max(2, Math.round(n / Math.ceil(n / 3)));
      const fromCluster = Math.floor(fromIdx / cs);
      const toCluster   = Math.floor(toIdx   / cs);
      const fromPos     = fromIdx % cs;
      const toPos       = toIdx   % cs;
      if (fromCluster === toCluster) {
        const clusterSize = Math.min(cs, n - fromCluster * cs);
        const isCW  = (fromPos + 1) % clusterSize === toPos;
        const isCCW = (toPos   + 1) % clusterSize === fromPos;
        if (isCW)  return SECTOR_COL[fromSector] === 1 && SECTOR_COL[toSector] === 0;
        if (isCCW) return SECTOR_COL[fromSector] === 0 && SECTOR_COL[toSector] === 1;
        return false;
      }
      if (fromCluster < toCluster) return SECTOR_COL[fromSector] === 1 && SECTOR_COL[toSector] === 0;
      return SECTOR_COL[fromSector] === 0 && SECTOR_COL[toSector] === 1;
    }

    default:
      return false;
  }
}

// Two-layer move validator — mirrors frontend isValidSectorMove.
//   Layer 1: zone adjacency (adj map).
//   Layer 2: sector boundary facing (isCrossZoneSectorValid).
// Same-zone moves: orthogonal only (no diagonals).
// Hold position (same zone + same sector): always valid.
// Deep strike: bypasses all checks.
function isValidSectorMove(
  fromZone:      string,
  fromSector:    string,
  toZone:        string,
  toSector:      string,
  zones:         MapDef["zones"],
  layout:        string,
  adj:           Map<string, Set<string>>,
  hasDeepStrike: boolean,
): boolean {
  if (hasDeepStrike) return true;
  if (fromZone === toZone && fromSector === toSector) return true; // hold
  if (fromZone === toZone) {
    const colDiff = Math.abs(SECTOR_COL[fromSector] - SECTOR_COL[toSector]);
    const rowDiff = Math.abs(SECTOR_ROW[fromSector] - SECTOR_ROW[toSector]);
    return (colDiff + rowDiff) === 1; // orthogonal only
  }
  if (!adj.get(fromZone)?.has(toZone)) return false;
  return isCrossZoneSectorValid(fromZone, fromSector, toZone, toSector, zones, layout);
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

    const { campaign_id, unit_id, to_zone_key, to_sector_key } = body as {
      campaign_id:   string;
      unit_id:       string;
      to_zone_key:   string;
      to_sector_key: string;
    };

    if (!campaign_id || !unit_id || !to_zone_key || !to_sector_key) {
      return json(400, { ok: false, error: "Missing required fields: campaign_id, unit_id, to_zone_key, to_sector_key" });
    }

    // 1. Verify membership
    const { data: mem } = await admin
      .from("campaign_members").select("role")
      .eq("campaign_id", campaign_id).eq("user_id", uid).maybeSingle();
    if (!mem) return json(403, { ok: false, error: "Not a campaign member" });

    // 2. Load campaign + round
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

    // 3. Load the unit
    const { data: unit } = await admin
      .from("units").select("*")
      .eq("id", unit_id).eq("campaign_id", campaign_id).maybeSingle();

    if (!unit)                return json(404, { ok: false, error: "Unit not found" });
    if (unit.user_id !== uid) return json(403, { ok: false, error: "That unit does not belong to you" });
    if (unit.status !== "active") return json(400, { ok: false, error: `Unit is ${unit.status} and cannot move` });

    // 4. Recon phase: scout only, requires recon token
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

    // 5. Check for deep strike token
    const { data: dsToken } = await admin
      .from("round_spends").select("id")
      .eq("campaign_id", campaign_id).eq("round_number", camp.round_number)
      .eq("user_id", uid).eq("spend_type", "deep_strike").maybeSingle();
    const hasDeepStrike = !!dsToken;

    // 6. Load map for adjacency
    let mapDef: MapDef = { zones: [] };
    let mapLayout      = "ring";
    if (camp.map_id) {
      const { data: mapRow } = await admin
        .from("maps").select("map_json, layout")
        .eq("id", camp.map_id).maybeSingle();
      if (mapRow?.map_json && (mapRow.map_json as any)?.zones?.length) {
        mapDef    = mapRow.map_json as MapDef;
        mapLayout = (mapRow.layout as string | null) ?? "ring";
      }
    }
    const adj = buildAdjacency(mapDef, mapLayout);

    // 7. Two-layer adjacency check (zone + sector boundary).
    // Layer 1: zone adjacency. Layer 2: sectors must face the boundary.
    // Deep strike bypasses both. isValidSectorMove mirrors frontend logic.
    const moveType = hasDeepStrike ? "deep_strike" : (stage === "recon" ? "recon" : "normal");

    if (!isValidSectorMove(
      unit.zone_key, unit.sector_key,
      to_zone_key,   to_sector_key,
      mapDef.zones,  mapLayout, adj, hasDeepStrike,
    )) {
      const crossZone = unit.zone_key !== to_zone_key;
      return json(400, {
        ok: false,
        error: crossZone
          ? `Cannot move to ${to_zone_key} / ${to_sector_key} -- sectors are not on the adjacent boundary. Only sectors that face your unit's current position are reachable. Purchase a Deep Strike token to move anywhere.`
          : `Cannot move to sector ${to_sector_key} from ${unit.sector_key} -- sectors are not orthogonally adjacent within the zone.`,
      });
    }

    // 8. Check destination sector
    const { data: destSector } = await admin
      .from("sectors").select("owner_user_id, fortified, revealed_public")
      .eq("campaign_id", campaign_id)
      .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key)
      .maybeSingle();

    const destOwner = destSector?.owner_user_id ?? null;
    const enemyHeld = destOwner !== null && destOwner !== uid;

    const { data: defenderUnits } = await admin
      .from("units").select("id, unit_type, user_id")
      .eq("campaign_id", campaign_id)
      .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key)
      .eq("status", "active");

    const enemyOccupationPresent = (defenderUnits ?? []).some(
      (u: any) => u.user_id !== uid && u.unit_type === "occupation"
    );

    const { data: priorScout } = await admin
      .from("moves").select("id")
      .eq("campaign_id", campaign_id).eq("user_id", uid)
      .eq("to_zone_key", to_zone_key).eq("to_sector_key", to_sector_key)
      .limit(1);
    const hasScouted = (priorScout?.length ?? 0) > 0;

    let conflictId: string | null = null;
    let autoTransfer  = false;
    let defensiveBonus = false;

    if (enemyHeld) {
      if (!enemyOccupationPresent) {
        if (unit.unit_type === "occupation") {
          autoTransfer = true;
          await admin.from("sectors")
            .update({ owner_user_id: uid, revealed_public: true })
            .eq("campaign_id", campaign_id)
            .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key);
        }
        if (unit.unit_type === "scout") {
          await admin.from("sectors")
            .update({ revealed_public: true })
            .eq("campaign_id", campaign_id)
            .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key);
        }
      } else {
        defensiveBonus = hasDeepStrike && !hasScouted;

        await admin.from("sectors")
          .update({ revealed_public: true })
          .eq("campaign_id", campaign_id)
          .eq("zone_key", to_zone_key).eq("sector_key", to_sector_key);

        const { data: conflict, error: cErr } = await admin
          .from("conflicts").insert({
            campaign_id,
            round_number:    camp.round_number,
            player_a:        uid,
            player_b:        destOwner,
            zone_key:        to_zone_key,
            sector_key:      to_sector_key,
            status:          "pending",
            twist_tags:      defensiveBonus ? ["defensive_bonus"] : [],
          }).select("id").single();

        if (cErr) {
          console.error("[submit-move] conflict insert error:", cErr.message);
        } else if (conflict) {
          conflictId = conflict.id;
        }
      }
    } else if (!destOwner && unit.unit_type === "scout") {
      await admin.from("sectors").upsert(
        {
          campaign_id,
          zone_key:        to_zone_key,
          sector_key:      to_sector_key,
          owner_user_id:   null,
          revealed_public: true,
          fortified:       false,
        },
        { onConflict: "campaign_id,zone_key,sector_key" }
      );
    }

    // 9. Upsert move record (one per unit per round).
    // Error check is mandatory -- a silent failure here previously let execution
    // continue to step 10, moving the unit with no move record in the DB.
    const { data: existingMove } = await admin
      .from("moves").select("id")
      .eq("campaign_id", campaign_id).eq("round_number", camp.round_number)
      .eq("user_id", uid).eq("unit_id", unit_id).maybeSingle();

    if (existingMove) {
      const { error: moveUpdErr } = await admin.from("moves").update({
        from_zone_key:   unit.zone_key,
        from_sector_key: unit.sector_key,
        to_zone_key,
        to_sector_key,
        move_type:       moveType,
        spend_json:      { deep_strike: hasDeepStrike, defensive_bonus: defensiveBonus },
        submitted_at:    new Date().toISOString(),
      }).eq("id", existingMove.id);
      if (moveUpdErr) throw new Error(`Failed to update move record: ${moveUpdErr.message}`);
    } else {
      const { error: moveInsErr } = await admin.from("moves").insert({
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
      if (moveInsErr) throw new Error(`Failed to insert move record: ${moveInsErr.message}`);
    }

    // 9b. War Bulletin -- upsert movement post (one per unit per round).
    // Tags include "unit:{unit_id}" so we can find + update on move edits
    // instead of inserting a new post every time the player changes their mind.
    const fmtZone = (k: string) =>
      k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const moveLabel     = moveType === "deep_strike" ? "Deep Strike"
                        : moveType === "recon"       ? "Recon"
                        : "Normal move";
    const unitLabel     = unit.unit_type === "scout" ? "Scout" : "Occupation";
    const moveSuffix    = (conflictId   ? " -- Conflict initiated!" : "")
                        + (autoTransfer ? " -- Territory captured!" : "");
    const bulletinBody  = `${unitLabel} unit: ${fmtZone(unit.zone_key)} / ${unit.sector_key.toUpperCase()} -> ${fmtZone(to_zone_key)} / ${to_sector_key.toUpperCase()} [${moveLabel}]${moveSuffix}`;
    const bulletinTitle = `Movement Order -- Round ${camp.round_number}`;
    const bulletinTags  = ["movement", `unit:${unit_id}`];

    const { data: existingPost } = await admin
      .from("posts").select("id")
      .eq("campaign_id",      campaign_id)
      .eq("round_number",     camp.round_number)
      .eq("audience_user_id", uid)
      .contains("tags",       [`unit:${unit_id}`])
      .maybeSingle();

    if (existingPost) {
      await admin.from("posts")
        .update({ title: bulletinTitle, body: bulletinBody, tags: bulletinTags })
        .eq("id", existingPost.id);
    } else {
      await admin.from("posts").insert({
        campaign_id,
        round_number:     camp.round_number,
        visibility:       "private",
        audience_user_id: uid,
        created_by:       uid,
        title:            bulletinTitle,
        body:             bulletinBody,
        tags:             bulletinTags,
      });
    }

    // 10. Update unit position
    await admin.from("units")
      .update({ zone_key: to_zone_key, sector_key: to_sector_key })
      .eq("id", unit_id);

    // 11. Update player_state public location (occupation unit only)
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
