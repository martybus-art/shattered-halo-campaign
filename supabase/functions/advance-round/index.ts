import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

type AdvanceReq = { campaign_id: string };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  
  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const result = await requireUser(req);
    if (!result?.user) {
      return json(401, { ok: false, error: "Unauthorised" });
    }
const user = result.user;

    const admin = adminClient();

    const { campaign_id } = (await req.json()) as AdvanceReq;
    if (!campaign_id) {
      return json(400, { ok: false, error: "Missing campaign_id" });
    }

    const { data: member, error: mErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (mErr) {
      return json(500, { ok: false, error: mErr.message });
    }

    const role = member?.role ?? "";
    if (role !== "lead" && role !== "admin") {
      return json(403, { ok: false, error: "Forbidden" });
    }

    const { data: campaign, error: cErr } = await admin
      .from("campaigns")
      .select("id, round_number, status")
      .eq("id", campaign_id)
      .single();

    if (cErr || !campaign) {
      return json(404, { ok: false, error: cErr?.message ?? "Campaign not found" });
    }

    if (campaign.status !== "active") {
      return json(400, { ok: false, error: "Campaign not active" });
    }

    const { data: round, error: rErr } = await admin
      .from("rounds")
      .select("stage")
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number)
      .maybeSingle();

    if (rErr) {
      return json(500, { ok: false, error: rErr.message });
    }

    const stage = round?.stage ?? "movement";

    const nextStage = (s: string) => {
      const order = ["movement", "recon", "conflicts", "missions", "results", "spend", "publish"];
      const idx = order.indexOf(s);
      return idx === -1 ? "movement" : order[Math.min(idx + 1, order.length - 1)];
    };

    if (!round) {
      await admin.from("rounds").insert({ campaign_id, round_number: campaign.round_number, stage: "movement" });
      return json(200, { ok: true, stage: "movement" });
    }

    if (stage === "publish") {
      await admin
        .from("rounds")
        .update({ stage: "closed", closed_at: new Date().toISOString() })
        .eq("campaign_id", campaign_id)
        .eq("round_number", campaign.round_number);

      const nextRound = campaign.round_number + 1;
      await admin.from("campaigns").update({ round_number: nextRound }).eq("id", campaign_id);
      await admin.from("rounds").insert({ campaign_id, round_number: nextRound, stage: "movement" });

      return json(200, { ok: true, stage: "movement", round_number: nextRound });
    }

    const newStage = nextStage(stage);

    await admin
      .from("rounds")
      .update({ stage: newStage })
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number);

    return json(200, { ok: true, stage: newStage });
  } 
  catch (e: any) {
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
