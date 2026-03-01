import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const admin = adminClient();
    const body  = await req.json().catch(() => ({}));

    const conflict_id: string | undefined    = body?.conflict_id;
    const winner_user_id: string | null      = body?.winner_user_id ?? null; // null = draw
    const confirmer_agrees: boolean          = body?.confirmer_agrees !== false;
    const nip_earned: number                 = typeof body?.nip_earned === "number" ? body.nip_earned : 2;
    const ncp_earned: number                 = typeof body?.ncp_earned === "number" ? body.ncp_earned : 0;
    const notes: string                      = body?.notes ?? "";

    if (!conflict_id) return json(400, { ok: false, error: "Missing conflict_id" });

    // ── Load the conflict ────────────────────────────────────────────────────
    const { data: conflict, error: confErr } = await admin
      .from("conflicts")
      .select("*")
      .eq("id", conflict_id)
      .single();

    if (confErr || !conflict) return json(404, { ok: false, error: "Conflict not found" });
    if (conflict.status === "resolved") return json(400, { ok: false, error: "Conflict already resolved" });

    const campaign_id   = conflict.campaign_id;
    const round_number  = conflict.round_number;
    const zone_key      = conflict.zone_key;
    const sector_key    = conflict.sector_key;

    // ── Verify caller is one of the two players ──────────────────────────────
    const isPlayerA = conflict.player_a === user.id;
    const isPlayerB = conflict.player_b === user.id;

    // Lead/admin can also resolve disputes
    const { data: mem } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    const isLeadAdmin = mem && ["lead", "admin"].includes(mem.role);

    if (!isPlayerA && !isPlayerB && !isLeadAdmin) {
      return json(403, { ok: false, error: "Not a participant of this conflict" });
    }

    // ── Load existing battle_results row (from first reporter) ───────────────
    const { data: existing } = await admin
      .from("battle_results")
      .select("*")
      .eq("conflict_id", conflict_id)
      .maybeSingle();

    // ── Determine final winner ───────────────────────────────────────────────
    // If confirmer_agrees = true we use their stated winner_user_id.
    // If disputed and not lead → flag for lead adjudication (don't resolve yet).
    const reportedWinner = existing
      ? ((existing.outcome_json as any)?.winner_user_id ?? null)
      : null;

    const disputed =
      !isLeadAdmin &&
      existing &&
      !confirmer_agrees &&
      reportedWinner !== winner_user_id;

    if (disputed) {
      // Record dispute, don't transfer sector yet
      await admin.from("battle_results").update({
        confirmed: true,
        outcome_json: {
          ...(existing!.outcome_json as object),
          confirmed_by: user.id,
          disputed: true,
          confirmer_winner: winner_user_id,
          notes,
        },
      }).eq("id", existing!.id);

      return json(200, {
        ok: true,
        status: "disputed",
        message: "Dispute recorded — the lead will adjudicate.",
      });
    }

    // Final winner: lead override > confirmer > original reporter
    const finalWinner: string | null = winner_user_id;
    const loserUserId: string | null = finalWinner
      ? (finalWinner === conflict.player_a ? conflict.player_b : conflict.player_a)
      : null; // null = draw, no loser

    // ── Upsert battle_results as confirmed ───────────────────────────────────
    if (existing) {
      await admin.from("battle_results").update({
        winner_user_id: finalWinner,
        confirmed: true,
        outcome_json: {
          ...(existing.outcome_json as object),
          winner_user_id: finalWinner,
          nip_earned,
          ncp_earned,
          confirmed_by: user.id,
          disputed: false,
          notes,
        },
      }).eq("id", existing.id);
    } else {
      // Lead resolving directly without a prior report
      await admin.from("battle_results").insert({
        conflict_id,
        reported_by: user.id,
        winner_user_id: finalWinner,
        confirmed: true,
        outcome_json: { winner_user_id: finalWinner, nip_earned, ncp_earned, notes },
      });
    }

    // ── Mark conflict resolved ───────────────────────────────────────────────
    await admin.from("conflicts")
      .update({ status: "resolved" })
      .eq("id", conflict_id);

    // ── Transfer sector ownership to winner ──────────────────────────────────
    let sectorTransferred = false;
    if (finalWinner) {
      // Find the sector row for this conflict location
      const { data: sectorRow } = await admin
        .from("sectors")
        .select("id, owner_user_id")
        .eq("campaign_id", campaign_id)
        .eq("zone_key", zone_key)
        .eq("sector_key", sector_key)
        .maybeSingle();

      if (sectorRow) {
        await admin.from("sectors")
          .update({ owner_user_id: finalWinner, revealed_public: true })
          .eq("id", sectorRow.id);
        sectorTransferred = true;
      } else {
        // Sector row doesn't exist yet — insert it as owned by winner
        await admin.from("sectors").insert({
          campaign_id,
          zone_key,
          sector_key,
          owner_user_id: finalWinner,
          revealed_public: true,
          fortified: false,
          tags: {},
        });
        sectorTransferred = true;
      }
    }

    // ── Award NIP/NCP to winner ──────────────────────────────────────────────
    if (finalWinner && (nip_earned > 0 || ncp_earned > 0)) {
      const { data: winnerState } = await admin
        .from("player_state")
        .select("nip, ncp")
        .eq("campaign_id", campaign_id)
        .eq("user_id", finalWinner)
        .maybeSingle();

      if (winnerState) {
        await admin.from("player_state").update({
          nip: (winnerState.nip ?? 0) + nip_earned,
          ncp: (winnerState.ncp ?? 0) + ncp_earned,
        }).eq("campaign_id", campaign_id).eq("user_id", finalWinner);

        const ledgerEntries: object[] = [];
        if (nip_earned > 0) {
          ledgerEntries.push({
            campaign_id,
            user_id: finalWinner,
            round_number,
            entry_type: "earn",
            currency: "NIP",
            amount: nip_earned,
            reason: `Victory at ${zone_key}:${sector_key} — Round ${round_number}`,
          });
        }
        if (ncp_earned > 0) {
          ledgerEntries.push({
            campaign_id,
            user_id: finalWinner,
            round_number,
            entry_type: "earn",
            currency: "NCP",
            amount: ncp_earned,
            reason: `Victory at ${zone_key}:${sector_key} — Round ${round_number}`,
          });
        }
        if (ledgerEntries.length) await admin.from("ledger").insert(ledgerEntries);
      }
    }

    // ── Check if loser is eliminated (no sectors left) ───────────────────────
    let loserEliminated = false;
    if (loserUserId) {
      const { count } = await admin
        .from("sectors")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaign_id)
        .eq("owner_user_id", loserUserId);

      if ((count ?? 0) === 0) {
        // Mark loser as inactive
        await admin.from("player_state")
          .update({ status: "inactive" })
          .eq("campaign_id", campaign_id)
          .eq("user_id", loserUserId);

        // Record elimination in ledger as a system event
        await admin.from("ledger").insert({
          campaign_id,
          user_id: loserUserId,
          round_number,
          entry_type: "system",
          currency: "NIP",
          amount: 0,
          reason: `Eliminated — no sectors remaining after defeat at ${zone_key}:${sector_key}`,
        });

        loserEliminated = true;
        console.log(`resolve-conflict: player ${loserUserId} eliminated in campaign ${campaign_id}`);
      }
    }

    console.log(
      `resolve-conflict: conflict=${conflict_id} winner=${finalWinner ?? "draw"} ` +
      `sector_transferred=${sectorTransferred} loser_eliminated=${loserEliminated}`
    );

    return json(200, {
      ok: true,
      status: "resolved",
      winner_user_id: finalWinner,
      sector_transferred: sectorTransferred,
      nip_earned,
      ncp_earned,
      loser_eliminated: loserEliminated,
    });

  } catch (e: any) {
    console.error("resolve-conflict error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
