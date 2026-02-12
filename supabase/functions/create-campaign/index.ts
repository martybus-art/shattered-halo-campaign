import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ✅ CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  // ✅ Handle preflight (THIS is what fixes "failed to fetch")
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey =
      Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";

    // 🔐 Validate user via bearer token
    const authHeader = req.headers.get("Authorization") ?? "";

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } =
      await userClient.auth.getUser();

    if (userErr || !userData.user) {
      return new Response(
        JSON.stringify({ ok: false, error: "Not authenticated" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const body = await req.json();
    const { template_id, campaign_name, player_emails } = body;

    if (!template_id || !campaign_name) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing fields" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 🛠 Use service role for DB writes
    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Create campaign
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
      return new Response(
        JSON.stringify({ ok: false, error: cErr?.message ?? "Insert failed" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Add creator as lead
    await admin.from("campaign_members").insert({
      campaign_id: campaign.id,
      user_id: userData.user.id,
      role: "lead",
    });

    // Store pending invites
    if (Array.isArray(player_emails)) {
      const invites = player_emails.map((email: string) => ({
        campaign_id: campaign.id,
        email,
      }));

      if (invites.length) {
        await admin.from("pending_invites").insert(invites);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, campaign_id: campaign.id }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message ?? "Server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
