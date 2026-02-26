import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Not authenticated" });
    const user = result.user;

    if (!user.email) return json(400, { ok: false, error: "User has no email" });

    const admin = adminClient();
    const email = user.email.toLowerCase();

    const { data: invites, error: invErr } = await admin
      .from("pending_invites")
      .select("id,campaign_id")
      .ilike("email", email);

    if (invErr) {
      console.error("Invite fetch error:", invErr.message);
      return json(500, { ok: false, error: invErr.message });
    }

    const rows = invites ?? [];
    if (!rows.length) return json(200, { ok: true, accepted: 0 });

    const inserts = rows.map((r) => ({
      campaign_id: r.campaign_id,
      user_id: user.id,
      role: "player",
    }));

    const { error: insertErr } = await admin.from("campaign_members").insert(inserts);

    if (insertErr) {
      console.error("Insert error:", insertErr.message);
      if (!insertErr.message.includes("duplicate") && !insertErr.message.includes("unique")) {
        return json(500, { ok: false, error: insertErr.message });
      }
    }

    const inviteIds = rows.map((r) => r.id);
    await admin.from("pending_invites").delete().in("id", inviteIds);

    console.log(`Accepted ${rows.length} invites for user ${user.id}`);
    return json(200, { ok: true, accepted: rows.length });

  } catch (e: any) {
    console.error("Unexpected error:", e?.message ?? "Server error");
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});