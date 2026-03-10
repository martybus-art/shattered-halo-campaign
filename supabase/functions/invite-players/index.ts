// supabase/functions/invite-players/index.ts
//
// changelog:
//   2026-03-09 — FEATURE: Pass campaign_narrative in email data payload so
//                both Supabase Auth email templates (Invite User + Magic Link)
//                can render branded narrative content. Both inviteUserByEmail
//                and the OTP fallback for existing users now include
//                campaign_narrative alongside campaign_id, campaign_name,
//                and invite_message.

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
    const mode: string = body?.mode ?? "invite";

    // ── LIST USERS ────────────────────────────────────────────────────────────
    // Returns all registered users (except the caller) for the quick-add UI.
    // Any authenticated user can call this — no campaign_id required.
    if (mode === "list_users") {
      const { data: usersData, error: usersErr } = await admin.auth.admin.listUsers({ perPage: 500 });
      if (usersErr) return json(500, { ok: false, error: usersErr.message });

      const users = (usersData?.users ?? [])
        .filter((u) => u.id !== user.id && u.email)
        .map((u) => ({
          id: u.id,
          email: u.email!,
          display_name: (u.user_metadata?.display_name as string | null) ?? null,
        }))
        .sort((a, b) => (a.display_name ?? a.email).localeCompare(b.display_name ?? b.email));

      return json(200, { ok: true, users });
    }

    // ── INVITE (default) ──────────────────────────────────────────────────────
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

    // Fetch campaign name, invite_message, and campaign_narrative for the email body
    const { data: campaign, error: campErr } = await admin
      .from("campaigns")
      .select("name, invite_message, campaign_narrative")
      .eq("id", campaign_id)
      .single();

    if (campErr || !campaign) {
      return json(404, { ok: false, error: "Campaign not found" });
    }

    const campaignName:      string      = campaign.name;
    const inviteMessage:     string|null = campaign.invite_message ?? null;
    const campaignNarrative: string|null = campaign.campaign_narrative ?? null;

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

    // Build the shared email data payload — passed to both new-user and existing-user paths.
    // The Supabase Auth email templates reference these via {{ .Data.* }} syntax.
    const emailData = {
      campaign_id,
      campaign_name:      campaignName,
      invite_message:     inviteMessage     ?? "",
      campaign_narrative: campaignNarrative ?? "",
    };

    // ── Email Testing─────────────────────────────────────────────────────
    // 
    // This is testing the email send items
    
      console.log("invite-players body.campaign_id =", campaign_id);
      console.log("invite-players campaign row =", JSON.stringify(campaign));
      console.log("invite-players emailData =", JSON.stringify(emailData));

    // ── Send emails ──────────────────────────────────────────────────────────
    // NEW USERS:      inviteUserByEmail → sends Supabase "Invite User" template.
    //                 The OTP in that template registers the account and signs
    //                 them in — they land at REDIRECT_URL and see their invite
    //                 on the profile page.
    //
    // EXISTING USERS: inviteUserByEmail returns an error. We fall back to a
    //                 magic-link OTP via /auth/v1/otp — sends the "Magic Link"
    //                 template. On click they are signed in and land on the
    //                 profile page where their pending_invite is waiting.
    const results: { email: string; sent: boolean; reason?: string }[] = [];

    for (const email of emails) {
      try {
        const redirectTo = `${REDIRECT_URL}?campaign_invite=1`;

        const { error: authErr } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo,
          data: emailData,
        });

        if (authErr) {
          const alreadyExists =
            authErr.message.toLowerCase().includes("already") ||
            authErr.message.toLowerCase().includes("registered") ||
            authErr.message.toLowerCase().includes("exists");

          if (alreadyExists) {
            // Existing user — send a magic-link OTP so they get the branded campaign email
            try {
              const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
              const serviceKey  = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
              const otpRes = await fetch(`${supabaseUrl}/auth/v1/otp`, {
                method:  "POST",
                headers: {
                  "Content-Type":  "application/json",
                  "apikey":        serviceKey,
                  "Authorization": `Bearer ${serviceKey}`,
                },
                body: JSON.stringify({
                  email,
                  create_user: false,
                  options: {
                    redirectTo,
                    data: emailData,
                  },
                }),
              });
              const otpOk = otpRes.ok || otpRes.status === 200;
              results.push({
                email,
                sent:   otpOk,
                reason: otpOk ? undefined : "existing_user_otp_failed",
              });
            } catch {
              // OTP send failed — pending_invite row still exists; player sees it on next login
              results.push({ email, sent: false, reason: "existing_user_otp_failed" });
            }
          } else {
            results.push({ email, sent: false, reason: authErr.message });
          }
        } else {
          results.push({ email, sent: true });
        }
      } catch (e: any) {
        results.push({ email, sent: false, reason: e?.message ?? "unknown error" });
      }
    }

    const sentCount     = results.filter((r) => r.sent).length;
    const existingCount = results.filter((r) => r.reason === "existing_user_otp_failed").length;
    const failedCount   = results.filter((r) => !r.sent && r.reason !== "existing_user_otp_failed").length;

    console.log(
      `invite-players: campaign=${campaign_id} sent=${sentCount} existing=${existingCount} failed=${failedCount}`
    );

    return json(200, {
      ok:             true,
      invited:        emails.length,
      sent:           sentCount,
      existing_users: existingCount,
      failed:         failedCount,
      results,
    });

  } catch (e: any) {
    console.error("invite-players error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
