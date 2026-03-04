# 40K Campaign Console — Campaign App

A full-featured digital campaign manager for Warhammer 40,000 narrative campaigns. Automates round flow, NIP/NCP economy, instability events, mission assignment, fog-of-war, and AI-generated maps — removing the manual admin burden from campaign play.

**Live:** [shattered-halo-campaign.vercel.app](https://shattered-halo-campaign.vercel.app)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js (App Router) + TypeScript |
| Backend / DB | Supabase (Postgres + Auth + RLS + Edge Functions) |
| Styling | TailwindCSS (grimdark theme) |
| AI Map Generation | OpenAI `gpt-image-1` |
| Hosting | Vercel |
| Version Control | GitHub |

---

## Repo Layout

```
/
├── apps/web/                    # Next.js application
│   └── src/
│       ├── app/                 # App Router pages & API routes
│       └── components/          # React components (Card-based UI)
├── supabase/
│   ├── functions/               # Edge Functions (Deno/TypeScript)
│   └── migrations/              # SQL migrations (run in order)
├── README.md
└── REFERENCE.md
```

---

## 1) Supabase Setup

### Create project

Create a project at [supabase.com](https://supabase.com). Note the project URL and keys.

### Run migrations

In the **SQL Editor**, run all files in `supabase/migrations/` in numbered order:

| File | Purpose |
|---|---|
| `001_initial_schema.sql` | Core tables: campaigns, campaign_members, player_state, ledger, rounds |
| `002_game_objects.sql` | missions, moves, recon_ops, conflicts, battle_results, posts, pending_invites |
| `003_templates.sql` | templates, sectors |
| `004_relics_instability.sql` | relics, campaign_relics, instability_events, campaign_events |
| `005_rulesets_maps.sql` | rulesets, maps |
| `006_extended_tables.sql` | mission_influence, round_spends, player_state_secret |
| `007_faction_fields.sql` | faction_key, faction_locked, faction_set_at on campaign_members |
| `008_map_ai_fields.sql` | AI generation fields on maps (seed, layout, planet_profile, generation_status, etc.) |
| `009_campaign_extras.sql` | invite_message on campaigns, ruleset_id FK |

> **Seed data:** After migrations, run `supabase/seed/seed_evolution_pack.sql` to populate the 20 missions, 30 instability events, and 2 rulesets.

### Auth

Email auth with **magic link** is the recommended setup (low friction for players).

### Environment Variables

Create `apps/web/.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable key>
SUPABASE_SERVICE_ROLE_KEY=<secret key — server-only, never expose to client>
OPENAI_API_KEY=<for AI map generation>
```

Add the same variables as **Environment Variables** in your Vercel project settings.

> **JWT Note:** The Supabase client uses ECC asymmetric JWT signing (migrated from legacy HS256). Edge Functions use the `requireUser` utility from `utils.ts` for auth — do not use the older `getAuthenticatedUser` pattern.

---

## 2) Deploy

```bash
# Push to GitHub → Vercel auto-deploys main branch
git push origin main
```

In Vercel:
- Set **Root Directory** to `apps/web`
- Add all environment variables listed above

### Deploy Edge Functions

```bash
supabase functions deploy create-campaign
supabase functions deploy accept-invites
supabase functions deploy advance-round
supabase functions deploy assign-missions
supabase functions deploy apply-instability
supabase functions deploy lead-set-faction
supabase functions deploy set-faction
supabase functions deploy ensure-player-state
supabase functions deploy create-map
supabase functions deploy start-campaign
supabase functions deploy invite-players
supabase functions deploy delete-campaign
supabase functions deploy generate-narrative
supabase functions deploy submit-move
supabase functions deploy spend-nip
supabase functions deploy resolve-conflict
supabase functions deploy generate-map
```

All functions currently run with `verify_jwt: false` — authentication is handled inside each function body via the `requireUser` utility.

---

## 3) Run Locally

```bash
cd apps/web
npm install
npm run dev
```

---

## 4) User Roles & Access

| Role | Capabilities |
|---|---|
| **Lead** | Creates campaign, invites players, advances rounds, triggers instability, assigns missions, sets factions, accesses `/lead` dashboard |
| **Player** | Views own dashboard, submits moves, spends NIP, reports battle results |

- Campaign creation: `/campaigns` — any authenticated user can create a campaign and becomes Lead.
- Lead controls: `/lead?campaign=<id>`
- Pending invites are stored and processed automatically via `accept-invites` when an invited player signs in.

---

## 5) Security Model

- **RLS** on all 24 public tables prevents cross-player data leakage.
- Fog-of-war: `sectors.revealed_public` controls map visibility. Private intel is stored as `posts` with `visibility='private'` and `audience_user_id`.
- Secret locations stored in `player_state_secret` with restricted RLS — only the owning player can read their own row.
- Compound RLS policies allow both player self-access and Lead administrative oversight.

---

## 6) AI Map Generation

Maps are generated using OpenAI's `gpt-image-1` model via the `generate-map` edge function. The `maps` table stores:
- `seed` — generation seed for reproducibility
- `layout` — map topology (e.g. `ring`, default 8 zones)
- `planet_profile` / `ship_profile` — climate/environment JSON fed to the prompt
- `generation_status` — `none | generating | complete | failed`
- `image_path` / `bg_image_path` / `thumbs` — stored image references

---

## 7) Changelog / Development Log

See **REFERENCE.md §7 — Changelog** for a session-by-session log of changes, decisions, and troubleshooting resolutions. Use this to resume work from any prior chat or development session.

---

## Next Features (Planned)

- Multiple maps per campaign (moonlets / sub-theatres)
- Image uploads for battle reports
- Discord webhook for bulletins
- Elo-like "threat level" + dynamic bounties
- GM/host "one-click game day" flow batching 2–3 rounds
