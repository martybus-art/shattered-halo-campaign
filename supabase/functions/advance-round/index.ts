// supabase/functions/advance-round/index.ts
// Advances the current round stage one step.
// Stage order: spend → recon → movement → conflicts → missions → results → publish
// On publish → next round starts at spend.
// Conflict detection runs on movement→conflicts transition.
// Zone effect evaluation runs on movement→conflicts and results→publish transitions.
//
// changelog:
//   2026-03-15 -- Wired evaluate-zone-effects: called (non-blocking) after the
//                 movement→conflicts transition (units have moved, ownership may
//                 have changed) and after the results→publish transition (battle
//                 outcomes resolve, sector control may have shifted). Errors from
//                 evaluate-zone-effects are logged but never break stage advance.
//                 Uses Deno.env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for the
//                 internal service-to-service call, matching the pattern used by
//                 other edge functions across this codebase.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const STAGE_ORDER = [
  "spend",
  "recon",
  "movement",
  "conflicts",
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

// ---------------------------------------------------------------------------
// evaluateZoneEffects
// ---------------------------------------------------------------------------
// Calls the evaluate-zone-effects edge function via an internal service-to-
// service fetch. This checks sector ownership against thresholds and writes
// new zone_effect_reveals + War Bulletin posts for any newly-qualified players.
//
// Called after:
//   movement → conflicts  (units have moved, ownership may have changed)
//   results  → publish    (battle outcomes resolve, sector control may shift)
//
// Non-blocking: any error is logged but NEVER propagates — a failure here
// must not break the stage advance or return an error to the lead player.
// ---------------------------------------------------------------------------
async function evaluateZoneEffects(campaign_id: string): Promise<void> {
  const supabaseUrl      = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn("[advance-round] evaluateZoneEffects: missing SUPABASE_URL or service role key — skipping");
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
      console.error(`[advance-round] evaluateZoneEffects: HTTP ${resp.status} — ${text}`);
    } else {
      const data = await resp.json().catch(() => null);
      console.log(`[advance-round] evaluateZoneEffects: ok — newReveals=${data?.newReveals ?? "?"} bulletins=${data?.bulletin_posts ?? "?"}`);
    }
  } catch (e: any) {
    // Non-fatal — log and continue
    console.error("[advance-round] evaluateZoneEffects: fetch error —", e?.message ?? String(e));
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorised" });
    const user = result.user;
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

    // No round row yet — create and start at spend
    if (!round) {
      await admin.from("rounds").insert({
        campaign_id,
        round_number: campaign.round_number,
        stage: "spend",
      });
      return json(200, { ok: true, stage: "spend", conflicts_created: 0 });
    }

    const stage = round.stage as string;

    // publish → close this round, open next
    if (stage === "publish") {
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

    const newStage = nextStage(stage);
    let conflicts_created = 0;

    // Detect conflicts when movement phase closes (movement → conflicts).
    // All moves are submitted by this point; we now find zone/sector clashes.
    if (stage === "movement") {
      conflicts_created = await detectConflicts(admin, campaign_id, campaign.round_number);
    }

    await admin
      .from("rounds")
      .update({ stage: newStage })
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number);

    // Evaluate zone effects after transitions where sector ownership can change:
    //   movement → conflicts : units have moved, some sectors may be newly controlled
    //   results  → publish   : battle outcomes resolved, sector control may have shifted
    // evaluateZoneEffects is non-blocking — errors do not affect the response.
    if (stage === "movement" || stage === "results") {
      await evaluateZoneEffects(campaign_id);
    }

    return json(200, { ok: true, stage: newStage, conflicts_created });

  } catch (e: any) {
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
