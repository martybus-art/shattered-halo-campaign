// supabase/functions/start-campaign/index.ts
// Allocates secret starting locations for all players, creates their
// initial scout and occupation units, seeds the sectors table, and
// randomly assigns unique zone effects to every zone on the campaign map.
//
// changelog:
//   2026-03-15 -- Added assignZoneEffects(): after player allocation completes,
//                 randomly assigns a unique zone_effect from the zone_effects
//                 reference table to every zone defined in the campaign map_json.
//                 Reads zone keys and names directly from map_json.zones so
//                 there is no separate zone table needed. Idempotent — skips
//                 zones that already have an effect assigned. Uses adminClient()
//                 for all writes (bypasses RLS). Late mode does NOT re-run
//                 assignZoneEffects() since effects are assigned at initial start.
//   2026-03-15 — REFACTOR: Removed local fallbackMap(). map_json is now
//                guaranteed populated by create-campaign via buildMapTemplate().
//                start-campaign reads map_json as before; if map_json is still
//                empty on a legacy campaign, it calls buildMapTemplate() as a
//                safety net and backfills map_json into the DB so future calls
//                (and generate-map) work correctly.
//   2026-03-11 -- FIX: createInitialSectors sets revealed_public=false for ALL
//                 sectors including the owner's starting sector. The owner sees
//                 their own via owner_user_id===currentUserId on the frontend;
//                 revealed_public=true means visible to OTHER players, which was
//                 leaking every player's starting location through fog of war.
//   2026-03-08 -- Added createInitialSectors(): at campaign start, all sectors
//                 in each player's starting zone are inserted into the sectors
//                 table. The player's own starting sector is marked as owned
//                 (revealed_public=false); the remaining sectors are seeded as
//                 open (owner=null, revealed_public=false).
//                 Upsert uses ignoreDuplicates so it is safe if two players
//                 share a zone, and safe to re-run (idempotent).
//   2026-03-07 -- FIX: After creating rounds row, now also updates
//                 campaigns.round_number = 1 so the frontend query
//                 (rounds WHERE round_number = campaign.round_number) finds it.
//   2026-03-05 -- Added unit creation: after each player's starting location
//                 is allocated, insert 1 scout + 1 occupation unit at that sector.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";
import { buildMapTemplate } from "../_shared/mapTemplates.ts";

type Body =
  | { campaign_id: string; mode?: "initial" }
  | { campaign_id: string; mode: "late"; late_user_id: string };

type MapDef = {
  zones: { key: string; name: string; sectors: { key: string; name?: string }[] }[];
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseLocation(loc: string) {
  const [zone_key, sector_key] = loc.split(":");
  return { zone_key, sector_key };
}

const STARTING_NIP = 1;

// ---------------------------------------------------------------------------
// assignZoneEffects
// ---------------------------------------------------------------------------
// Randomly assigns a unique zone_effect to each zone in the campaign's map.
// Sources zone keys and names directly from map_json — no separate zone table.
// Idempotent: zones that already have an effect assigned are skipped.
// Called once at initial start; never called for late mode (effects persist).
// ---------------------------------------------------------------------------
async function assignZoneEffects(
  admin: ReturnType<typeof adminClient>,
  campaign_id: string,
  mapDef: MapDef
): Promise<void> {
  // 1. Check which zones already have effects (idempotency guard)
  const { data: existing, error: existErr } = await admin
    .from("campaign_zone_effects")
    .select("zone_key, zone_effect_id")
    .eq("campaign_id", campaign_id);

  if (existErr) {
    console.error("[start-campaign] assignZoneEffects: existing check error:", existErr.message);
    return;
  }

  const assignedZoneKeys    = new Set((existing ?? []).map((r: any) => r.zone_key as string));
  const usedEffectIds       = new Set((existing ?? []).map((r: any) => r.zone_effect_id as string));
  const zonesNeedingEffects = mapDef.zones.filter((z) => !assignedZoneKeys.has(z.key));

  if (!zonesNeedingEffects.length) {
    console.log("[start-campaign] assignZoneEffects: all zones already assigned, skipping.");
    return;
  }

  // 2. Load active zone effects from the reference table
  const { data: effects, error: effectErr } = await admin
    .from("zone_effects")
    .select("id, slug, scope")
    .eq("is_active", true);

  if (effectErr || !effects?.length) {
    console.error("[start-campaign] assignZoneEffects: could not load zone_effects:", effectErr?.message ?? "empty");
    return;
  }

  // 3. Build pool: prefer effects not yet used in this campaign; wrap if exhausted
  const preferredPool = shuffle((effects as any[]).filter((e) => !usedEffectIds.has(e.id as string)));
  const fallbackPool  = shuffle(effects as any[]);
  let   pool          = [...preferredPool];

  // 4. Build rows for each zone needing an assignment
  const rows: {
    campaign_id:           string;
    zone_key:              string;
    zone_name:             string;
    zone_effect_id:        string;
    global_uses_remaining: number | null;
  }[] = [];

  for (const zone of zonesNeedingEffects) {
    if (!pool.length) {
      // Exhausted unique effects — refill from full pool (duplicates allowed as fallback)
      pool = shuffle([...fallbackPool]);
    }
    const effect = pool.shift()!;

    rows.push({
      campaign_id,
      zone_key:              zone.key,
      zone_name:             zone.name ?? zone.key,
      zone_effect_id:        effect.id,
      // one_time scope effects start with 1 global use; others are unlimited (null)
      global_uses_remaining: (effect.scope as string) === "one_time" ? 1 : null,
    });

    // Mark as used so subsequent zones in this same batch prefer different effects
    usedEffectIds.add(effect.id as string);
    pool = pool.filter((e) => e.id !== effect.id);
  }

  if (!rows.length) return;

  const { error: insertErr } = await admin
    .from("campaign_zone_effects")
    .upsert(rows, { onConflict: "campaign_id,zone_key", ignoreDuplicates: true });

  if (insertErr) {
    console.error("[start-campaign] assignZoneEffects: upsert error:", insertErr.message);
  } else {
    console.log(`[start-campaign] assignZoneEffects: assigned ${rows.length} zone effect(s).`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const admin = adminClient();

    const body         = (await req.json().catch(() => ({}))) as Partial<Body>;
    const campaign_id  = (body as any)?.campaign_id as string | undefined;
    const mode         = ((body as any)?.mode ?? "initial") as "initial" | "late";
    const late_user_id = (body as any)?.late_user_id as string | undefined;

    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });
    if (mode === "late" && !late_user_id)
      return json(400, { ok: false, error: "Missing late_user_id" });

    const { data: leadRow, error: leadErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (leadErr) return json(500, { ok: false, error: leadErr.message });
    if (!leadRow || leadRow.role !== "lead") return json(403, { ok: false, error: "Lead only" });

    // Load map_json from the maps table.
    // create-campaign now seeds map_json with buildMapTemplate() so this should
    // always resolve. The safety net below handles legacy campaigns.
    const { data: camp, error: campErr } = await admin
      .from("campaigns")
      .select("id, map_id, round_number")
      .eq("id", campaign_id)
      .maybeSingle();

    if (campErr) return json(500, { ok: false, error: campErr.message });

    const roundNumber = (camp as any)?.round_number;

    let map: MapDef | null = null;

    if (camp?.map_id) {
      const { data: mapRow, error: mapErr } = await admin
        .from("maps")
        .select("map_json, layout, zone_count")
        .eq("id", camp.map_id)
        .maybeSingle();

      if (!mapErr && mapRow?.map_json) {
        try {
          const mj = mapRow.map_json as any;
          if (mj?.zones?.length) map = mj as MapDef;
        } catch { /* fall through */ }
      }

      // Safety net for legacy campaigns: backfill map_json from template
      if (!map && mapRow) {
        const layout     = (mapRow as any)?.layout     as string ?? "ring";
        const zone_count = (mapRow as any)?.zone_count as number ?? 8;
        map = buildMapTemplate(layout, zone_count) as MapDef;

        // Backfill so generate-map and future start-campaign calls work correctly
        await admin
          .from("maps")
          .update({ map_json: map })
          .eq("id", camp.map_id);

        console.log(`[start-campaign] backfilled map_json for map ${camp.map_id} (legacy campaign)`);
      }
    }

    // Final fallback when there is no map_id at all
    if (!map) {
      map = buildMapTemplate("ring", 8) as MapDef;
    }

    const { data: members, error: memErr } = await admin
      .from("campaign_members")
      .select("user_id")
      .eq("campaign_id", campaign_id);

    if (memErr) return json(500, { ok: false, error: memErr.message });
    const memberIds = (members ?? []).map((m: any) => m.user_id as string);

    const { data: secrets, error: secErr } = await admin
      .from("player_state_secret")
      .select("user_id, starting_location, secret_location")
      .eq("campaign_id", campaign_id);

    if (secErr) return json(500, { ok: false, error: secErr.message });

    const assignedByUser = new Map<string, string>();
    const usedZones      = new Set<string>();
    const usedSectors    = new Set<string>();
    for (const s of secrets ?? []) {
      const loc = (s.secret_location ?? s.starting_location) as string | null;
      if (s.user_id && loc) {
        assignedByUser.set(s.user_id, loc);
        usedSectors.add(loc);
        const { zone_key } = parseLocation(loc);
        if (zone_key) usedZones.add(zone_key);
      }
    }

    const allLocations: string[] = [];
    for (const z of map!.zones)
      for (const sec of z.sectors) allLocations.push(sec.key);

    function pickFreeSectorInZone(zoneKey: string): string | null {
      const z = map!.zones.find((z) => z.key === zoneKey);
      if (!z) return null;
      const free = z.sectors.map((s) => s.key).filter((k) => !usedSectors.has(k));
      return free.length ? shuffle(free)[0]! : null;
    }

    function pickUnusedZone(): string | null {
      const candidates = map!.zones
        .map((z) => z.key)
        .filter((zk) => !usedZones.has(zk))
        .filter((zk) => pickFreeSectorInZone(zk) !== null);
      return candidates.length ? shuffle(candidates)[0]! : null;
    }

    async function ensurePublicPlayerState(uid: string) {
      const { error } = await admin.from("player_state").upsert(
        {
          campaign_id,
          user_id:            uid,
          nip:                STARTING_NIP,
          ncp:                0,
          public_location:    "Unknown",
          current_zone_key:   "unknown",
          current_sector_key: "unknown",
        },
        { onConflict: "campaign_id,user_id", ignoreDuplicates: true }
      );
      if (error) throw new Error(error.message);
    }

    async function writeSecret(uid: string, loc: string) {
      const { error } = await admin.from("player_state_secret").upsert(
        { campaign_id, user_id: uid, starting_location: loc, secret_location: loc },
        { onConflict: "campaign_id,user_id" }
      );
      if (error) throw new Error(error.message);
    }

    async function createInitialSectors(uid: string, loc: string, mapDef: MapDef) {
      const { zone_key, sector_key } = parseLocation(loc);
      if (!zone_key || !sector_key) return;

      const z = mapDef.zones.find((z) => z.key === zone_key);

      if (!z) {
        const { error } = await admin.from("sectors").upsert(
          { campaign_id, zone_key, sector_key, owner_user_id: uid, revealed_public: false },
          { onConflict: "campaign_id,zone_key,sector_key", ignoreDuplicates: true }
        );
        if (error) console.error(`[start-campaign] single sector insert error:`, error.message);
        return;
      }

      const rows = z.sectors.map((sec) => {
        const sk      = sec.key.includes(":") ? sec.key.split(":").pop()! : sec.key;
        const isOwned = sk === sector_key;
        return {
          campaign_id,
          zone_key,
          sector_key:      sk,
          owner_user_id:   isOwned ? uid : null as string | null,
          revealed_public: false,
        };
      });

      const { error } = await admin.from("sectors").upsert(rows, {
        onConflict: "campaign_id,zone_key,sector_key",
        ignoreDuplicates: true,
      });
      if (error) console.error(`[start-campaign] sector insert error for ${uid}:`, error.message);
    }

    async function createInitialUnits(uid: string, loc: string, roundNum: number) {
      const { zone_key, sector_key } = parseLocation(loc);
      if (!zone_key || !sector_key) return;

      const { data: existing } = await admin
        .from("units")
        .select("id")
        .eq("campaign_id", campaign_id)
        .eq("user_id", uid)
        .eq("status", "active")
        .limit(1);

      if (existing?.length) return;

      const { error } = await admin.from("units").insert([
        {
          campaign_id,
          user_id:        uid,
          unit_type:      "scout",
          zone_key,
          sector_key,
          status:         "active",
          round_deployed: roundNum,
        },
        {
          campaign_id,
          user_id:        uid,
          unit_type:      "occupation",
          zone_key,
          sector_key,
          status:         "active",
          round_deployed: roundNum,
        },
      ]);
      if (error) console.error(`[start-campaign] unit insert error for ${uid}:`, error.message);
    }

    // ── Late mode ─────────────────────────────────────────────────────────────
    // Zone effects are NOT reassigned in late mode — they were set at initial
    // start and late-joining players enter a campaign where effects are already
    // in place (hidden or revealed depending on existing player progress).

    if (mode === "late") {
      const uid = late_user_id!;
      if (!memberIds.includes(uid))
        return json(400, { ok: false, error: "late_user_id is not a member of this campaign" });
      if (assignedByUser.has(uid))
        return json(200, { ok: true, allocated: 0, note: "Player already allocated" });

      let allocatedLoc: string | null = null;

      const { data: dom, error: domErr } = await admin
        .rpc("dominant_sector_owner", { p_campaign_id: campaign_id })
        .maybeSingle();

      if (!domErr && dom?.owner_user_id) {
        const ownerId = dom.owner_user_id as string;
        const { data: owned, error: ownedErr } = await admin
          .from("sectors")
          .select("zone_key, sector_key")
          .eq("campaign_id", campaign_id)
          .eq("owner_user_id", ownerId);

        if (!ownedErr && owned?.length) {
          const pick = shuffle(owned)[0]!;
          const loc  = `${pick.zone_key}:${pick.sector_key}`;
          const { error: updErr } = await admin
            .from("sectors")
            .update({ owner_user_id: uid })
            .eq("campaign_id", campaign_id)
            .eq("zone_key", pick.zone_key)
            .eq("sector_key", pick.sector_key);
          if (!updErr) allocatedLoc = loc;
        }
      }

      if (!allocatedLoc) {
        const freeAny = allLocations.filter((k) => !usedSectors.has(k));
        if (!freeAny.length) return json(409, { ok: false, error: "No free sectors remain" });
        allocatedLoc = shuffle(freeAny)[0]!;
      }

      await ensurePublicPlayerState(uid);
      await writeSecret(uid, allocatedLoc);
      await createInitialSectors(uid, allocatedLoc, map!);
      await createInitialUnits(uid, allocatedLoc, roundNumber ?? 1);
      return json(200, { ok: true, allocated: 1 });
    }

    // ── Initial start ─────────────────────────────────────────────────────────

    const toAllocate = memberIds.filter((uid) => !assignedByUser.has(uid));
    let allocated = 0;

    for (const uid of toAllocate) {
      const zoneKey = pickUnusedZone();
      let loc: string | null = null;

      if (!zoneKey) {
        const freeAny = allLocations.filter((k) => !usedSectors.has(k));
        if (!freeAny.length) break;
        loc = shuffle(freeAny)[0]!;
      } else {
        loc = pickFreeSectorInZone(zoneKey);
        if (!loc) continue;
      }

      await ensurePublicPlayerState(uid);
      await writeSecret(uid, loc);
      await createInitialSectors(uid, loc, map!);
      await createInitialUnits(uid, loc, 1);

      usedSectors.add(loc);
      usedZones.add(parseLocation(loc).zone_key);
      allocated++;
    }

    // ── Assign zone effects to all zones (initial start only) ─────────────────
    // Runs after player allocation so map zones are fully seeded.
    // assignZoneEffects is idempotent — safe to call even if partially assigned.
    await assignZoneEffects(admin, campaign_id, map!);

    const { error: roundErr } = await admin.from("rounds").upsert(
      { campaign_id, round_number: 1, stage: "spend" },
      { onConflict: "campaign_id,round_number" }
    );
    if (roundErr) {
      console.error("[start-campaign] rounds upsert error:", roundErr.message);
      return json(500, { ok: false, error: `Failed to create round: ${roundErr.message}` });
    }

    const { error: campUpdateErr } = await admin
      .from("campaigns")
      .update({ round_number: 1 })
      .eq("id", campaign_id);
    if (campUpdateErr) {
      console.error("[start-campaign] campaigns round_number update error:", campUpdateErr.message);
    }

    return json(200, { ok: true, allocated });

  } catch (e) {
    return json(500, { ok: false, error: (e as Error).message ?? "Internal error" });
  }
});
