## §10 — Invite & Email System

### Overview

Two distinct email flows handle player recruitment. Both use Supabase Auth as the delivery mechanism and are styled with the Shattered Halo grimdark brand (void black background, brass/gold accents, serif typography).

---

### Flow 1 — New Player Invite (Supabase "Invite User" template)

**Trigger:** Lead or admin enters an email address that is not yet registered in the system.

**Mechanism:** `invite-players` edge function calls `admin.auth.admin.inviteUserByEmail(email, { redirectTo, data })`.

**What happens:**
1. A `pending_invites` row is inserted for `(campaign_id, email)`.
2. Supabase Auth sends the **Invite User** email template (branded HTML, see below).
3. The email contains a one-time link. When clicked, the account is created and the player is signed in.
4. They land at `https://40kcampaigngame.fun?campaign_invite=1`.
5. The profile page detects the URL param, scrolls to the Campaign Invites card, and highlights it.
6. The player clicks **Accept** — `accept-invites` edge function joins them to the campaign.

**Email data payload** (accessible via `{{ .Data.* }}` in the template):

| Key | Source |
|-----|--------|
| `campaign_id` | campaigns.id |
| `campaign_name` | campaigns.name |
| `invite_message` | campaigns.invite_message |
| `campaign_narrative` | campaigns.campaign_narrative |

---

### Flow 2 — Existing Player Campaign Invite (Supabase "Magic Link" template)

**Trigger:** Lead or admin enters an email address that already belongs to a registered user.

**Mechanism:** `inviteUserByEmail` returns an "already exists" error. The function falls back to POSTing to `/auth/v1/otp` with `create_user: false`.

**What happens:**
1. A `pending_invites` row is inserted (or already exists — upserted with `ignoreDuplicates`).
2. Supabase Auth sends the **Magic Link** email template (branded HTML with campaign narrative content).
3. The link signs the player in and redirects to `https://40kcampaigngame.fun?campaign_invite=1`.
4. Same profile-page highlight flow as above.

**Same email data payload** — campaign name and narrative are included in the magic link email.

---

### Supabase Auth Template Configuration

Both templates must be set manually in **Supabase Dashboard → Authentication → Email Templates**.

| Template slot | File to use | When it fires |
|---|---|---|
| **Invite User** | `email-template-invite-user.html` | New user invite |
| **Magic Link** | `email-template-magic-link.html` | Existing user campaign invite AND regular login magic links |

> **Note:** The Magic Link template is shared between campaign invites and regular sign-in magic links. It uses `{{ if .Data.campaign_name }}` to conditionally show campaign-specific content. If no campaign data is present (a standard login), it renders a clean "Secure Access Link" variant.

**Template variables used:**

| Variable | Meaning |
|---|---|
| `{{ .ConfirmationURL }}` | The one-time auth link (Supabase built-in) |
| `{{ .Email }}` | Recipient email address (Supabase built-in) |
| `{{ .Data.campaign_name }}` | Campaign name from DB |
| `{{ .Data.campaign_narrative }}` | Campaign narrative flavour text |
| `{{ .Data.invite_message }}` | Personal message from the lead |

---

### Profile Page Auto-Join Behaviour

When a player clicks an invite email link, they land at the app with `?campaign_invite=1` in the URL. `home-page.tsx` has a `useEffect` that fires when `userId` is set and this param is present:

1. Waits 800ms for `loadInvites()` to complete.
2. Calls `invitesPanelRef.current.scrollIntoView()` to bring the invites card into view.
3. Sets `inviteHighlight = true` — renders a brass-coloured banner above the invite list.
4. Cleans the URL param with `window.history.replaceState`.
5. Clears the highlight after 3 seconds.

---

### Edge Function: `invite-players`

| Mode | Trigger | Auth required |
|---|---|---|
| `list_users` | Lead invite UI needs registered users list | Any authenticated user |
| `invite` (default) | Send invite emails | Lead or admin role only |

**Key logic:**
- `inviteUserByEmail` is attempted for every address.
- "already exists" error → OTP fallback for existing users.
- `pending_invites` row always inserted regardless of email success (players see invite on next login even if email fails).
- Both paths pass the same `emailData` object: `{ campaign_id, campaign_name, invite_message, campaign_narrative }`.

**Deploy:**
```bash
supabase functions deploy invite-players --project-ref yzqzlajmehzilxfruskq
```
