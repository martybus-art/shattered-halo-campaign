import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  console.log("=== REQUEST RECEIVED ===");
  console.log("Method:", req.method);
  console.log("URL:", req.url);
  
  if (req.method === "OPTIONS") {
    console.log("Handling OPTIONS preflight");
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("=== ENVIRONMENT CHECK ===");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    console.log("SUPABASE_URL exists:", !!supabaseUrl);
    console.log("ANON_KEY exists:", !!anonKey);
    console.log("SERVICE_ROLE_KEY exists:", !!serviceRoleKey);

    console.log("=== HEADERS CHECK ===");
    const authHeader = req.headers.get("Authorization");
    const apikeyHeader = req.headers.get("apikey");
    
    console.log("Authorization header exists:", !!authHeader);
    console.log("Authorization preview:", authHeader?.substring(0, 30));
    console.log("apikey header exists:", !!apikeyHeader);

    if (!authHeader) {
      console.error("❌ No Authorization header");
      return new Response(JSON.stringify({ ok: false, error: "No Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("=== CREATING CLIENT ===");
    const supabaseClient = createClient(
      supabaseUrl ?? "",
      anonKey ?? "",
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

    console.log("=== GETTING USER ===");
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    console.log("User fetch error:", userError?.message);
    console.log("User exists:", !!user);
    console.log("User email:", user?.email);

    if (!user) {
      console.error("❌ No user found");
      return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("=== CREATING ADMIN CLIENT ===");
    const supabaseAdmin = createClient(
      supabaseUrl ?? "",
      serviceRoleKey ?? ""
    );

    const email = (user.email ?? "").toLowerCase();
    if (!email) {
      console.error("❌ User has no email");
      return new Response(JSON.stringify({ ok: false, error: "User has no email" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("=== FETCHING INVITES ===");
    console.log("Looking for email:", email);
    
    const { data: invites, error: invErr } = await supabaseAdmin
      .from("pending_invites")
      .select("id,campaign_id")
      .ilike("email", email);

    if (invErr) {
      console.error("❌ Invite fetch error:", invErr.message);
      return new Response(JSON.stringify({ ok: false, error: invErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rows = invites ?? [];
    console.log("Found invites:", rows.length);
    
    if (!rows.length) {
      console.log("✅ No invites to accept");
      return new Response(JSON.stringify({ ok: true, accepted: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("=== INSERTING MEMBERSHIPS ===");
    const inserts = rows.map((r) => ({
      campaign_id: r.campaign_id,
      user_id: user.id,
      role: "player",
    }));

    const { error: insertErr } = await supabaseAdmin.from("campaign_members").insert(inserts);

    if (insertErr) {
      console.error("Insert error:", insertErr.message);
      if (!insertErr.message.includes("duplicate") && !insertErr.message.includes("unique")) {
        return new Response(JSON.stringify({ ok: false, error: insertErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.log("⚠️ Duplicate insert (expected, continuing)");
    }

    console.log("=== DELETING INVITES ===");
    const inviteIds = rows.map((r) => r.id);
    await supabaseAdmin.from("pending_invites").delete().in("id", inviteIds);

    console.log(`✅ SUCCESS: Accepted ${rows.length} invites for user ${user.id}`);
    return new Response(JSON.stringify({ ok: true, accepted: rows.length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("❌ UNEXPECTED ERROR:", e?.message ?? "Server error");
    console.error("Error stack:", e?.stack);
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
