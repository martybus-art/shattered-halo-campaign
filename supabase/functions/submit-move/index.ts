import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

// ── Adjacency helpers ─────────────────────────────────────────────────────────
type ZonePosition = { row: number; col: number };

/**
 * Given a flat list of zones and the number of columns in the zone grid,
 * returns the (row, col) position of a zone by its key.
 */
function zonePosition(zones: { key: string }[], zoneKey: string, cols: number): ZonePosition | null {
  const idx = zones.findIndex((z) => z.key === zoneKey);
  if (idx === -1) return null;
  return { row: Math.floor(idx / cols), col: idx % cols };
}

/**
 * Returns true if two zones are directly adjacent (horizontal or vertical
 * neighbours in the zone grid — no diagonals).
 */
function zonesAreAdjacent(
  zones: { key: string }[],
  zoneA: string,
  zoneB: string,
  cols: number
): boolean {
  if (zoneA === zoneB) return true; // same zone is always "adjacent"
  const a = zonePosition(zones, zoneA, cols);
  const b = zonePosition(zones, zoneB, cols);
  if (!a || !b) return false;
  const rowDiff = Math.abs(a.row - b.row);
  const colDiff = Math.abs(a.col - b.col);
  return (rowDiff === 1 && colDiff === 0) || (rowDiff === 0 && colDiff === 1);
}

// ── Constants ─────────────────────────────────────────────────────────────────
const DEEP_STRIKE_NIP_COST = 3;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const admin = adminClient();

    const body = await req.json().catch(() => ({}));
    const campaign_id: string | undefined  = body?.campaign_id;
    const to_zone_key: string | undefined  = body?.to_zone_key;
    const to_sector_key: string | undefined = body?.to_sector_key;
    // is_deep_strike: player explicitly choosing to deep strike (pay 3 NIP)
    const is_deep_strike: boolean = !!body?.is_deep_strike;

    if (!campaign_id || !to_zone_key || !to_sector_key) {
      return json(400, { ok: false, error: "Missing campaign_id, to_zone_key, or to_sector_key" });
    }

    // ── Verify membership ────────────────────────────────────────────────────
    const { data: mem, error: memErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (memErr) return json(500, { ok: false, error: memErr.message });
    if (!mem) return json(403, { ok: false, error: "Not a member of this campaign" });

    // ── Verify round is in movement stage ────────────────────────────────────
    const { data: camp, error: campErr } = await admin
      .from("campaigns")
      .select("round_number, map_id")
      .eq("id", campaign_id)
      .maybeSingle();

    if (campErr || !camp) return json(404, { ok: false, error: "Campaign not found" });

    const { data: round, error: roundErr } = await admin
      .from("rounds")
      .select("stage")
      .eq("campaign_id", campaign_id)
      .eq("round_number", camp.round_number)
      .maybeSingle();

    if (roundErr) return json(500, { ok: false, error: roundErr.message });
    if (!round) return json(400, { ok: false, error: "No active round found" });
    if (round.stage !== "movement") {
      return json(400, { ok: false, error: `Movement not allowed in stage: ${round.stage}` });
    }

    // ── Check player hasn't already moved this round ─────────────────────────
    const { data: existingMove } = await admin
      .from("moves")
      .select("id")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .eq("round_number", camp.round_number)
      .maybeSingle();

    if (existingMove) {
      return json(409, { ok: false, error: "You have already submitted a move this round" });
    }

    // ── Load player's secret location ────────────────────────────────────────
    const { data: secret, error: secretErr } = await admin
      .from("player_state_secret")
      .select("secret_location, starting_location")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (secretErr) return json(500, { ok: false, error: secretErr.message });

    const currentLocation = secret?.secret_location ?? secret?.starting_location ?? null;
    const from_zone_key   = currentLocation ? currentLocation.split(":")[0] : null;
    const from_sector_key = currentLocation ? currentLocation.split(":")[1] : null;

    if (!from_zone_key || !from_sector_key) {
      return json(400, { ok: false, error: "Your starting location has not been allocated yet" });
    }

    // ── Load map for adjacency computation ───────────────────────────────────
    let mapZones: { key: string }[] = [];
    let zone_cols = 2; // fallback

    if (camp.map_id) {
      const { data: mapRow } = await admin
        .from("maps")
        .select("map_json")
        .eq("id", camp.map_id)
        .maybeSingle();

      const mj = mapRow?.map_json as any;
      if (mj?.zones?.length) {
        mapZones  = mj.zones;
        zone_cols = mj.zone_cols ?? 2;
      }
    }

    // Fallback: use the default 8-zone list in column order
    if (!mapZones.length) {
      mapZones = [
        { key: "vault_ruins" }, { key: "ash_wastes" }, { key: "halo_spire" }, { key: "sunken_manufactorum" },
        { key: "warp_scar_basin" }, { key: "obsidian_fields" }, { key: "signal_crater" }, { key: "xenos_forest" },
      ];
      zone_cols = 4;
    }

    // ── Determine if this is an adjacent or deep-strike move ─────────────────
    const adjacent = zonesAreAdjacent(mapZones, from_zone_key, to_zone_key, zone_cols);

    // If not adjacent and not flagged as deep strike → reject
    if (!adjacent && !is_deep_strike) {
      return json(400, {
        ok: false,
        error: `${to_zone_key} is not adjacent to your current zone (${from_zone_key}). Set is_deep_strike: true to spend ${DEEP_STRIKE_NIP_COST} NIP.`,
        requires_deep_strike: true,
        nip_cost: DEEP_STRIKE_NIP_COST,
      });
    }

    // If adjacent but player sent is_deep_strike: true, just ignore the flag (free move)
    const actualDeepStrike = !adjacent && is_deep_strike;

    // ── Deduct NIP for deep strike ────────────────────────────────────────────
    const spend_json: Record<string, unknown> = {};

    if (actualDeepStrike) {
      const { data: ps, error: psErr } = await admin
        .from("player_state")
        .select("nip")
        .eq("campaign_id", campaign_id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (psErr) return json(500, { ok: false, error: psErr.message });

      const currentNip = ps?.nip ?? 0;
      if (currentNip < DEEP_STRIKE_NIP_COST) {
        return json(400, {
          ok: false,
          error: `Not enough NIP for deep strike. Need ${DEEP_STRIKE_NIP_COST}, have ${currentNip}.`,
          nip_required: DEEP_STRIKE_NIP_COST,
          nip_available: currentNip,
        });
      }

      // Deduct NIP
      const { error: nipErr } = await admin
        .from("player_state")
        .update({ nip: currentNip - DEEP_STRIKE_NIP_COST })
        .eq("campaign_id", campaign_id)
        .eq("user_id", user.id);

      if (nipErr) return json(500, { ok: false, error: `NIP deduction failed: ${nipErr.message}` });

      // Record ledger entry
      await admin.from("ledger").insert({
        campaign_id,
        user_id: user.id,
        round_number: camp.round_number,
        entry_type: "spend",
        currency: "NIP",
        amount: -DEEP_STRIKE_NIP_COST,
        reason: `Deep strike to ${to_zone_key}:${to_sector_key}`,
      });

      spend_json.deep_strike_nip = DEEP_STRIKE_NIP_COST;
    }

    // ── Insert move ───────────────────────────────────────────────────────────
    const { error: moveErr } = await admin.from("moves").insert({
      campaign_id,
      round_number: camp.round_number,
      user_id: user.id,
      from_zone_key,
      from_sector_key,
      to_zone_key,
      to_sector_key,
      spend_json,
    });

    if (moveErr) return json(500, { ok: false, error: `Move insert failed: ${moveErr.message}` });

    // ── Update secret location ────────────────────────────────────────────────
    // Under fog of war, public_location only updates to zone level (not sector).
    // Exact sector stays secret until revealed.
    const newLocation = `${to_zone_key}:${to_sector_key}`;
    const { error: secretUpdateErr } = await admin
      .from("player_state_secret")
      .update({ secret_location: newLocation })
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id);

    if (secretUpdateErr) {
      console.warn("secret location update failed:", secretUpdateErr.message);
    }

    // Update public_location to zone name only (keeps exact sector hidden)
    await admin
      .from("player_state")
      .update({ current_zone_key: to_zone_key, public_location: to_zone_key.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase()) })
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id);

    return json(200, {
      ok: true,
      move: { from_zone_key, from_sector_key, to_zone_key, to_sector_key },
      deep_strike: actualDeepStrike,
      nip_spent: actualDeepStrike ? DEEP_STRIKE_NIP_COST : 0,
    });

  } catch (e: any) {
    console.error("submit-move error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
