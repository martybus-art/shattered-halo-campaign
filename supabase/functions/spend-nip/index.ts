import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const NIP_PER_NCP      = 3;
const RECON_NIP_COST   = 1;
const MISSION_NIP_COST = 1;

type SpendMode = "trade_for_ncp" | "recon" | "mission_pref";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;
    const admin = adminClient();

    const body        = await req.json().catch(() => ({}));
    const campaign_id = body?.campaign_id as string | undefined;
    const mode        = body?.mode as SpendMode | undefined;
    const quantity    = typeof body?.quantity === "number" && body.quantity > 0 ? Math.floor(body.quantity) : 1;
    const mission_type = body?.mission_type as string | undefined; // for mission_pref mode

    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });
    if (!mode)        return json(400, { ok: false, error: "Missing mode" });

    const { data: mem, error: memErr } = await admin
      .from("campaign_members").select("role")
      .eq("campaign_id", campaign_id).eq("user_id", user.id).maybeSingle();
    if (memErr) return json(500, { ok: false, error: memErr.message });
    if (!mem)   return json(403, { ok: false, error: "Not a member of this campaign" });

    const { data: camp, error: campErr } = await admin
      .from("campaigns").select("round_number, rules_overrides")
      .eq("id", campaign_id).maybeSingle();
    if (campErr || !camp) return json(404, { ok: false, error: "Campaign not found" });

    // Verify spend phase is active
    const { data: round } = await admin
      .from("rounds").select("stage")
      .eq("campaign_id", campaign_id).eq("round_number", camp.round_number).maybeSingle();
    // Allow trade_for_ncp at any stage; recon/mission_pref require spend stage
    if (mode !== "trade_for_ncp" && round?.stage !== "spend") {
      return json(400, {
        ok: false,
        error: `This purchase is only available during the spend phase. Current stage: ${round?.stage ?? "none"}.`,
      });
    }

    const { data: ps, error: psErr } = await admin
      .from("player_state").select("nip, ncp")
      .eq("campaign_id", campaign_id).eq("user_id", user.id).maybeSingle();
    if (psErr) return json(500, { ok: false, error: psErr.message });
    if (!ps)   return json(404, { ok: false, error: "Player state not found" });

    const currentNip = ps.nip ?? 0;
    const currentNcp = ps.ncp ?? 0;

    // ── Mode: trade NIP for NCP ─────────────────────────────────────────────
    if (mode === "trade_for_ncp") {
      const ro = (camp.rules_overrides as any) ?? {};
      if (ro?.narrative?.cp_exchange?.enabled === false) {
        return json(403, { ok: false, error: "NIP-to-NCP exchange is disabled for this campaign" });
      }
      const nipCost = quantity * NIP_PER_NCP;
      if (currentNip < nipCost) {
        return json(400, {
          ok: false,
          error: `Not enough NIP. Need ${nipCost} (${quantity} × ${NIP_PER_NCP}), have ${currentNip}.`,
        });
      }
      const newNip = currentNip - nipCost;
      const newNcp = currentNcp + quantity;
      await admin.from("player_state")
        .update({ nip: newNip, ncp: newNcp })
        .eq("campaign_id", campaign_id).eq("user_id", user.id);
      await admin.from("ledger").insert([
        {
          campaign_id, user_id: user.id, round_number: camp.round_number,
          entry_type: "spend", currency: "NIP", amount: -nipCost,
          reason: `Traded ${nipCost} NIP for ${quantity} NCP`,
        },
        {
          campaign_id, user_id: user.id, round_number: camp.round_number,
          entry_type: "earn", currency: "NCP", amount: quantity,
          reason: `Received ${quantity} NCP via NIP trade`,
        },
      ]);
      return json(200, { ok: true, mode, nip_spent: nipCost, ncp_gained: quantity, nip_new: newNip, ncp_new: newNcp });
    }

    // ── Mode: purchase recon token ──────────────────────────────────────────
    if (mode === "recon") {
      // Check not already purchased this round
      const { data: existing } = await admin
        .from("round_spends").select("id")
        .eq("campaign_id", campaign_id).eq("round_number", camp.round_number)
        .eq("user_id", user.id).eq("spend_type", "recon").maybeSingle();
      if (existing) return json(409, { ok: false, error: "Recon token already purchased this round." });

      if (currentNip < RECON_NIP_COST) {
        return json(400, { ok: false, error: `Not enough NIP. Need ${RECON_NIP_COST}, have ${currentNip}.` });
      }
      const newNip = currentNip - RECON_NIP_COST;
      await admin.from("player_state")
        .update({ nip: newNip })
        .eq("campaign_id", campaign_id).eq("user_id", user.id);
      await admin.from("round_spends").insert({
        campaign_id, round_number: camp.round_number, user_id: user.id,
        spend_type: "recon", payload: {}, nip_spent: RECON_NIP_COST,
      });
      await admin.from("ledger").insert({
        campaign_id, user_id: user.id, round_number: camp.round_number,
        entry_type: "spend", currency: "NIP", amount: -RECON_NIP_COST,
        reason: `Purchased recon token`,
      });
      return json(200, { ok: true, mode, nip_spent: RECON_NIP_COST, nip_new: newNip });
    }

    // ── Mode: choose mission type preference ────────────────────────────────
    if (mode === "mission_pref") {
      if (!mission_type) return json(400, { ok: false, error: "Missing mission_type for mission_pref mode" });

      // Check if already purchased — allow replacing at same cost
      const { data: existing } = await admin
        .from("round_spends").select("id")
        .eq("campaign_id", campaign_id).eq("round_number", camp.round_number)
        .eq("user_id", user.id).eq("spend_type", "mission_pref").maybeSingle();
      if (existing) {
        // Update existing preference (no additional NIP cost — already paid)
        await admin.from("round_spends")
          .update({ payload: { mission_type } })
          .eq("id", existing.id);
        return json(200, { ok: true, mode, mission_type, nip_spent: 0, changed: true });
      }

      if (currentNip < MISSION_NIP_COST) {
        return json(400, { ok: false, error: `Not enough NIP. Need ${MISSION_NIP_COST}, have ${currentNip}.` });
      }
      const newNip = currentNip - MISSION_NIP_COST;
      await admin.from("player_state")
        .update({ nip: newNip })
        .eq("campaign_id", campaign_id).eq("user_id", user.id);
      await admin.from("round_spends").insert({
        campaign_id, round_number: camp.round_number, user_id: user.id,
        spend_type: "mission_pref", payload: { mission_type }, nip_spent: MISSION_NIP_COST,
      });
      await admin.from("ledger").insert({
        campaign_id, user_id: user.id, round_number: camp.round_number,
        entry_type: "spend", currency: "NIP", amount: -MISSION_NIP_COST,
        reason: `Mission preference: ${mission_type}`,
      });
      return json(200, { ok: true, mode, mission_type, nip_spent: MISSION_NIP_COST, nip_new: newNip });
    }

    return json(400, { ok: false, error: `Unknown spend mode: ${mode}` });

  } catch (e: any) {
    console.error("spend-nip error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
