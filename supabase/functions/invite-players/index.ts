import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const REDIRECT_URL = "https://40kcampaigngame.fun";

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
    const player_emails: string[] = Array.isArray(body?.player_emails)
      ? body.player_emails
      : [];

    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });
    if (!player_emails.length) return json(400, { ok: false, error: "No emails provided" });

    // Verify the caller is a lead or admin for this campaign
    const { data: mem, error: memErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (memErr) return json(500, { ok: false, error: memErr.message });
    if (!mem || !["lead", "admin"].includes(mem.role)) {
      return json(403, { ok: false, error: "Lead or admin role required" });
    }

    // Fetch campaign name and invite_message for the email body
    const { data: campaign, error: campErr } = await admin
      .from("campaigns")
      .select("name, invite_message")
      .eq("id", campaign_id)
      .single();

    if (campErr || !campaign) {
      return json(404, { ok: false, error: "Campaign not found" });
    }

    const campaignName: string = campaign.name;
    const inviteMessage: string | null = campaign.invite_message ?? null;

    // Normalise emails
    const emails = player_emails
      .map((e) => String(e).trim().toLowerCase())
      .filter(Boolean);

    // Insert pending_invites rows (ignore duplicates)
    const inviteRows = emails.map((email) => ({ campaign_id, email }));
    const { error: invErr } = await admin
      .from("pending_invites")
      .upsert(inviteRows, { onConflict: "campaign_id,email", ignoreDuplicates: true });

    if (invErr) return json(500, { ok: false, error: `Invite insert failed: ${invErr.message}` });

    // Send emails via Supabase Auth (routes through your configured SMTP/Resend)
    // inviteUserByEmail sends a signup+magic-link email to new users.
    // For existing users it returns an error — we catch that and skip gracefully
    // since their pending_invite row is already there and they'll see it on next login.
    const results: { email: string; sent: boolean; reason?: string }[] = [];

    for (const email of emails) {
      try {
        // Build the email body to include in Supabase's "Additional data" field.
        // Note: the actual email template is set in Supabase Auth dashboard.
        // We pass campaign context via redirectTo query params so the template
        // can reference them if configured.
        const redirectTo = `${REDIRECT_URL}?campaign_invite=1`;

        const { error: authErr } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo,
          data: {
            campaign_id,
            campaign_name: campaignName,
            invite_message: inviteMessage ?? "",
          },
        });

        if (authErr) {
          // "User already registered" is not a hard failure — they'll see the
          // invite on their next login via the pending_invites row we inserted.
          const alreadyExists =
            authErr.message.toLowerCase().includes("already") ||
            authErr.message.toLowerCase().includes("registered") ||
            authErr.message.toLowerCase().includes("exists");

          results.push({
            email,
            sent: false,
            reason: alreadyExists ? "existing_user" : authErr.message,
          });
        } else {
          results.push({ email, sent: true });
        }
      } catch (e: any) {
        results.push({ email, sent: false, reason: e?.message ?? "unknown error" });
      }
    }

    const sentCount     = results.filter((r) => r.sent).length;
    const existingCount = results.filter((r) => r.reason === "existing_user").length;
    const failedCount   = results.filter((r) => !r.sent && r.reason !== "existing_user").length;

    console.log(
      `invite-players: campaign=${campaign_id} sent=${sentCount} existing=${existingCount} failed=${failedCount}`
    );

    return json(200, {
      ok: true,
      invited: emails.length,
      sent: sentCount,
      existing_users: existingCount,  // invite row inserted, email not sent — they see it on login
      failed: failedCount,
      results,
    });

  } catch (e: any) {
    console.error("invite-players error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
