# Embers of the Shattered Halo — Campaign App

A fog-of-war, multi-player narrative campaign tracker for tabletop wargames (Warhammer 40,000).
Built to run a full campaign without a GM — the system is the arbiter.

**Live:** [40kcampaigngame.fun](https://40kcampaigngame.fun)

---

## What It Does

- **Player dashboards** — secret location, NIP/NCP economy, status, private whisper prompts
- **Fog-of-war map** — public sector reveals, private intel, zone ownership
- **Immutable economy ledger** — NIP (Narrative Influence Points) and NCP (Narrative Campaign Points)
- **Automated round flow** — Movement → Recon → Conflicts → Missions → Results → Spend → Publish
- **Mission selection** — Random, player choice, or NIP-weighted influence
- **Halo Instability clock** — d10 event table, phase-gated triggers
- **Faction system** — 10 playable factions with art, crests, and lead-assignable locks
- **Recap prompt generator** — public Lead bulletin + per-player private whisper (AI-ready prompts)
- **Invite system** — email invites with AI-generated grimdark narrative blurb, accept/decline flow
- **Faction allegiance** — permanent one-time faction lock with themed visual banner
- **Campaign Chronicle** — AI-generated narrative summary of the entire campaign at end of game
- **Campaign archive** — full JSON export of all campaign data including the chronicle
- **No GM required** — optional Admin role for disputes only

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14+ (App Router), TypeScript, TailwindCSS |
| Backend | Supabase — Postgres 17, Auth, Row Level Security, Edge Functions |
| Edge runtime | Deno |
| Hosting | Vercel (frontend) + Supabase (backend) |

---

## Project Structure

```
apps/web/                        # Next.js frontend
  src/
    app/
      campaigns/page.tsx         # Create campaign (size picker, auto-map, AI invite message)
      dashboard/page.tsx         # Player command throne
      lead/page.tsx              # Lead/admin controls & round flow
      conflicts/page.tsx         # Active conflicts
      ledger/page.tsx            # Economy ledger
      map/page.tsx               # Fog-of-war map
    components/
      theme.ts                   # Faction definitions (canonical source)
      Card.tsx / Frame.tsx       # UI primitives
    lib/
      supabaseBrowser.ts         # Client-side Supabase instance
      supabaseServer.ts          # Server-side Supabase instance

supabase/
  migrations/                    # SQL schema (run in order)
    001_init.sql                 # Core tables
    002_rls.sql                  # Row Level Security policies
    003_pending_invites.sql      # Invite system
    004_relics_instability.sql   # Evolution Pack — relics & events
  functions/                     # Deno edge functions
    accept-invites/              # list/accept/decline pending invites
    advance-round/
    apply-instability/
    assign-missions/
    create-campaign/              # auto-generates map from campaign_size
    create-map/
    delete-campaign/              # safe cascade delete (lead/admin only)
    ensure-player-state/
    generate-narrative/           # Claude API proxy (avoids browser CORS)
    invite-players/               # sends invite emails via Supabase Auth SMTP
    lead-set-faction/
    set-faction/
    start-campaign/
    _shared/
      rules.ts                   # EffectiveRules type & rule merging
      utils.ts                   # Shared helpers (cors, auth, admin client)
  seed/
    missions_shattered_halo.json
    seed_evolution_pack.sql
    template_shattered_halo.json
```

---

## Playable Factions

| Key | Display Name |
|---|---|
| `space_marines` | Space Marines |
| `astra_militarum` | Astra Militarum |
| `adeptus_mechanicus` | Adeptus Mechanicus |
| `adepta_sororitas` | Adepta Sororitas |
| `orks` | Orks |
| `necrons` | Necrons |
| `chaos_space_marines` | Chaos Space Marines |
| `tyranids` | Tyranids |
| `tau_empire` | T'au Empire |
| `aeldari` | Aeldari |

Faction art lives in `apps/web/public/art/factions/<key>/` as `bg.jpg`, `crest.png`, `preview.jpg`.

---

## Round Flow

The system advances through these stages in order, controlled by the Lead player:

```
Movement → Recon → Conflicts → Missions → Results → Spend → Publish → (next round)
```

Each stage transition is handled by the `advance-round` edge function.

---

## Roles

| Role | Access |
|---|---|
| `player` | Own dashboard, moves, recon, private posts |
| `lead` | Everything above + round control, public bulletins, faction assignment |
| `admin` | Everything above + read access to all player states (for disputes) |

---

## Economy

- **NIP** (Narrative Influence Points) — short-term currency. Spent on recon, mission influence bids, and twists.
- **NCP** (Narrative Campaign Points) — longer-term progression currency earned from battle outcomes.
- All transactions are recorded in the immutable `ledger` table (no deletes, no edits).

---

## Setup

### 1. Supabase

1. Create a Supabase project
2. In **SQL Editor**, run migrations in order: `001_init.sql` → `002_rls.sql` → `003_pending_invites.sql` → `004_relics_instability.sql`
3. Enable **Email Auth** (magic link recommended for low friction)
4. Seed a template row manually or via the seed files in `supabase/seed/`
5. Deploy edge functions: `supabase functions deploy --project-ref <your-ref>`

### 2. Environment Variables

Create `apps/web/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

Edge Function secrets (set via Supabase Dashboard → Edge Functions → Secrets or CLI):

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` is server-only. Never expose it to the client or commit it to version control.

Add the same three variables in your Vercel project settings under **Environment Variables**.

### 3. Run locally

```bash
cd apps/web
npm install
npm run dev
```

### 4. Deploy

1. Push to GitHub
2. Import `apps/web` into Vercel as the project root (set **Root Directory** to `apps/web`)
3. Add env vars in Vercel dashboard
4. Vercel auto-deploys on every push to `main`

---

## AI Integration

This app uses AI in two ways: generating prompts from live campaign data (feed into any LLM), and making direct Claude API calls via the `generate-narrative` edge function.

### generate-narrative Edge Function

The `generate-narrative` Supabase edge function proxies calls to the Claude API server-side, avoiding CORS restrictions that block direct browser-to-Anthropic calls. It requires an `ANTHROPIC_API_KEY` secret set in Supabase Edge Function secrets.

Used for:
- **Invite message generation** (campaigns page) — grimdark 40K call-to-arms blurb from campaign name
- **Campaign Chronicle** (lead page) — end-of-campaign narrative summary using all campaign data

### Built-in Prompt Generator (Dashboard)

The **Dashboard** page can copy two types of prompts to clipboard:

- **Public Recap Prompt** (Lead only) — pulls public posts and campaign state. Safe to share with all players. Generates a grimdark "Halo War Bulletin."
- **Private Whisper Prompt** (each player) — includes secret location, NIP/NCP, and private posts. Generates personalised intel and objectives.

### Connecting an AI Assistant (e.g. Claude)

To give an AI assistant full project context, provide:

1. **This README** — for architecture and conventions
2. **`REFERENCE.md`** (in repo root) — for the full schema, canonical value sets, and change log
3. **Supabase MCP** — for live database access (see below)

### Supabase MCP (Model Context Protocol)

The Supabase MCP server gives AI assistants direct read/write access to the live database. To connect:

1. Go to your Supabase project → **Integrations → MCP**
2. Copy the MCP server URL
3. Add it to your AI tool's MCP configuration

Once connected, an AI assistant can: inspect the live schema, run queries, apply migrations, read logs, and deploy edge functions — all from the chat interface.

### Other Tool Integrations

Add your connected tools here as you set them up:

| Tool | Purpose | Status |
|---|---|---|
| Supabase MCP | Live DB access, migrations, edge functions | ✅ Connected |
| Vercel | Frontend deployment | ✅ Connected |
| GitHub | Version control | ✅ Connected |
| _(your tool)_ | _(purpose)_ | 🔲 Not connected |
| _(your tool)_ | _(purpose)_ | 🔲 Not connected |

---

## Security Model (Fog of War)

- **RLS** prevents players reading other players' secret locations or private intel
- **Public map** only shows sectors where `revealed_public = true`
- **Private posts** are stored with `visibility = 'private'` and an `audience_user_id` — only that user can read them
- **Edge functions** that modify sensitive data run with the service role key on the server — clients never hold it
- Players can only read/write their own `moves`, `recon_ops`, and `player_state` rows

---

## Campaign Creation (No-GM Flow)

1. Go to `/campaigns` and sign in
2. Select a template, name your campaign, choose a campaign size (Small/Medium/Large)
3. Optionally generate a grimdark AI invite message, or write your own
4. Optionally invite players by email — they receive an invite email and accept/decline on their profile page
5. You become the **Lead** automatically
6. A map is auto-generated from the campaign size and stored in the `maps` table
5. Lead controls are at `/lead?campaign=<id>`

---

## Conventions & Reference

All naming conventions, canonical value sets, table schemas, TypeScript types, and the change log are maintained in **`REFERENCE.md`** in the repo root. Consult it before adding new variables, columns, or string literals to keep everything consistent across chats and sessions.

Key rules:
- TypeScript types: `PascalCase`
- Variables/functions: `camelCase`
- DB tables/columns: `snake_case`
- Faction keys: `snake_case` matching the folder name under `public/art/factions/`
- Env var for anon key: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (not `ANON_KEY`)

---

## Planned / In Progress

### Completed
- ✅ `start-campaign` edge function (fixed map_id join)
- ✅ Campaign size picker with auto-generated maps
- ✅ Email invite system with accept/decline flow
- ✅ Faction allegiance picker with permanent lock
- ✅ AI invite message generation
- ✅ Campaign Chronicle (AI narrative summary)
- ✅ Campaign archive export (full JSON)
- ✅ Campaign delete with confirmation
- ✅ RLS policies for `rulesets` and `maps` tables

### In Progress / Backlog
- Shared `src/types/index.ts` (types currently duplicated per page)
- Resolve `player_state_secret` table purpose (no migration file)
- Multiple maps per campaign (moonlets / sub-theatres)
- Image uploads for battle reports
- Discord webhook for bulletins
- Elo-style threat level + dynamic bounties
- One-click game day flow (batch 2–3 rounds)
