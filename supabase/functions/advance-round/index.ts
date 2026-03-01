import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const STAGE_ORDER = ["spend", "movement", "recon", "conflicts", "missions", "results", "publish"] as const;
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
    .from("moves").select("user_id, to_zone_key, to_sector_key")
    .eq("campaign_id", campaign_id).eq("round_number", round_number);

  if (movesErr || !moves?.length) return 0;

  const byDest = new Map<string, string[]>();
  for (const m of moves) {
    const key = `${m.to_zone_key}:${m.to_sector_key}`;
    const list = byDest.get(key) ?? [];
    list.push(m.user_id);
    byDest.set(key, list);
  }

  const { data: existing } = await admin
    .from("conflicts").select("zone_key, sector_key, player_a, player_b")
    .eq("campaign_id", campaign_id).eq("round_number", round_number);

  const existingKeys = new Set(
    (existing ?? []).map((c: any) => [c.zone_key, c.sector_key, c.player_a, c.player_b].sort().join("|"))
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
          campaign_id, round_number, zone_key, sector_key,
          player_a: pa, player_b: pb,
          mission_status: "unassigned", status: "scheduled", twist_tags: [],
        });
        if (!error) { existingKeys.add(dedupKey); created++; }
      }
    }
  }
  return created;
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
      .from("campaign_members").select("role")
      .eq("campaign_id", campaign_id).eq("user_id", user.id).maybeSingle();
    if (!["lead", "admin"].includes(member?.role ?? "")) {
      return json(403, { ok: false, error: "Lead or admin only" });
    }

    const { data: campaign } = await admin
      .from("campaigns").select("id, round_number, status").eq("id", campaign_id).single();
    if (!campaign) return json(404, { ok: false, error: "Campaign not found" });
    if (campaign.status !== "active") return json(400, { ok: false, error: "Campaign not active" });

    const { data: round } = await admin
      .from("rounds").select("stage")
      .eq("campaign_id", campaign_id).eq("round_number", campaign.round_number).maybeSingle();

    if (!round) {
      await admin.from("rounds").insert({ campaign_id, round_number: campaign.round_number, stage: "spend" });
      return json(200, { ok: true, stage: "spend", conflicts_created: 0 });
    }

    const stage = round.stage as string;

    if (stage === "publish") {
      await admin.from("rounds")
        .update({ stage: "closed", closed_at: new Date().toISOString() })
        .eq("campaign_id", campaign_id).eq("round_number", campaign.round_number);
      const nextRound = campaign.round_number + 1;
      await admin.from("campaigns").update({ round_number: nextRound }).eq("id", campaign_id);
      await admin.from("rounds").insert({ campaign_id, round_number: nextRound, stage: "spend" });
      return json(200, { ok: true, stage: "spend", round_number: nextRound, conflicts_created: 0 });
    }

    const newStage = nextStage(stage);
    let conflicts_created = 0;

    // movement -> recon: detect conflicts so recon players can see where opponents landed
    if (stage === "movement") {
      conflicts_created = await detectConflicts(admin, campaign_id, campaign.round_number);
    }
    // recon -> conflicts: re-detect in case any recon-based adjustments were made
    if (stage === "recon") {
      conflicts_created = await detectConflicts(admin, campaign_id, campaign.round_number);
    }

    await admin.from("rounds")
      .update({ stage: newStage })
      .eq("campaign_id", campaign_id).eq("round_number", campaign.round_number);

    return json(200, { ok: true, stage: newStage, conflicts_created });

  } catch (e: any) {
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
