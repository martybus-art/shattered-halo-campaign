import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getAuthenticatedUser, getServiceRoleKey, getSupabaseUrl } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, error: userErr } = await getAuthenticatedUser(req);

    if (userErr || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { template_id, campaign_name, player_emails } = body;

    if (!template_id || !campaign_name) {
      return new Response(JSON.stringify({ ok: false, error: "Missing fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(getSupabaseUrl(), getServiceRoleKey());

    const { data: campaign, error: cErr } = await admin
      .from("campaigns")
      .insert({
        template_id,
        name: campaign_name,
        phase: 1,
        round_number: 1,
        instability: 0,
      })
      .select()
      .single();

    if (cErr || !campaign) {
      return new Response(JSON.stringify({ ok: false, error: cErr?.message ?? "Insert failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.from("campaign_members").insert({
      campaign_id: campaign.id,
      user_id: user.id,
      role: "lead",
    });

    if (Array.isArray(player_emails)) {
      const invites = player_emails.map((email: string) => ({
        campaign_id: campaign.id,
        email,
      }));

      if (invites.length) {
        await admin.from("pending_invites").insert(invites);
      }
    }

    return new Response(JSON.stringify({ ok: true, campaign_id: campaign.id }), {
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
