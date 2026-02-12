import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ZONES = [
  "vault_ruins",
  "ash_wastes",
  "halo_spire",
  "sunken_manufactorum",
  "warp_scar_basin",
  "obsidian_fields",
  "signal_crater",
  "xenos_forest",
] as const;

const SECTORS = ["A1", "A2", "B1", "B2"] as const;

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: uErr } = await userClient.auth.getUser();
    if (uErr || !userData.user) {
      return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), { status: 401 });
    }

    const user = userData.user;
    const email = (user.email ?? "").toLowerCase().trim();
    if (!email) {
      return new Response(JSON.stringify({ ok: false, error: "No email on user" }), { status: 400 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: invites, error: iErr } = await admin
      .from("pending_invites")
      .select("id,campaign_id,role")
      .eq("email", email);

    if (iErr) throw iErr;
    if (!invites || invites.length === 0) {
      return new Response(JSON.stringify({ ok: true, accepted: 0 }), { status: 200 });
    }

    let accepted = 0;

    for (const inv of invites) {
      const { data: existing } = await admin
        .from("campaign_members")
        .select("role")
        .eq("campaign_id", inv.campaign_id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (!existing) {
        await admin.from("campaign_members").insert({
          campaign_id: inv.campaign_id,
          user_id: user.id,
          role: inv.role ?? "player",
        });
      }

      const { data: ps } = await admin
        .from("player_state")
        .select("campaign_id")
        .eq("campaign_id", inv.campaign_id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (!ps) {
        const slot = { z: pickOne([...ZONES]), s: pickOne([...SECTORS]) };
        await admin.from("player_state").insert({
          campaign_id: inv.campaign_id,
          user_id: user.id,
          current_zone_key: slot.z,
          current_sector_key: slot.s,
          nip: 3,
          ncp: 0,
          status: "newcomer",
          last_active_at: new Date().toISOString(),
        });
      }

      await admin.from("pending_invites").delete().eq("id", inv.id);
      accepted += 1;
    }

    return new Response(JSON.stringify({ ok: true, accepted }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
});
