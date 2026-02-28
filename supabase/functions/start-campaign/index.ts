import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

type Body =
  | { campaign_id: string; mode?: "initial" }
  | { campaign_id: string; mode: "late"; late_user_id: string };

type MapDef = {
  zones: { key: string; name: string; sectors: { key: string; name?: string }[] }[];
};

// Fallback Shattered Halo map: 8 zones x 4 sectors
function fallbackMap(): MapDef {
  const zones = [
    { key: "vault_ruins", name: "Vault Ruins" },
    { key: "ash_wastes", name: "Ash Wastes" },
    { key: "halo_spire", name: "Halo Spire" },
    { key: "sunken_manufactorum", name: "Sunken Manufactorum" },
    { key: "warp_scar_basin", name: "Warp Scar Basin" },
    { key: "obsidian_fields", name: "Obsidian Fields" },
    { key: "signal_crater", name: "Signal Crater" },
    { key: "xenos_forest", name: "Xenos Forest" },
  ];

  const sectors = ["a", "b", "c", "d"]; // 4 sectors
  return {
    zones: zones.map((z) => ({
      ...z,
      sectors: sectors.map((s) => ({ key: `${z.key}:${s}` })),
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
  // "zone_key:sector_key"
  const [zone_key, sector_key] = loc.split(":");
  return { zone_key, sector_key };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });

    const user = result.user;

    const admin = adminClient();

    const body = (await req.json().catch(() => ({}))) as Partial<Body>;
    const campaign_id = (body as any)?.campaign_id as string | undefined;
    const mode = ((body as any)?.mode ?? "initial") as "initial" | "late";
    const late_user_id = (body as any)?.late_user_id as string | undefined;

    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });
    if (mode === "late" && !late_user_id)
      return json(400, { ok: false, error: "Missing late_user_id" });

        // Validate result is lead
    const { data: leadRow, error: leadErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (leadErr) return json(500, { ok: false, error: leadErr.message });
    if (!leadRow || leadRow.role !== "lead") return json(403, { ok: false, error: "Lead only" });

    // Load map_json if present (campaigns.map_json), else fallback
    let map: MapDef = fallbackMap();
    const { data: camp, error: campErr } = await admin
      .from("campaigns")
      .select("id, map_json")
      .eq("id", campaign_id)
      .maybeSingle();

    if (campErr) return json(500, { ok: false, error: campErr.message });
    if (camp?.map_json) {
      // best-effort parse, fallback if shape differs
      try {
        const mj = camp.map_json as any;
        if (mj?.zones?.length) map = mj as MapDef;
      } catch {
        // ignore and use fallback
      }
    }

    // Members in campaign
    const { data: members, error: memErr } = await admin
      .from("campaign_members")
      .select("user_id")
      .eq("campaign_id", campaign_id);

    if (memErr) return json(500, { ok: false, error: memErr.message });

    const memberIds = (members ?? []).map((m: any) => m.user_id as string);

    // Existing secret assignments
    const { data: secrets, error: secErr } = await admin
      .from("player_state_secret")
      .select("user_id, starting_location, secret_location")
      .eq("campaign_id", campaign_id);

    if (secErr) return json(500, { ok: false, error: secErr.message });

    const assignedByUser = new Map<string, string>();
    const usedZones = new Set<string>();
    const usedSectors = new Set<string>(); // full "zone:sector"
    for (const s of secrets ?? []) {
      const loc = (s.secret_location ?? s.starting_location) as string | null;
      if (s.user_id && loc) {
        assignedByUser.set(s.user_id, loc);
        usedSectors.add(loc);
        const { zone_key } = parseLocation(loc);
        if (zone_key) usedZones.add(zone_key);
      }
    }

    // Build all available sector locations from map
    const allLocations: string[] = [];
    for (const z of map.zones) {
      for (const sec of z.sectors) allLocations.push(sec.key);
    }

    // Helper: pick a free sector in a zone
    function pickFreeSectorInZone(zoneKey: string): string | null {
      const zone = map.zones.find((z) => z.key === zoneKey);
      if (!zone) return null;
      const free = zone.sectors.map((s) => s.key).filter((k) => !usedSectors.has(k));
      if (!free.length) return null;
      return shuffle(free)[0]!;
    }

    // Helper: pick an unused zone with at least 1 free sector
    function pickUnusedZone(): string | null {
      const candidates = map.zones
        .map((z) => z.key)
        .filter((zk) => !usedZones.has(zk))
        .filter((zk) => pickFreeSectorInZone(zk) !== null);

      if (!candidates.length) return null;
      return shuffle(candidates)[0]!;
    }

    async function ensurePublicPlayerState(user_id: string) {
      // Ensure player_state exists (upsert with default public placeholders)
      const { error } = await admin.from("player_state").upsert(
        {
          campaign_id,
          user_id,
          public_location: "Unknown",
          current_zone_key: "unknown",
        },
        { onConflict: "campaign_id,user_id" }
      );
      if (error) throw new Error(error.message);
    }

    async function writeSecret(user_id: string, loc: string) {
      const { error } = await admin.from("player_state_secret").upsert(
        {
          campaign_id,
          user_id,
          starting_location: loc,
          secret_location: loc,
        },
        { onConflict: "campaign_id,user_id" }
      );
      if (error) throw new Error(error.message);
    }

    // MODE: late joiner
    if (mode === "late") {
      const uid = late_user_id!;
      if (!memberIds.includes(uid)) {
        return json(400, { ok: false, error: "late_user_id is not a member of this campaign" });
      }
      if (assignedByUser.has(uid)) {
        return json(200, { ok: true, allocated: 0 }); // already allocated
      }

      // Attempt: reassign one sector from dominant owner (requires a `sectors` table)
      // Expected columns: campaign_id, zone_key, sector_key, owner_user_id
      let allocatedLoc: string | null = null;

      const { data: dom, error: domErr } = await admin.rpc("dominant_sector_owner", {
        p_campaign_id: campaign_id,
      }).maybeSingle();

      // If you don't have this RPC, domErr will happen -> fallback logic below.
      if (!domErr && dom?.owner_user_id) {
        const ownerId = dom.owner_user_id as string;

        const { data: owned, error: ownedErr } = await admin
          .from("sectors")
          .select("zone_key, sector_key")
          .eq("campaign_id", campaign_id)
          .eq("owner_user_id", ownerId);

        if (!ownedErr && owned?.length) {
          const pick = shuffle(owned)[0]!;
          const loc = `${pick.zone_key}:${pick.sector_key}`;
          // Transfer ownership
          const { error: updErr } = await admin
            .from("sectors")
            .update({ owner_user_id: uid })
            .eq("campaign_id", campaign_id)
            .eq("zone_key", pick.zone_key)
            .eq("sector_key", pick.sector_key);

          if (!updErr) allocatedLoc = loc;
        }
      }

      // Fallback: allocate a free sector anywhere with zone uniqueness ignored if needed
      if (!allocatedLoc) {
        const freeAny = allLocations.filter((k) => !usedSectors.has(k));
        if (!freeAny.length) return json(409, { ok: false, error: "No free sectors remain" });
        allocatedLoc = shuffle(freeAny)[0]!;
      }

      await ensurePublicPlayerState(uid);
      await writeSecret(uid, allocatedLoc);
      usedSectors.add(allocatedLoc);
      usedZones.add(parseLocation(allocatedLoc).zone_key);

      return json(200, { ok: true, allocated: 1 });
    }

    // MODE: initial allocation
    const toAllocate = memberIds.filter((uid) => !assignedByUser.has(uid));
    let allocated = 0;

    for (const uid of toAllocate) {
      const zoneKey = pickUnusedZone();
      if (!zoneKey) {
        // If we ran out of unused zones, fall back to any free sector (still no overlap)
        const freeAny = allLocations.filter((k) => !usedSectors.has(k));
        if (!freeAny.length) break;
        const loc = shuffle(freeAny)[0]!;
        await ensurePublicPlayerState(uid);
        await writeSecret(uid, loc);
        usedSectors.add(loc);
        usedZones.add(parseLocation(loc).zone_key);
        allocated++;
        continue;
      }

      const loc = pickFreeSectorInZone(zoneKey);
      if (!loc) continue;

      await ensurePublicPlayerState(uid);
      await writeSecret(uid, loc);
      usedZones.add(zoneKey);
      usedSectors.add(loc);
      allocated++;
    }

    return json(200, { ok: true, allocated });
  } catch (e) {
    return json(500, { ok: false, error: (e as Error).message ?? "Internal error" });
  }
});