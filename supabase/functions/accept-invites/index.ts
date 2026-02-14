import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey =
      Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";

    const authHeader = req.headers.get("Authorization") ?? "";
    
    // Extract the token from the Authorization header
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      console.error("No token provided");
      return new Response(JSON.stringify({ ok: false, error: "No token provided" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create client and validate user with the token
    const userClient = createClient(supabaseUrl, anonKey);

    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    
    if (userErr || !userData.user) {
      console.error("User validation error:", userErr?.message);
      return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Find pending invites for this user's email
    const email = (userData.user.email ?? "").toLowerCase();
    if (!email) {
      return new Response(JSON.stringify({ ok: false, error: "User has no email" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: invites, error: invErr } = await admin
      .from("pending_invites")
      .select("id,campaign_id")
      .ilike("email", email);

    if (invErr) {
      console.error("Invite fetch error:", invErr.message);
      return new Response(JSON.stringify({ ok: false, error: invErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rows = invites ?? [];
    if (!rows.length) {
      return new Response(JSON.stringify({ ok: true, accepted: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Insert membership rows (ignore duplicates)
    const inserts = rows.map((r) => ({
      campaign_id: r.campaign_id,
      user_id: userData.user.id,
      role: "player",
    }));

    const { error: insertErr } = await admin.from("campaign_members").insert(inserts);
    
    if (insertErr) {
      console.error("Insert error:", insertErr.message);
      // Don't fail on duplicate key errors - this is expected
      if (!insertErr.message.includes("duplicate") && !insertErr.message.includes("unique")) {
        return new Response(JSON.stringify({ ok: false, error: insertErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Delete invites after acceptance
    const inviteIds = rows.map((r) => r.id);
    await admin.from("pending_invites").delete().in("id", inviteIds);

    console.log(`Accepted ${rows.length} invites for user ${userData.user.id}`);
    return new Response(JSON.stringify({ ok: true, accepted: rows.length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("Unexpected error:", e?.message ?? "Server error");
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
