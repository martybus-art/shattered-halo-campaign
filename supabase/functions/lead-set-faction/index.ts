import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json, requireUser, adminClient } from "../_shared/utils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const user = await requireUser(req);
  if (!user) return json(401, { ok: false, error: "Unauthorized" });

  const admin = adminClient();
  const body = await req.json().catch(() => ({}));

  const campaign_id = body?.campaign_id;
  const target_user_id = body?.target_user_id;
  const faction_key = body?.faction_key ?? null; // null means reset

  if (!campaign_id || !target_user_id) return json(400, { ok: false, error: "Missing campaign_id or target_user_id" });

  // Verify caller role
  const { data: caller, error: cErr } = await admin
    .from("campaign_members")
    .select("role")
    .eq("campaign_id", campaign_id)
    .eq("user_id", user.userId)
    .maybeSingle();

  if (cErr) return json(500, { ok: false, error: "Role lookup failed", details: cErr.message });
  if (!caller || (caller.role !== "lead" && caller.role !== "admin")) {
    return json(403, { ok: false, error: "Lead/Admin only" });
  }

  const patch: any = {};
  if (faction_key === null) {
    patch.faction_key = null;
    patch.faction_name = null;
    patch.faction_locked = false;
    patch.faction_set_at = null;
  } else {
    patch.faction_key = String(faction_key);
    patch.faction_name = String(body?.faction_name ?? "");
    patch.faction_locked = true;
    patch.faction_set_at = new Date().toISOString();
  }

  const { error: uErr } = await admin
    .from("campaign_members")
    .update(patch)
    .eq("campaign_id", campaign_id)
    .eq("user_id", target_user_id);

  if (uErr) return json(500, { ok: false, error: "Update failed", details: uErr.message });

  return json(200, { ok: true });
});
