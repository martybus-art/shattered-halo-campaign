import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUser, adminClient } from "../_shared/utils.ts";

/**
 * distribute-income
 * -----------------
 * Calculates and distributes NIP income to all players based on territory held.
 * Called manually by lead/admin from Lead Controls during the results stage.
 *
 * Income tiers (configurable via campaign.rules_overrides.economy):
 *   1-3  sectors => +2 NIP  (income_tier_1)
 *   4-6  sectors => +3 NIP  (income_tier_2)
 *   7-9  sectors => +4 NIP  (income_tier_3)
 *   10+  sectors => +5 NIP  (income_tier_4 -- cap to prevent runaway snowball)
 *
 * Auto-adjustments applied each round:
 *   - Underdog bonus: player with fewest sectors gets +underdog_bonus extra NIP
 *   - NIP decay: unspent NIP above decay_threshold loses decay_percent% (floored)
 *     of the excess -- discourages hoarding
 *
 * All constants default to the values shown in campaigns/page.tsx EconomySubPanel.
 *
 * Request body:
 *   campaignId   string   -- UUID of the campaign
 *   roundNumber  number   -- Round just completed (for audit log + bulletin)
 *   dryRun       boolean  -- true => preview only, no writes (default: false)
 *
 * changelog:
 *   2026-03-07 -- Initial deployment. Reads economy constants from rules_overrides,
 *                 applies tiered income + underdog bonus + decay, writes audit rows
 *                 to admin_adjustments, posts a public War Bulletin entry to posts.
 */

interface PlayerIncomeResult {
  userId:        string;
  factionName:   string | null;
  commanderName: string | null;
  sectorCount:   number;
  baseIncome:    number;
  underdogBonus: number;
  decayAmount:   number;
  nipBefore:     number;
  nipAfter:      number;
  isUnderdog:    boolean;
}

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireUser(req);
    if (!user) return json(401, { ok: false, error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const { campaignId, roundNumber, dryRun = false } = body as {
      campaignId:  string;
      roundNumber: number;
      dryRun?:     boolean;
    };

    if (!campaignId || roundNumber == null) {
      return json(400, { ok: false, error: "Missing required fields: campaignId, roundNumber" });
    }

    const admin = adminClient();

    // --- Authorise: lead or admin only ---
    const { data: membership } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaignId)
      .eq("user_id", user.id)
      .single();

    if (!membership || !["lead", "admin"].includes(membership.role)) {
      return json(403, { ok: false, error: "Forbidden: only lead or admin may distribute income" });
    }

    // --- Campaign rules ---
    const { data: campaign } = await admin
      .from("campaigns")
      .select("rules_overrides, name")
      .eq("id", campaignId)
      .single();

    if (!campaign) return json(404, { ok: false, error: "Campaign not found" });

    const rules = (campaign.rules_overrides ?? {}) as Record<string, unknown>;
    const eco   = (rules.economy   ?? {}) as Record<string, unknown>;

    // Income tiers: each covers sectors UP TO AND INCLUDING max_sectors value.
    const INCOME_TIERS: [number, number][] = [
      [3,        Number(eco.income_tier_1 ?? 2)],
      [6,        Number(eco.income_tier_2 ?? 3)],
      [9,        Number(eco.income_tier_3 ?? 4)],
      [Infinity, Number(eco.income_tier_4 ?? 5)],
    ];
    const DECAY_THRESHOLD = Number(eco.decay_threshold ?? 10);
    const DECAY_PERCENT   = Number(eco.decay_percent   ?? 10);
    const UNDERDOG_BONUS  = Number(eco.underdog_bonus  ?? 1);

    function incomeForCount(count: number): number {
      for (const [max, nip] of INCOME_TIERS) {
        if (count <= max) return nip;
      }
      return INCOME_TIERS[INCOME_TIERS.length - 1][1];
    }

    // --- All campaign members ---
    const { data: members } = await admin
      .from("campaign_members")
      .select("user_id, faction_name, commander_name")
      .eq("campaign_id", campaignId);

    if (!members?.length) {
      return json(400, { ok: false, error: "No members found for this campaign" });
    }

    const playerIds = members.map((m) => m.user_id as string);

    // --- Sector ownership counts ---
    const { data: allSectors } = await admin
      .from("sectors")
      .select("owner_user_id")
      .eq("campaign_id", campaignId)
      .not("owner_user_id", "is", null);

    const sectorCounts: Record<string, number> = {};
    for (const s of allSectors ?? []) {
      const uid = s.owner_user_id as string;
      sectorCounts[uid] = (sectorCounts[uid] ?? 0) + 1;
    }

    // --- Underdog: player with fewest sectors (ties: first iterated wins) ---
    let underdogId: string | null = null;
    let underdogMin = Infinity;
    for (const pid of playerIds) {
      const c = sectorCounts[pid] ?? 0;
      if (c < underdogMin) { underdogMin = c; underdogId = pid; }
    }

    // --- Current NIP balances ---
    const { data: playerStates } = await admin
      .from("player_state")
      .select("user_id, nip")
      .eq("campaign_id", campaignId)
      .in("user_id", playerIds);

    const nipByPlayer: Record<string, number> = {};
    for (const ps of playerStates ?? []) {
      nipByPlayer[ps.user_id as string] = Number(ps.nip ?? 0);
    }

    // --- Calculate income for every player ---
    const results: PlayerIncomeResult[] = [];
    const auditRows: Record<string, unknown>[] = [];

    for (const m of members) {
      const uid        = m.user_id as string;
      const count      = sectorCounts[uid] ?? 0;
      const base       = incomeForCount(count);
      const isUnderdog = uid === underdogId;
      const bonus      = isUnderdog ? UNDERDOG_BONUS : 0;
      const nipBefore  = nipByPlayer[uid] ?? 0;

      // Income applied first, decay assessed on the resulting balance
      const afterIncome = nipBefore + base + bonus;
      let decay    = 0;
      let nipAfter = afterIncome;
      if (afterIncome > DECAY_THRESHOLD) {
        decay    = Math.floor((afterIncome - DECAY_THRESHOLD) * (DECAY_PERCENT / 100));
        nipAfter = afterIncome - decay;
      }

      const noteParts = [
        `+${base} base`,
        bonus > 0 ? `+${bonus} underdog` : null,
        decay > 0 ? `-${decay} decay`    : null,
      ].filter(Boolean);

      results.push({
        userId: uid,
        factionName:   m.faction_name  as string | null,
        commanderName: m.commander_name as string | null,
        sectorCount: count,
        baseIncome:    base,
        underdogBonus: bonus,
        decayAmount:   decay,
        nipBefore,
        nipAfter,
        isUnderdog,
      });

      auditRows.push({
        campaign_id:     campaignId,
        adjusted_by:     user.id,
        player_id:       uid,
        adjustment_type: "nip",
        old_value:       String(nipBefore),
        new_value:       String(nipAfter),
        delta:           nipAfter - nipBefore,
        reason:          `Auto-income round ${roundNumber}: ${noteParts.join(", ")}`,
      });
    }

    // Dry run: preview only, no writes
    if (dryRun) {
      return json(200, { ok: true, dryRun: true, preview: results });
    }

    // --- Apply NIP updates ---
    const updateOps = results.map((r) =>
      admin
        .from("player_state")
        .update({ nip: r.nipAfter })
        .eq("campaign_id", campaignId)
        .eq("user_id", r.userId)
    );
    const updateResults = await Promise.all(updateOps);
    for (const { error } of updateResults) {
      if (error) console.error("[distribute-income] player_state update:", error.message);
    }

    // --- Audit log ---
    const { error: logErr } = await admin.from("admin_adjustments").insert(auditRows);
    if (logErr) console.error("[distribute-income] audit log:", logErr.message);

    // --- War Bulletin post ---
    // Intentionally vague on individual amounts -- the lead has the full detail
    // in the preview table. Players see only the summary to maintain tension.
    const bulletinBody = [
      `Round ${roundNumber} income has been distributed — all commanders have received their entitled NIP based on territorial holdings.`,
      "",
      `Note: additional NIP bonuses may also be allocated from war conflict results at the discretion of the campaign lead.`,
    ].join("\n");

    const { error: postErr } = await admin.from("posts").insert({
      campaign_id:  campaignId,
      title:        `Round ${roundNumber} — Income Distributed`,
      body:         bulletinBody,
      visibility:   "public",
      round_number: roundNumber,
    });
    if (postErr) console.error("[distribute-income] bulletin post:", postErr.message);

    return json(200, { ok: true, dryRun: false, roundNumber, results });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[distribute-income] unhandled error:", message);
    return json(500, { ok: false, error: message });
  }
});
