// supabase/functions/propose-alliance/index.ts
//
// changelog:
//   2026-03-08 — Created. Handles the three non-committing alliance actions:
//                  propose  — sets alliance_proposed_by = caller (player proposes ceasefire)
//                  withdraw — clears alliance_proposed_by (proposer backs out)
//                  decline  — clears alliance_proposed_by (opponent rejects proposal)
//
// The committing action (accept) lives in form-alliance/index.ts.
//
// Body: { conflict_id: string, action: "propose" | "withdraw" | "decline" }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const body = await req.json().catch(() => ({}));

    const conflict_id: string | undefined = body?.conflict_id;
    const action: string | undefined      = body?.action; // "propose" | "withdraw" | "decline"

    if (!conflict_id) return json(400, { ok: false, error: "Missing conflict_id" });
    if (!["propose", "withdraw", "decline"].includes(action ?? "")) {
      return json(400, { ok: false, error: "action must be propose | withdraw | decline" });
    }

    const admin = adminClient();

    // ── Load conflict ────────────────────────────────────────────────────────
    const { data: conflict, error: confErr } = await admin
      .from("conflicts")
      .select("id, campaign_id, player_a, player_b, status, alliance_proposed_by")
      .eq("id", conflict_id)
      .single();

    if (confErr || !conflict) return json(404, { ok: false, error: "Conflict not found" });

    // Alliances can only be negotiated on scheduled conflicts
    if (conflict.status !== "scheduled") {
      return json(400, { ok: false, error: "Conflict is not in a negotiable state" });
    }

    const isPlayerA = conflict.player_a === user.id;
    const isPlayerB = conflict.player_b === user.id;

    if (!isPlayerA && !isPlayerB) {
      return json(403, { ok: false, error: "Not a participant of this conflict" });
    }

    const opponentId = isPlayerA ? conflict.player_b : conflict.player_a;

    // ── Validate action ──────────────────────────────────────────────────────
    if (action === "propose") {
      // Can only propose if no proposal is currently active
      if (conflict.alliance_proposed_by !== null) {
        return json(400, { ok: false, error: "A proposal is already active for this conflict" });
      }
    }

    if (action === "withdraw") {
      // Only the proposer can withdraw their own proposal
      if (conflict.alliance_proposed_by !== user.id) {
        return json(403, { ok: false, error: "You did not make this proposal" });
      }
    }

    if (action === "decline") {
      // Only the opponent (non-proposer) can decline
      if (conflict.alliance_proposed_by !== opponentId) {
        return json(400, { ok: false, error: "No proposal from your opponent to decline" });
      }
    }

    // ── Apply the change ─────────────────────────────────────────────────────
    const newValue = action === "propose" ? user.id : null;

    const { error: updateErr } = await admin
      .from("conflicts")
      .update({ alliance_proposed_by: newValue })
      .eq("id", conflict_id);

    if (updateErr) {
      console.error("propose-alliance: update error:", updateErr.message);
      return json(500, { ok: false, error: updateErr.message });
    }

    const messages: Record<string, string> = {
      propose:  "Ceasefire proposal sent — your opponent must accept or decline.",
      withdraw: "Proposal withdrawn — the conflict remains active.",
      decline:  "Proposal declined — the battle will proceed.",
    };

    console.log(`propose-alliance: conflict=${conflict_id} action=${action} by=${user.id}`);

    return json(200, { ok: true, action, message: messages[action!] });

  } catch (e: any) {
    console.error("propose-alliance error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
