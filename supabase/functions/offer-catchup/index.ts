// supabase/functions/offer-catchup/index.ts
// Called by the lead player during the results stage to offer a catchup choice
// to the underdog (member with fewest owned sectors). Uses service role so it
// can count all sectors regardless of fog-of-war RLS.
//
// changelog:
//   2026-03-05 -- Initial implementation.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorised" });
    const leadId = result.user.id;

    const admin = adminClient();
    const body = await req.json().catch(() => ({}));
    const { campaign_id } = body as { campaign_id?: string };

    if (!campaign_id) return json(400, { ok: false, error: "campaign_id required" });

    // Verify caller is lead/admin
    const { data: mem } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", leadId)
      .maybeSingle();

    if (!mem || !["lead", "admin"].includes(mem.role)) {
      return json(403, { ok: false, error: "Lead or admin only" });
    }

    // Get current campaign round
    const { data: campaign } = await admin
      .from("campaigns")
      .select("round_number, status")
      .eq("id", campaign_id)
      .single();

    if (!campaign) return json(404, { ok: false, error: "Campaign not found" });
    if (campaign.status !== "active") return json(400, { ok: false, error: "Campaign not active" });

    // Verify we are in results stage
    const { data: round } = await admin
      .from("rounds")
      .select("stage")
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number)
      .maybeSingle();

    if (round?.stage !== "results") {
      return json(400, { ok: false, error: "Catchup offer only available during the results stage" });
    }

    // Get all members for this campaign
    const { data: members } = await admin
      .from("campaign_members")
      .select("user_id, commander_name, role")
      .eq("campaign_id", campaign_id);

    if (!members?.length) return json(400, { ok: false, error: "No members found" });

    // Count sectors per member using service role (bypasses fog-of-war RLS)
    const { data: sectorCounts } = await admin
      .from("sectors")
      .select("owner_user_id")
      .eq("campaign_id", campaign_id)
      .not("owner_user_id", "is", null);

    // Build a count map: user_id -> sector count
    const countMap = new Map<string, number>();
    for (const m of members) {
      countMap.set(m.user_id, 0);
    }
    for (const s of sectorCounts ?? []) {
      if (s.owner_user_id) {
        countMap.set(s.owner_user_id, (countMap.get(s.owner_user_id) ?? 0) + 1);
      }
    }

    // Find the member with the fewest sectors (exclude the lead themselves)
    let underdogId: string | null = null;
    let underdogName: string | null = null;
    let minCount = Infinity;

    for (const m of members) {
      if (m.user_id === leadId) continue; // skip the lead
      const count = countMap.get(m.user_id) ?? 0;
      if (count < minCount) {
        minCount = count;
        underdogId = m.user_id;
        underdogName = m.commander_name ?? null;
      }
    }

    if (!underdogId) {
      return json(400, { ok: false, error: "Could not determine underdog player" });
    }

    // Upsert the underdog_choices record (idempotent -- can be re-triggered)
    const { error: insertErr } = await admin
      .from("underdog_choices")
      .upsert(
        {
          campaign_id,
          round_number: campaign.round_number,
          user_id:      underdogId,
          offered_by:   leadId,
          offered_at:   new Date().toISOString(),
          status:       "pending",
          chosen_option: null,
          chosen_at:    null,
        },
        { onConflict: "campaign_id,round_number,user_id" }
      );

    if (insertErr) {
      console.error("[offer-catchup] Insert error:", insertErr.message);
      return json(500, { ok: false, error: insertErr.message });
    }

    console.log(`[offer-catchup] Offered to ${underdogId} (${minCount} sectors)`);
    return json(200, {
      ok:             true,
      underdog_id:    underdogId,
      commander_name: underdogName,
      sector_count:   minCount,
    });

  } catch (e: any) {
    console.error("[offer-catchup] Error:", e?.message ?? String(e));
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
