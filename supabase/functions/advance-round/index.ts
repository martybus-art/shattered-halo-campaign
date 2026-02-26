import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AdvanceReq = { campaign_id: string };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const { userId } = await requireUser(req);
  const admin = adminClient();

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { campaign_id } = (await req.json()) as AdvanceReq;
    if (!campaign_id) {
      return new Response(JSON.stringify({ ok: false, error: "Missing campaign_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: member, error: mErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", userId.id)
      .maybeSingle();

    if (mErr) {
      return new Response(JSON.stringify({ ok: false, error: mErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const role = member?.role ?? "";
    if (role !== "lead" && role !== "admin") {
      return new Response(JSON.stringify({ ok: false, error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: campaign, error: cErr } = await admin
      .from("campaigns")
      .select("id, round_number, status")
      .eq("id", campaign_id)
      .single();

    if (cErr || !campaign) {
      return new Response(JSON.stringify({ ok: false, error: cErr?.message ?? "Campaign not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (campaign.status !== "active") {
      return new Response(JSON.stringify({ ok: false, error: "Campaign not active" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: round, error: rErr } = await admin
      .from("rounds")
      .select("stage")
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number)
      .maybeSingle();

    if (rErr) {
      return new Response(JSON.stringify({ ok: false, error: rErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stage = round?.stage ?? "movement";

    const nextStage = (s: string) => {
      const order = ["movement", "recon", "conflicts", "missions", "results", "spend", "publish"];
      const idx = order.indexOf(s);
      return idx === -1 ? "movement" : order[Math.min(idx + 1, order.length - 1)];
    };

    if (!round) {
      await admin.from("rounds").insert({ campaign_id, round_number: campaign.round_number, stage: "movement" });
      return new Response(JSON.stringify({ ok: true, stage: "movement" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

      return new Response(JSON.stringify({ ok: true, stage: "movement", round_number: nextRound }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const newStage = nextStage(stage);

    await admin
      .from("rounds")
      .update({ stage: newStage })
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number);

    return new Response(JSON.stringify({ ok: true, stage: newStage }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
