import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json, requireUser, adminClient } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  // ✅ correct auth pattern
  const result = await requireUser(req);
  if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
  const user = result.user;

  const admin = adminClient();
  const body = await req.json().catch(() => ({}));
  const campaign_id = body?.campaign_id;

  if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });

  const { data: mem, error: mErr } = await admin
    .from("campaign_members")
    .select("campaign_id")
    .eq("campaign_id", campaign_id)
    .eq("user_id", user.id)          // ✅ user.id
    .maybeSingle();

  if (mErr) return json(500, { ok: false, error: "Membership lookup failed", details: mErr.message });
  if (!mem) return json(403, { ok: false, error: "Not a campaign member" });

  const { data: existing, error: eErr } = await admin
    .from("player_state")
    .select("*")
    .eq("campaign_id", campaign_id)
    .eq("user_id", user.id)          // ✅ user.id
    .maybeSingle();

  if (eErr) return json(500, { ok: false, error: "player_state lookup failed", details: eErr.message });
  if (existing) return json(200, { ok: true, created: false, player_state: existing });

  const { data: inserted, error: iErr } = await admin
    .from("player_state")
    .insert({
      campaign_id,
      user_id: user.id,              // ✅ user.id
      nip: 0,
      ncp: 0,
      narrative_points: 0,
      current_zone_key: "unknown",
      current_sector_key: "unknown", // or "unknown" if you have a NOT NULL there too
      public_location: "Unknown",
    })
    .select("*")
    .single();

  if (iErr) return json(500, { ok: false, error: "player_state insert failed", details: iErr.message });

  return json(200, { ok: true, created: true, player_state: inserted });
});