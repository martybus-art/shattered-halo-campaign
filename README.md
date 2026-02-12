# Embers of the Shattered Halo — Campaign App (Production-grade starter)

This repo is a **production-ready starter** for a fog-of-war, multi-player narrative campaign tracker:
- Player dashboards (secret + public info)
- Fog-of-war map (public reveals + private intel)
- Economy (NIP/NCP) with immutable ledger
- Automated round flow (movement → recon → conflicts → mission assignment → results → publish)
- Mission selection with **NIP influence**
- Halo Instability clock + event triggers
- Recap prompt generator for a “Lead Player” (public-safe) + per-player private whisper prompt

## Tech
- **Next.js 14+ (App Router) + TypeScript**
- **Supabase** (Postgres + Auth + RLS + Edge Functions)
- TailwindCSS UI with a grimdark theme

> Hosting: Deploy the web app on **Vercel** (free tier). Use Supabase free tier for backend.

---

## 1) Supabase setup

### Create a Supabase project
- Create a project in Supabase
- In **SQL Editor**, run the migrations in `supabase/migrations` in order.

### Auth
Enable email auth (magic link or password). Recommended: **magic link** for low friction.

### Environment variables
Create `.env.local` in `apps/web`:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   # server-only (do NOT expose in client)
```

Service role key is used only on the server to run privileged workflows (advance round, assign missions, etc.).
Vercel: add these as Environment Variables.

---

## 2) Run locally

```bash
cd apps/web
npm i
npm run dev
```

---

## 3) Deploy
- Push repo to GitHub
- Import `apps/web` into Vercel as the project root (or set Root Directory to `apps/web`)
- Add env vars in Vercel
- Set up Supabase Edge Functions (optional, see `supabase/functions`)

---

## 4) Key product decisions (already implemented)
- **No omniscient GM required**: the system is the arbiter.
- Optional **Admin** (campaign creator) for disputes/emergencies.
- Lead player can generate **PUBLIC** recap prompts (no secrets).
- Players generate **PRIVATE** whisper prompts (only their secrets).

---

## 5) Security model (Fog-of-war)
- RLS prevents players reading other players’ secret location/intel.
- Public map only shows sectors flagged `revealed_public = true`.
- Private intel is stored as `posts` with `visibility='private'` and `audience_user_id`.

---

## Repo layout
- `apps/web/` Next.js app
- `supabase/migrations/` SQL migrations (schema + RLS)
- `supabase/functions/` Edge functions (optional) for automation

---

## Next features you can add safely
- Multiple maps per campaign (moonlets / sub-theatres)
- Image uploads for battle reports
- Discord webhook for bulletins
- Elo-like “threat level” + dynamic bounties
- GM/host “one-click game day” flow that batches 2–3 rounds

## Campaign creation (no-GM friendly)
- Go to `/campaigns` to create campaigns. Any authenticated user can create a campaign and becomes the **Lead**.
- Invitations are stored in `pending_invites`. When an invited player signs in, the app calls the `accept-invites` function to add them automatically.
- Lead controls are at `/lead?campaign=<id>`.
