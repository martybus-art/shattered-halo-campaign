import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const admin = adminClient();
    const body = await req.json().catch(() => ({}));
    const campaign_id: string | undefined = body?.campaign_id;

    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });

    // Verify caller is lead or admin
    const { data: mem, error: memErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (memErr) return json(500, { ok: false, error: memErr.message });
    if (!mem || !["lead", "admin"].includes(mem.role)) {
      return json(403, { ok: false, error: "Lead or admin role required to delete a campaign" });
    }

    // Fetch map_id before deleting campaign so we can clean up the auto-generated map
    const { data: camp } = await admin
      .from("campaigns")
      .select("map_id")
      .eq("id", campaign_id)
      .maybeSingle();

    const map_id = camp?.map_id ?? null;

    // Delete child records in dependency order to avoid FK violations.
    // If the DB has ON DELETE CASCADE on all FK columns this is redundant but safe.
    const tables = [
      "mission_influence",
      "conflicts",
      "rounds",
      "ledger",
      "player_state_secret",
      "player_state",
      "sectors",
      "pending_invites",
      "campaign_members",
    ];

    for (const table of tables) {
      const { error } = await admin
        .from(table)
        .delete()
        .eq("campaign_id", campaign_id);
      if (error) {
        // Log but continue — some tables may not exist or may already be empty
        console.warn(`delete ${table}: ${error.message}`);
      }
    }

    // Delete the campaign itself
    const { error: campErr } = await admin
      .from("campaigns")
      .delete()
      .eq("id", campaign_id);

    if (campErr) return json(500, { ok: false, error: `Campaign delete failed: ${campErr.message}` });

    // Clean up the auto-generated map if one was linked
    if (map_id) {
      await admin.from("maps").delete().eq("id", map_id);
    }

    console.log(`Campaign ${campaign_id} deleted by user ${user.id}`);
    return json(200, { ok: true, deleted: campaign_id });

  } catch (e: any) {
    console.error("delete-campaign error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
