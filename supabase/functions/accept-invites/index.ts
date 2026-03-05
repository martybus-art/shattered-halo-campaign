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

    // Fetch latest auth user (fresh metadata, not token snapshot)
    const { data: fresh, error: freshErr } = await admin.auth.admin.getUserById(user.id);
    if (freshErr) return json(500, { ok: false, error: freshErr.message });

    const displayName = (fresh.user?.user_metadata?.display_name as string | undefined)?.trim() || null;
   
    const fallbackName = displayName ?? (user.email ? user.email.split("@")[0] : null) ?? "Commander";

    // Parse optional mode from body — defaults to "list"
    const body = await req.json().catch(() => ({}));
    const mode: string = body?.mode ?? "list";
    const invite_id: string | null = body?.invite_id ?? null;

    // ── LIST ─────────────────────────────────────────────────────────────────
    // Returns all pending invites for this user with campaign names attached
    if (mode === "list") {
      const { data: invites, error: invErr } = await admin
        .from("pending_invites")
        .select("id, campaign_id, email")
        .ilike("email", email);

      if (invErr) return json(500, { ok: false, error: invErr.message });

      if (!invites?.length) return json(200, { ok: true, invites: [] });

      // Fetch campaign names in one query
      const campaignIds = invites.map((i: any) => i.campaign_id);
      const { data: campaigns, error: cErr } = await admin
        .from("campaigns")
        .select("id, name, invite_message")
        .in("id", campaignIds);

      if (cErr) return json(500, { ok: false, error: cErr.message });

      const nameById: Record<string, string> = {};
      const messageById: Record<string, string | null> = {};
      (campaigns ?? []).forEach((c: any) => {
        nameById[c.id] = c.name;
        messageById[c.id] = c.invite_message ?? null;
      });

      const enriched = invites.map((i: any) => ({
        id: i.id,
        campaign_id: i.campaign_id,
        campaign_name: nameById[i.campaign_id] ?? i.campaign_id,
        invite_message: messageById[i.campaign_id] ?? null,
      }));

      return json(200, { ok: true, invites: enriched });
    }

    // ── ACCEPT ───────────────────────────────────────────────────────────────
    // Accepts one specific invite — creates campaign_members row then deletes invite
    if (mode === "accept") {
      if (!invite_id) return json(400, { ok: false, error: "invite_id required" });

      // Fetch and verify the invite belongs to this user's email
      const { data: invite, error: fetchErr } = await admin
        .from("pending_invites")
        .select("id, campaign_id, email")
        .eq("id", invite_id)
        .ilike("email", email)
        .single();

      if (fetchErr || !invite) {
        return json(404, { ok: false, error: "Invite not found or does not belong to your account" });
      }

      // Insert campaign membership
      const { error: upsertErr } = await admin
        .from("campaign_members")
        .upsert({ campaign_id: invite.campaign_id, user_id: user.id, role: "player", commander_name: fallbackName});

      if (upsertErr) {
        // Ignore duplicate — already a member, still clean up the invite below
        if (!upsertErr.message.includes("duplicate") && !upsertErr.message.includes("unique")) {
          return json(500, { ok: false, error: upsertErr.message });
        }
      }

      // Delete the accepted invite
      await admin.from("pending_invites").delete().eq("id", invite_id);

      return json(200, { ok: true, accepted: 1, campaign_id: invite.campaign_id });
    }

    // ── DECLINE ──────────────────────────────────────────────────────────────
    // Declines one specific invite — deletes it without creating membership
    if (mode === "decline") {
      if (!invite_id) return json(400, { ok: false, error: "invite_id required" });

      // Verify invite belongs to this user's email before deleting
      const { data: invite, error: fetchErr } = await admin
        .from("pending_invites")
        .select("id, email")
        .eq("id", invite_id)
        .ilike("email", email)
        .single();

      if (fetchErr || !invite) {
        return json(404, { ok: false, error: "Invite not found or does not belong to your account" });
      }

      await admin.from("pending_invites").delete().eq("id", invite_id);

      return json(200, { ok: true, declined: 1 });
    }

    return json(400, {
      ok: false,
      error: `Unknown mode "${mode}". Valid modes: list, accept, decline.`,
    });

  } catch (e: any) {
    console.error("Unexpected error:", e?.message ?? "Server error");
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
