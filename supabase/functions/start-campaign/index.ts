// supabase/functions/start-campaign/index.ts
// Allocates secret starting locations for all players, creates their
// initial scout and occupation units, and seeds the sectors table.
//
// changelog:
//   2026-03-08 -- Added createInitialSectors(): at campaign start, all sectors
//                 in each player's starting zone are inserted into the sectors
//                 table. The player's own starting sector is marked as owned
//                 and revealed_public=true; the remaining sectors in the zone
//                 are seeded as open (owner=null, revealed_public=false).
//                 This ensures effectiveZones fallback on map/page.tsx works
//                 from round 1 even when no map has been generated.
//                 Upsert uses ignoreDuplicates so it is safe if two players
//                 share a zone, and safe to re-run (idempotent).
//   2026-03-07 -- FIX: After creating rounds row, now also updates
//                 campaigns.round_number = 1 so the frontend query
//                 (rounds WHERE round_number = campaign.round_number)
//                 can find the row. Campaigns created with round_number=0
//                 were silently passing allocation but never showing as
//                 Active because the rounds row and campaign round_number
//                 were out of sync.
//   2026-03-05 -- Added unit creation: after each player's starting location
//                 is allocated, insert 1 scout + 1 occupation unit at that
//                 sector. Late mode also creates units for the late player.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

type Body =
  | { campaign_id: string; mode?: "initial" }
  | { campaign_id: string; mode: "late"; late_user_id: string };

type MapDef = {
  zones: { key: string; name: string; sectors: { key: string; name?: string }[] }[];
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
      // Sector keys in map_json are stored as "zone_key:sector_letter"
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

function parseLocation(loc: string) {
  const [zone_key, sector_key] = loc.split(":");
  return { zone_key, sector_key };
}

// Starting NIP grant for every player when a campaign begins
const STARTING_NIP = 1;

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

    // Load map via map_id FK
    let map: MapDef = fallbackMap();
    const { data: camp, error: campErr } = await admin
      .from("campaigns")
      .select("id, map_id, round_number")
      .eq("id", campaign_id)
      .maybeSingle();

    if (campErr) return json(500, { ok: false, error: campErr.message });

    const roundNumber = (camp as any)?.round_number;

    if (camp?.map_id) {
      const { data: mapRow, error: mapErr } = await admin
        .from("maps")
        .select("map_json")
        .eq("id", camp.map_id)
        .maybeSingle();
      if (!mapErr && mapRow?.map_json) {
        try {
          const mj = mapRow.map_json as any;
          if (mj?.zones?.length) map = mj as MapDef;
        } catch { /* use fallback */ }
      }
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
    for (const z of map.zones)
      for (const sec of z.sectors) allLocations.push(sec.key);

    function pickFreeSectorInZone(zoneKey: string): string | null {
      const zone = map.zones.find((z) => z.key === zoneKey);
      if (!zone) return null;
      const free = zone.sectors.map((s) => s.key).filter((k) => !usedSectors.has(k));
      return free.length ? shuffle(free)[0]! : null;
    }

    function pickUnusedZone(): string | null {
      const candidates = map.zones
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

    // Seeds the sectors table for the player's entire starting zone.
    // The player's specific starting sector is marked owned + revealed.
    // All other sectors in the zone are inserted as open (unowned, unrevealed).
    // Uses ignoreDuplicates=true so it is safe when two players share a zone
    // and safe to call multiple times (idempotent).
    async function createInitialSectors(uid: string, loc: string, mapDef: MapDef) {
      const { zone_key, sector_key } = parseLocation(loc);
      if (!zone_key || !sector_key) return;

      const zone = mapDef.zones.find((z) => z.key === zone_key);

      if (!zone) {
        // Zone not in map_json (unusual) -- insert just the starting sector
        const { error } = await admin.from("sectors").upsert(
          { campaign_id, zone_key, sector_key, owner_user_id: uid, revealed_public: true },
          { onConflict: "campaign_id,zone_key,sector_key", ignoreDuplicates: true }
        );
        if (error) console.error(`[start-campaign] single sector insert error:`, error.message);
        return;
      }

      // Build one row per sector in the zone.
      // Sector keys in map_json may be "zone_key:sector_letter" or just "sector_letter".
      const rows = zone.sectors.map((sec) => {
        const sk = sec.key.includes(":") ? sec.key.split(":").pop()! : sec.key;
        const isOwned = sk === sector_key;
        return {
          campaign_id,
          zone_key,
          sector_key:    sk,
          owner_user_id: isOwned ? uid : null as string | null,
          revealed_public: isOwned,
        };
      });

      const { error } = await admin.from("sectors").upsert(rows, {
        onConflict: "campaign_id,zone_key,sector_key",
        ignoreDuplicates: true,
      });
      if (error) console.error(`[start-campaign] sector insert error for ${uid}:`, error.message);
    }

    // Creates initial scout + occupation units at the player's starting sector.
    // Idempotent: skips creation if the player already has active units.
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

      if (existing?.length) return; // already has units

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
      await createInitialSectors(uid, allocatedLoc, map);
      await createInitialUnits(uid, allocatedLoc, roundNumber ?? 1);
      return json(200, { ok: true, allocated: 1 });
    }

    // ── Initial start: allocate all unassigned members ────────────────────────

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
      await createInitialSectors(uid, loc, map);
      await createInitialUnits(uid, loc, 1);

      usedSectors.add(loc);
      usedZones.add(parseLocation(loc).zone_key);
      allocated++;
    }

    // Open Round 1 / Spend phase in the rounds table
    const { error: roundErr } = await admin.from("rounds").upsert(
      { campaign_id, round_number: 1, stage: "spend" },
      { onConflict: "campaign_id,round_number" }
    );
    if (roundErr) {
      console.error("[start-campaign] rounds upsert error:", roundErr.message);
      return json(500, { ok: false, error: `Failed to create round: ${roundErr.message}` });
    }

    // Sync campaigns.round_number = 1 so the frontend query
    // (rounds WHERE round_number = campaign.round_number) finds the row.
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
