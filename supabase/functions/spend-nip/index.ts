import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

// Exchange rates
const NIP_PER_NCP = 3; // 3 NIP → 1 NCP

// Valid spend modes
type SpendMode = "trade_for_ncp";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const admin = adminClient();

    const body = await req.json().catch(() => ({}));
    const campaign_id: string | undefined = body?.campaign_id;
    const mode: SpendMode | undefined     = body?.mode;
    // For trade_for_ncp: number of NCP to buy (each costs NIP_PER_NCP NIP)
    const quantity: number = typeof body?.quantity === "number" && body.quantity > 0
      ? Math.floor(body.quantity) : 1;

    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });
    if (!mode)        return json(400, { ok: false, error: "Missing mode" });

    // Verify membership
    const { data: mem, error: memErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (memErr) return json(500, { ok: false, error: memErr.message });
    if (!mem) return json(403, { ok: false, error: "Not a member of this campaign" });

    // Load effective rules to check if cp_exchange is enabled
    const { data: camp, error: campErr } = await admin
      .from("campaigns")
      .select("round_number, rules_overrides")
      .eq("id", campaign_id)
      .maybeSingle();

    if (campErr || !camp) return json(404, { ok: false, error: "Campaign not found" });

    // Load player state
    const { data: ps, error: psErr } = await admin
      .from("player_state")
      .select("nip, ncp")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (psErr) return json(500, { ok: false, error: psErr.message });
    if (!ps)   return json(404, { ok: false, error: "Player state not found" });

    const currentNip = ps.nip ?? 0;
    const currentNcp = ps.ncp ?? 0;

    // ── Mode: trade NIP for NCP ───────────────────────────────────────────────
    if (mode === "trade_for_ncp") {
      const ro = (camp.rules_overrides as any) ?? {};
      const cpExchangeEnabled = ro?.narrative?.cp_exchange?.enabled !== false; // defaults to true

      if (!cpExchangeEnabled) {
        return json(403, { ok: false, error: "NIP-to-NCP exchange is disabled for this campaign" });
      }

      const nipCost = quantity * NIP_PER_NCP;

      if (currentNip < nipCost) {
        return json(400, {
          ok: false,
          error: `Not enough NIP. Need ${nipCost} (${quantity} × ${NIP_PER_NCP}), have ${currentNip}.`,
          nip_required: nipCost,
          nip_available: currentNip,
        });
      }

      const newNip = currentNip - nipCost;
      const newNcp = currentNcp + quantity;

      const { error: updateErr } = await admin
        .from("player_state")
        .update({ nip: newNip, ncp: newNcp })
        .eq("campaign_id", campaign_id)
        .eq("user_id", user.id);

      if (updateErr) return json(500, { ok: false, error: updateErr.message });

      // Ledger entries
      await admin.from("ledger").insert([
        {
          campaign_id,
          user_id: user.id,
          round_number: camp.round_number,
          entry_type: "spend",
          currency: "NIP",
          amount: -nipCost,
          reason: `Traded ${nipCost} NIP for ${quantity} NCP`,
        },
        {
          campaign_id,
          user_id: user.id,
          round_number: camp.round_number,
          entry_type: "earn",
          currency: "NCP",
          amount: quantity,
          reason: `Received ${quantity} NCP via NIP trade`,
        },
      ]);

      return json(200, {
        ok: true,
        mode,
        nip_spent: nipCost,
        ncp_gained: quantity,
        nip_new: newNip,
        ncp_new: newNcp,
      });
    }

    return json(400, { ok: false, error: `Unknown spend mode: ${mode}` });

  } catch (e: any) {
    console.error("spend-nip error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
