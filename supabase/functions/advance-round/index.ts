// supabase/functions/advance-round/index.ts
// Advances the current round stage one step.
// Stage order: spend -> recon -> movement -> missions -> results -> publish
// On publish -> next round starts at spend.
//
// changelog:
//   2026-03-16 -- BREAKING: Removed "conflicts" stage. It was a passive lobby
//                 with no automated logic -- players could submit NIP influence
//                 and the lead reviewed the list before advancing to missions.
//                 All of that now happens in the merged "missions" stage.
//                 detectConflicts() and evaluateZoneEffects() both moved from
//                 the movement->conflicts transition to movement->missions.
//                 Any DB rows with stage="conflicts" should be migrated to
//                 stage="missions" (hotfix applied directly to live campaigns).
//                 New stage order: spend->recon->movement->missions->results->publish
//   2026-03-15 -- Wired evaluate-zone-effects: called (non-blocking) after the
//                 movement->missions transition (units have moved, ownership may
//                 have changed) and after the results->publish transition (battle
//                 outcomes resolve, sector control may have shifted). Errors from
//                 evaluate-zone-effects are logged but never break stage advance.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const STAGE_ORDER = [
  "spend",
  "recon",
  "movement",
  "missions",
  "results",
  "publish",
] as const;

type Stage = typeof STAGE_ORDER[number];

function nextStage(current: string): Stage {
  const idx = STAGE_ORDER.indexOf(current as Stage);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return "spend";
  return STAGE_ORDER[idx + 1];
}

// detectConflicts: called on movement->missions transition.
// Scans all moves this round for players moving to the same zone:sector and
// creates conflict records for each contested destination. Idempotent --
// existing conflicts are skipped via dedup key check.
async function detectConflicts(
  admin: ReturnType<typeof adminClient>,
  campaign_id: string,
  round_number: number
): Promise<number> {
  const { data: moves, error: movesErr } = await admin
    .from("moves")
    .select("user_id, to_zone_key, to_sector_key")
    .eq("campaign_id", campaign_id)
    .eq("round_number", round_number);

  if (movesErr || !moves?.length) return 0;

  const byDest = new Map<string, string[]>();
  for (const m of moves) {
    const key = `${m.to_zone_key}:${m.to_sector_key}`;
    const list = byDest.get(key) ?? [];
    list.push(m.user_id);
    byDest.set(key, list);
  }

  const { data: existing } = await admin
    .from("conflicts")
    .select("zone_key, sector_key, player_a, player_b")
    .eq("campaign_id", campaign_id)
    .eq("round_number", round_number);

  const existingKeys = new Set(
    (existing ?? []).map((c: any) =>
      [c.zone_key, c.sector_key, c.player_a, c.player_b].sort().join("|")
    )
  );

  let created = 0;
  for (const [dest, players] of byDest.entries()) {
    if (players.length < 2) continue;
    const [zone_key, sector_key] = dest.split(":");
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const pa = players[i];
        const pb = players[j];
        const dedupKey = [zone_key, sector_key, pa, pb].sort().join("|");
        if (existingKeys.has(dedupKey)) continue;
        const { error } = await admin.from("conflicts").insert({
          campaign_id,
          round_number,
          zone_key,
          sector_key,
          player_a: pa,
          player_b: pb,
          mission_status: "unassigned",
          status: "scheduled",
          twist_tags: [],
        });
        if (!error) {
          existingKeys.add(dedupKey);
          created++;
        }
      }
    }
  }
  return created;
}

// evaluateZoneEffects: non-blocking internal call to the evaluate-zone-effects
// edge function. Checks sector ownership against thresholds and writes new
// zone_effect_reveals + War Bulletin posts for newly-qualified players.
// Called after:
//   movement -> missions : units have moved, ownership may have changed
//   results  -> publish  : battle outcomes resolved, sector control may shift
// Errors are logged but NEVER propagate -- a failure must not break stage advance.
async function evaluateZoneEffects(campaign_id: string): Promise<void> {
  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn("[advance-round] evaluateZoneEffects: missing env vars -- skipping");
    return;
  }

  try {
    const resp = await fetch(
      `${supabaseUrl}/functions/v1/evaluate-zone-effects`,
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({ campaign_id }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "(unreadable)");
      console.error(`[advance-round] evaluateZoneEffects: HTTP ${resp.status} -- ${text}`);
    } else {
      const data = await resp.json().catch(() => null);
      console.log(`[advance-round] evaluateZoneEffects: ok -- newReveals=${data?.newReveals ?? "?"} bulletins=${data?.bulletin_posts ?? "?"}`);
    }
  } catch (e: any) {
    console.error("[advance-round] evaluateZoneEffects: fetch error --", e?.message ?? String(e));
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorised" });
    const user  = result.user;
    const admin = adminClient();

    const { campaign_id } = (await req.json()) as { campaign_id: string };
    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });

    const { data: member } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!["lead", "admin"].includes(member?.role ?? "")) {
      return json(403, { ok: false, error: "Lead or admin only" });
    }

    const { data: campaign } = await admin
      .from("campaigns")
      .select("id, round_number, status")
      .eq("id", campaign_id)
      .single();

    if (!campaign) return json(404, { ok: false, error: "Campaign not found" });
    if (campaign.status !== "active") return json(400, { ok: false, error: "Campaign not active" });

    const { data: round } = await admin
      .from("rounds")
      .select("stage")
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number)
      .maybeSingle();

    // No round row yet -- create and start at spend
    if (!round) {
      await admin.from("rounds").insert({
        campaign_id,
        round_number: campaign.round_number,
        stage: "spend",
      });
      return json(200, { ok: true, stage: "spend", conflicts_created: 0 });
    }

    const stage = round.stage as string;

    // Legacy compatibility: if a campaign is somehow still on the old
    // "conflicts" stage (e.g. deployed before this migration), treat it
    // as "movement" so nextStage() returns "missions" correctly.
    const effectiveStage = stage === "conflicts" ? "movement" : stage;

    // publish -> close this round, open next
    if (effectiveStage === "publish") {
      await admin
        .from("rounds")
        .update({ stage: "closed", closed_at: new Date().toISOString() })
        .eq("campaign_id", campaign_id)
        .eq("round_number", campaign.round_number);

      const nextRound = campaign.round_number + 1;
      await admin.from("campaigns").update({ round_number: nextRound }).eq("id", campaign_id);
      await admin.from("rounds").insert({
        campaign_id,
        round_number: nextRound,
        stage: "spend",
      });

      return json(200, { ok: true, stage: "spend", round_number: nextRound, conflicts_created: 0 });
    }

    const newStage = nextStage(effectiveStage);
    let conflicts_created = 0;

    // Detect conflicts when movement phase closes (movement -> missions).
    // All moves are submitted by this point; find zone/sector clashes.
    // Also handles legacy "conflicts" stage being advanced (effectiveStage = "movement").
    if (effectiveStage === "movement") {
      conflicts_created = await detectConflicts(admin, campaign_id, campaign.round_number);
    }

    await admin
      .from("rounds")
      .update({ stage: newStage })
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number);

    // Evaluate zone effects after transitions where sector ownership can change:
    //   movement -> missions : units have moved, some sectors may be newly controlled
    //   results  -> publish  : battle outcomes resolved, sector control may have shifted
    if (effectiveStage === "movement" || effectiveStage === "results") {
      await evaluateZoneEffects(campaign_id);
    }

    return json(200, { ok: true, stage: newStage, conflicts_created });

  } catch (e: any) {
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
