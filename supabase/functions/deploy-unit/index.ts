// supabase/functions/deploy-unit/index.ts
// Allows a player to spend NIP to deploy a new scout or occupation unit
// at one of their currently held sectors. Available during the spend phase only.
//
// NIP costs:
//   scout:      1 NIP
//   occupation: 2 NIP
//
// changelog:
//   2026-03-05 -- Initial implementation.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const UNIT_COSTS: Record<string, number> = {
  scout:      1,
  occupation: 2,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorised" });
    const uid = result.user.id;

    const admin = adminClient();
    const body  = await req.json().catch(() => ({}));

    const { campaign_id, unit_type, zone_key, sector_key } = body as {
      campaign_id: string;
      unit_type:   string;
      zone_key:    string;
      sector_key:  string;
    };

    if (!campaign_id || !unit_type || !zone_key || !sector_key) {
      return json(400, { ok: false, error: "Missing required fields" });
    }
    if (!["scout", "occupation"].includes(unit_type)) {
      return json(400, { ok: false, error: "unit_type must be scout or occupation" });
    }

    // Verify membership
    const { data: mem } = await admin
      .from("campaign_members").select("role")
      .eq("campaign_id", campaign_id).eq("user_id", uid).maybeSingle();
    if (!mem) return json(403, { ok: false, error: "Not a campaign member" });

    // Verify spend phase
    const { data: camp } = await admin
      .from("campaigns").select("round_number")
      .eq("id", campaign_id).single();
    if (!camp) return json(404, { ok: false, error: "Campaign not found" });

    const { data: round } = await admin
      .from("rounds").select("stage")
      .eq("campaign_id", campaign_id).eq("round_number", camp.round_number).maybeSingle();
    if (round?.stage !== "spend") {
      return json(400, { ok: false, error: `Units can only be deployed during the spend phase. Current stage: ${round?.stage ?? "none"}.` });
    }

    // Verify the player owns the target sector
    const { data: sector } = await admin
      .from("sectors").select("owner_user_id")
      .eq("campaign_id", campaign_id).eq("zone_key", zone_key).eq("sector_key", sector_key)
      .maybeSingle();
    if (!sector || sector.owner_user_id !== uid) {
      return json(403, { ok: false, error: "You can only deploy units to sectors you own" });
    }

    // Check NIP balance
    const { data: ps } = await admin
      .from("player_state").select("nip")
      .eq("campaign_id", campaign_id).eq("user_id", uid).maybeSingle();
    if (!ps) return json(404, { ok: false, error: "Player state not found" });

    const cost = UNIT_COSTS[unit_type]!;
    if ((ps.nip ?? 0) < cost) {
      return json(400, { ok: false, error: `Not enough NIP. Need ${cost}, have ${ps.nip}.` });
    }

    // Deduct NIP
    await admin.from("player_state")
      .update({ nip: ps.nip - cost })
      .eq("campaign_id", campaign_id).eq("user_id", uid);

    // Insert unit
    const { data: newUnit, error: unitErr } = await admin.from("units").insert({
      campaign_id,
      user_id:        uid,
      unit_type,
      zone_key,
      sector_key,
      status:         "active",
      round_deployed: camp.round_number,
    }).select("id").single();
    if (unitErr) throw new Error(unitErr.message);

    // Ledger entry
    await admin.from("ledger").insert({
      campaign_id,
      user_id:      uid,
      round_number: camp.round_number,
      entry_type:   "spend",
      currency:     "NIP",
      amount:       -cost,
      reason:       `Deployed ${unit_type} unit at ${zone_key}:${sector_key}`,
    });

    // Round spend record
    await admin.from("round_spends").insert({
      campaign_id,
      round_number: camp.round_number,
      user_id:      uid,
      spend_type:   `deploy_${unit_type}`,
      nip_spent:    cost,
      payload:      { zone_key, sector_key, unit_id: newUnit.id },
    });

    return json(200, { ok: true, unit_id: newUnit.id, nip_spent: cost, nip_remaining: ps.nip - cost });

  } catch (e: any) {
    console.error("[deploy-unit] error:", e?.message ?? String(e));
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
