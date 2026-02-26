import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const { userId } = await requireUser(req);
const admin = adminClient();


function d10(): number {
  return Math.floor(Math.random() * 10) + 1;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    

    const body = await req.json().catch(() => ({}));
    const campaignId = body.campaign_id as string;
    if (!campaignId) {
      return new Response(JSON.stringify({ ok: false, error: "campaign_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    

    const { data: mem } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaignId)
      .eq("user_id", userId.id)
      .maybeSingle();

    const role = mem?.role ?? "player";
    if (!(role === "lead" || role === "admin")) {
      return new Response(JSON.stringify({ ok: false, error: "Not authorised" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: c, error: cErr } = await admin
      .from("campaigns")
      .select("id,name,template_id,round_number,instability,phase")
      .eq("id", campaignId)
      .single();

    if (cErr || !c) throw cErr ?? new Error("Campaign not found");

    const newInstability = Math.min(10, (c.instability ?? 0) + 1);

    const { error: upErr } = await admin.from("campaigns").update({ instability: newInstability }).eq("id", campaignId);
    if (upErr) throw upErr;

    const thresholdBand = newInstability >= 8 ? 8 : newInstability >= 4 ? 4 : 0;
    const roll = d10();

    const { data: ev } = await admin
      .from("instability_events")
      .select("name,public_text,effect_json")
      .eq("template_id", c.template_id)
      .eq("threshold_min", thresholdBand)
      .eq("d10", roll)
      .eq("is_active", true)
      .maybeSingle();

    const eventName = ev?.name ?? "Unlogged Disturbance";
    const publicText = ev?.public_text ??
      "The Halo shudders. Vox returns are inconsistent. Something changes, though no one agrees how.";
    const effect = ev?.effect_json ?? {};

    await admin.from("campaign_events").insert({
      campaign_id: campaignId,
      round_number: c.round_number,
      instability_after: newInstability,
      event_name: eventName,
      event_roll: roll,
      visibility: "public",
      effect_json: effect,
    });

    await admin.from("posts").insert({
      campaign_id: campaignId,
      round_number: c.round_number,
      visibility: "public",
      title: `Halo Instability: ${eventName}`,
      body: `${publicText}\n\n(Instability now ${newInstability}/10.)`,
      tags: ["instability", `t${thresholdBand}`, `d10_${roll}`],
      created_by: userId.id,
    });

    let phase = c.phase ?? 1;
    if (newInstability >= 8) phase = Math.max(phase, 3);
    else if (newInstability >= 4) phase = Math.max(phase, 2);

    if (phase !== (c.phase ?? 1)) {
      await admin.from("campaigns").update({ phase }).eq("id", campaignId);
      await admin.from("posts").insert({
        campaign_id: campaignId,
        round_number: c.round_number,
        visibility: "public",
        title: `Phase Shift: Phase ${phase}`,
        body: phase === 2
          ? "The Halo's war becomes overt. Relics flare. Retreat becomes a luxury no one can afford."
          : "Collapse approaches. The Halo itself begins to choose who may live long enough to flee.",
        tags: ["phase", `phase_${phase}`],
        created_by: userId.id,
      });
    }

    return new Response(JSON.stringify({ ok: true, instability: newInstability, thresholdBand, roll, eventName }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
