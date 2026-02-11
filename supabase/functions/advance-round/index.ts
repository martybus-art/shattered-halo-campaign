import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type Json = Record<string, unknown>;

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { campaign_id } = (await req.json()) as { campaign_id: string };

    // Fetch campaign + current round stage
    const { data: campaign, error: cErr } = await supabase
      .from("campaigns")
      .select("id, template_id, round_number, phase, instability, status")
      .eq("id", campaign_id)
      .single();
    if (cErr) throw cErr;

    if (campaign.status !== "active") {
      return new Response(JSON.stringify({ ok: false, error: "Campaign not active" }), { status: 400 });
    }

    const { data: round, error: rErr } = await supabase
      .from("rounds")
      .select("stage")
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number)
      .maybeSingle();
    if (rErr) throw rErr;

    const stage = round?.stage ?? "movement";

    const nextStage = (s: string) => {
      const order = ["movement", "recon", "conflicts", "missions", "results", "spend", "publish"];
      const idx = order.indexOf(s);
      return idx === -1 ? "movement" : order[Math.min(idx + 1, order.length - 1)];
    };

    const newStage = nextStage(stage);

    // Ensure round record exists
    if (!round) {
      await supabase.from("rounds").insert({ campaign_id, round_number: campaign.round_number, stage: "movement" });
      return new Response(JSON.stringify({ ok: true, stage: "movement" }), { status: 200 });
    }

    // If we are moving from publish -> new round
    if (stage === "publish") {
      // close current round
      await supabase.from("rounds").update({ stage: "closed", closed_at: new Date().toISOString() })
        .eq("campaign_id", campaign_id).eq("round_number", campaign.round_number);

      const nextRound = campaign.round_number + 1;

      await supabase.from("campaigns").update({ round_number: nextRound }).eq("id", campaign_id);

      await supabase.from("rounds").insert({ campaign_id, round_number: nextRound, stage: "movement" });

      return new Response(JSON.stringify({ ok: true, stage: "movement", round_number: nextRound }), { status: 200 });
    }

    // Otherwise just advance stage
    await supabase.from("rounds").update({ stage: newStage })
      .eq("campaign_id", campaign_id).eq("round_number", campaign.round_number);

    return new Response(JSON.stringify({ ok: true, stage: newStage }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
});
