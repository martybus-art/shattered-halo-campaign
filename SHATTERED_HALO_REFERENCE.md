# Shattered Halo Campaign — Master Reference Document

**Repo:** https://github.com/martybus-art/shattered-halo-campaign  
**Live site:** https://shattered-halo-campaign.vercel.app  
**Supabase project:** `yzqzlajmehzilxfruskq` (ap-northeast-1 / Tokyo)  
**Postgres version:** 17.6.1  
**Last updated:** 2026-02-28  
**Code baseline commit:** `6ea665763bccb37f1f29666f9928c191e4ac6191`

> ⚠️ **IMPORTANT:** The live database is ahead of the migration files in several places.
> When adding new columns or tables always write a new numbered migration file
> AND apply it via Supabase, so the two stay in sync.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14+ App Router, TypeScript, TailwindCSS |
| Backend | Supabase (Postgres 17 + Auth + RLS + Edge Functions) |
| Hosting | Vercel (frontend), Supabase (backend) |
| Edge runtime | Deno (`https://deno.land/std@0.224.0`) |
| Supabase JS client | `@supabase/supabase-js@2.45.4` |

---

## File Map

```
apps/web/
  next.config.js
  tailwind.config.js
  tsconfig.json
  postcss.config.js
  package.json
  src/
    middleware.ts
    app/
      layout.tsx
      page.tsx                    <- root/home page
      globals.css
      api/
        version/route.ts
      campaigns/page.tsx          <- create & list campaigns
      conflicts/page.tsx
      dashboard/page.tsx          <- player command throne
      lead/page.tsx               <- lead/admin controls
      ledger/page.tsx
      map/page.tsx
    components/
      Card.tsx
      Frame.tsx
      theme.ts                    <- faction definitions (CANONICAL)
      ui.css
    lib/
      supabaseBrowser.ts
      supabaseServer.ts

supabase/
  migrations/
    001_init.sql                  <- core schema
    002_rls.sql                   <- row-level security
    003_pending_invites.sql
    004_relics_instability.sql    <- evolution pack tables
  functions/
    _shared/
      rules.ts                    <- EffectiveRules type, deepMerge, loadEffectiveRules
      utils.ts                    <- corsHeaders, json, adminClient, requireUser
    accept-invites/index.ts
    advance-round/index.ts
    apply-instability/index.ts
    assign-missions/index.ts
    create-campaign/index.ts
    create-map/index.ts
    ensure-player-state/index.ts
    lead-set-faction/index.ts
    set-faction/index.ts
    start-campaign/index.ts       <- EMPTY FILE - not yet implemented
  seed/
    missions_shattered_halo.json
    seed_evolution_pack.sql
    template_shattered_halo.json

public/art/factions/              <- see Factions section
```

---

## Database Tables - LIVE SCHEMA (ground truth from Supabase)

Row counts shown are current live counts. All tables are in `public` schema.

### `templates` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `name` | text | NO | |
| `description` | text | YES | |
| `map_json` | jsonb | NO | |
| `rules_json` | jsonb | NO | |
| `instability_json` | jsonb | NO | |
| `created_at` | timestamptz | NO | `now()` |

### `rulesets` - 2 rows  ✅ RLS enabled 2026-02-28
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `key` | text UNIQUE | NO | |
| `name` | text | NO | |
| `description` | text | YES | |
| `version` | int | NO | `1` |
| `rules_json` | jsonb | NO | `'{}'` |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamptz | NO | `now()` |

### `maps` - 0 rows  ✅ RLS enabled 2026-02-28
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `name` | text | NO | |
| `description` | text | YES | |
| `version` | int | NO | `1` |
| `map_json` | jsonb | NO | |
| `image_path` | text | YES | |
| `is_active` | boolean | NO | `true` |
| `created_by` | uuid FK -> auth.users | YES | |
| `created_at` | timestamptz | NO | `now()` |

### `campaigns` - 1 row
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `template_id` | uuid FK -> templates | NO | |
| `name` | text | NO | |
| `phase` | int | NO | `1` |
| `round_number` | int | NO | `1` |
| `instability` | int | NO | `0` |
| `status` | text | NO | `'active'` |
| `created_at` | timestamptz | NO | `now()` |
| `ruleset_id` | uuid FK -> rulesets | YES | |
| `map_id` | uuid FK -> maps | YES | |
| `rules_overrides` | jsonb | NO | `'{}'` |

### `campaign_members` - 1 row
| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `campaign_id` | uuid FK -> campaigns | NO | | composite PK |
| `user_id` | uuid FK -> auth.users | NO | | composite PK |
| `role` | text | NO | `'player'` | |
| `faction_name` | text | YES | | display name |
| `commander_name` | text | YES | | |
| `created_at` | timestamptz | NO | `now()` | |
| `faction_key` | text | YES | | links to FactionTheme.key |
| `faction_locked` | boolean | NO | `false` | once set by lead, player can't change |
| `faction_set_at` | timestamptz | YES | | |

### `sectors` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `zone_key` | text | NO | |
| `sector_key` | text | NO | |
| `owner_user_id` | uuid FK -> auth.users | YES | |
| `fortified` | boolean | NO | `false` |
| `revealed_public` | boolean | NO | `false` |
| `tags` | jsonb | NO | `'{}'` |

### `player_state` - 1 row
| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `campaign_id` | uuid FK -> campaigns | NO | | composite PK |
| `user_id` | uuid FK -> auth.users | NO | | composite PK |
| `current_zone_key` | text | NO | `'unknown'` | |
| `current_sector_key` | text | NO | | |
| `nip` | int | NO | `0` | Narrative Influence Points |
| `ncp` | int | NO | `0` | Narrative Campaign Points |
| `status` | text | NO | `'normal'` | |
| `last_active_at` | timestamptz | YES | | |
| `public_location` | text | YES | | human-readable public location |
| `secret_location` | text | YES | | human-readable secret location |
| `starting_location` | text | YES | | starting position |

### `player_state_secret` - 0 rows  NOTE: not in any migration file
| Column | Type | Nullable | Default |
|---|---|---|---|
| `campaign_id` | uuid | NO | composite PK |
| `user_id` | uuid | NO | composite PK |
| `starting_location` | text | YES | |
| `secret_location` | text | YES | |
| `created_at` | timestamptz | NO | `now()` |
| `updated_at` | timestamptz | NO | `now()` |

Purpose unclear - may be an attempt to put secret location behind stricter RLS.
Clarify intent before building on it.

### `ledger` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `user_id` | uuid FK -> auth.users | NO | |
| `round_number` | int | NO | |
| `entry_type` | text | NO | |
| `currency` | text | NO | |
| `amount` | int | NO | |
| `reason` | text | NO | |
| `metadata` | jsonb | NO | `'{}'` |
| `created_at` | timestamptz | NO | `now()` |

### `rounds` - 1 row
| Column | Type | Nullable | Default |
|---|---|---|---|
| `campaign_id` | uuid FK -> campaigns | NO | composite PK |
| `round_number` | int | NO | composite PK |
| `stage` | text | NO | `'movement'` |
| `opened_at` | timestamptz | NO | `now()` |
| `closed_at` | timestamptz | YES | |

### `moves` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `round_number` | int | NO | |
| `user_id` | uuid FK -> auth.users | NO | |
| `from_zone_key` | text | NO | |
| `from_sector_key` | text | NO | |
| `to_zone_key` | text | NO | |
| `to_sector_key` | text | NO | |
| `spend_json` | jsonb | NO | `'{}'` |
| `submitted_at` | timestamptz | NO | `now()` |

### `recon_ops` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `round_number` | int | NO | |
| `user_id` | uuid FK -> auth.users | NO | |
| `target_zone_key` | text | YES | |
| `target_sector_key` | text | YES | |
| `nip_spent` | int | NO | `0` |
| `roll` | int | YES | |
| `result_json` | jsonb | NO | `'{}'` |
| `created_at` | timestamptz | NO | `now()` |

### `conflicts` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `round_number` | int | NO | |
| `zone_key` | text | NO | |
| `sector_key` | text | NO | |
| `player_a` | uuid FK -> auth.users | NO | |
| `player_b` | uuid FK -> auth.users | NO | |
| `mission_id` | uuid | YES | |
| `mission_status` | text | NO | `'unassigned'` |
| `twist_tags` | jsonb | NO | `'[]'` |
| `status` | text | NO | `'scheduled'` |

### `battle_results` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `conflict_id` | uuid FK -> conflicts | NO | |
| `reported_by` | uuid FK -> auth.users | NO | |
| `winner_user_id` | uuid FK -> auth.users | YES | |
| `outcome_json` | jsonb | NO | `'{}'` |
| `confirmed` | boolean | NO | `false` |
| `created_at` | timestamptz | NO | `now()` |

### `missions` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `template_id` | uuid FK -> templates | NO | |
| `name` | text | NO | |
| `description` | text | NO | |
| `phase_min` | int | NO | `1` |
| `zone_tags` | jsonb | NO | `'[]'` |
| `mission_type` | text | NO | |
| `is_active` | boolean | NO | `true` |

### `mission_influence` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `conflict_id` | uuid FK -> conflicts | NO | |
| `user_id` | uuid FK -> auth.users | NO | |
| `influence_type` | text | NO | |
| `nip_spent` | int | NO | |
| `payload` | jsonb | NO | `'{}'` |
| `created_at` | timestamptz | NO | `now()` |

### `posts` - 1 row
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `round_number` | int | NO | |
| `visibility` | text | NO | |
| `audience_user_id` | uuid FK -> auth.users | YES | |
| `title` | text | NO | |
| `body` | text | NO | |
| `tags` | jsonb | NO | `'[]'` |
| `created_by` | uuid FK -> auth.users | YES | |
| `created_at` | timestamptz | NO | `now()` |

### `pending_invites` - 1 row
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `email` | text | NO | |
| `role` | text | NO | `'player'` |
| `created_by` | uuid FK -> auth.users | YES | |
| `created_at` | timestamptz | NO | `now()` |

### `relics` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `template_id` | uuid FK -> templates | NO | |
| `name` | text | NO | |
| `lore` | text | NO | `''` |
| `rarity` | text | NO | `'common'` |
| `phase_min` | int | NO | `1` |
| `zone_tags` | jsonb | NO | `'[]'` |
| `effect_json` | jsonb | NO | `'{}'` |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamptz | NO | `now()` |

### `campaign_relics` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `relic_id` | uuid FK -> relics | NO | |
| `controller_user_id` | uuid FK -> auth.users | YES | |
| `status` | text | NO | `'unknown'` |
| `discovered_round` | int | YES | |
| `claimed_round` | int | YES | |
| `notes` | text | NO | `''` |
| `created_at` | timestamptz | NO | `now()` |

### `instability_events` - 0 rows
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `template_id` | uuid FK -> templates | NO | |
| `threshold_min` | int | NO | `0` |
| `d10` | int CHECK(1-10) | NO | |
| `name` | text | NO | |
| `public_text` | text | NO | |
| `effect_json` | jsonb | NO | `'{}'` |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamptz | NO | `now()` |

### `campaign_events` - 1 row
| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid PK | NO | `gen_random_uuid()` |
| `campaign_id` | uuid FK -> campaigns | NO | |
| `round_number` | int | NO | |
| `instability_after` | int | NO | |
| `event_name` | text | NO | |
| `event_roll` | int | YES | |
| `visibility` | text | NO | `'public'` |
| `effect_json` | jsonb | NO | `'{}'` |
| `created_at` | timestamptz | NO | `now()` |

---

## Canonical Value Sets

### Role (`campaign_members.role`)
```
'player'   <- default
'lead'     <- campaign creator; controls round flow, generates public recaps
'admin'    <- elevated read; can also advance rounds
```

### Campaign Status (`campaigns.status`)
```
'active'   <- only defined value so far
```

### Round Stage (`rounds.stage`) - ordered sequence
```
'movement' -> 'recon' -> 'conflicts' -> 'missions' -> 'results' -> 'spend' -> 'publish' -> 'closed'
```
Source: `supabase/functions/advance-round/index.ts`

### Player Status (`player_state.status`)
```
'normal' | 'underdog' | 'inactive' | 'newcomer'
```

### Ledger Entry Type (`ledger.entry_type`)
```
'earn' | 'spend' | 'system'
```

### Currency (`ledger.currency`)
```
'NIP'   <- Narrative Influence Points (short-term, spent on recon/missions)
'NCP'   <- Narrative Campaign Points (longer-term progression)
```

### Post Visibility (`posts.visibility`)
```
'public'    <- all campaign members
'private'   <- audience_user_id only
```

### Mission Type (`missions.mission_type`)
```
'raid' | 'hold' | 'retrieval' | 'assassination' | 'ritual' | 'sabotage'
```

### Mission Influence Type (`mission_influence.influence_type`)
```
'preference' | 'choose' | 'veto' | 'twist'
```

### Conflict Mission Status (`conflicts.mission_status`)
```
'unassigned' | 'pending_influence' | 'assigned'
```

### Conflict Status (`conflicts.status`)
```
'scheduled' | 'resolved'
```

### Mission Selection Mode (`rulesOverrides.missions.mode`)
```
'random'
'player_choice'
'player_choice_nip'
'weighted_random_nip'    <- default
```

---

## TypeScript Types

### `src/app/campaigns/page.tsx`
```ts
type Template   = { id: string; name: string; description: string | null }
type Campaign   = { id: string; name: string; phase: number; round_number: number; instability: number; created_at: string }
type Membership = { campaign_id: string; role: string }
type Ruleset    = { id: string; name: string; description: string | null; key: string }
type MapRow     = { id: string; name: string; description: string | null; version: number }
type RulesOverrides = {
  fog?:       { enabled: boolean }
  instability?: { enabled: boolean }
  missions?:  { mode: string }
  economy?:   { enabled?: boolean; catchup?: { enabled: boolean; bonus: number } }
  narrative?: { cp_exchange?: { enabled: boolean } }
}
```

### `src/app/dashboard/page.tsx`
```ts
type PlayerState = { campaign_id: string; user_id: string; current_zone_key: string; current_sector_key: string; nip: number; ncp: number; status: string }
type Campaign    = { id: string; name: string; phase: number; round_number: number; instability: number }
type Membership  = { campaign_id: string; role: string; campaign_name: string }
```

### `src/components/theme.ts`
```ts
type FactionTheme = { key: string; name: string; bg: string; crest: string; preview: string }
```

### `supabase/functions/_shared/rules.ts`
```ts
type EffectiveRules = {
  economy?:     { enabled?: boolean; [k: string]: unknown }
  missions?:    { enabled?: boolean; mode?: string; [k: string]: unknown }
  instability?: { enabled?: boolean; [k: string]: unknown }
  fog?:         { enabled?: boolean; [k: string]: unknown }
  [k: string]: unknown
}
```

---

## Factions (Canonical - `src/components/theme.ts`)

| `key` | Display Name |
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

Each folder (`public/art/factions/<key>/`): `bg.jpg`, `crest.png`, `preview.jpg`
Lookup: `getFactionTheme(key?: string | null): FactionTheme | null`

---

## Edge Functions

| Function | Role required | Purpose |
|---|---|---|
| `accept-invites` | any authenticated | Auto-joins pending invites for current user |
| `advance-round` | `lead` or `admin` | Steps round through the stage sequence |
| `apply-instability` | service role | Rolls instability events at end of round |
| `assign-missions` | service role | Assigns missions to conflicts (NIP-weighted) |
| `create-campaign` | any authenticated | Creates campaign, sets caller as `lead` |
| `create-map` | service role | Creates map/sector rows from template |
| `ensure-player-state` | service role | Upserts player_state row for a user |
| `lead-set-faction` | `lead` | Sets another player's faction |
| `set-faction` | `player` (self) | Sets own faction |
| `start-campaign` | - | EMPTY - not implemented |

---

## DB Helper Functions

```sql
public.is_campaign_member(p_campaign uuid, p_user uuid) -> boolean
public.has_campaign_role(p_campaign uuid, p_user uuid, p_role text) -> boolean
```

---

## Environment Variables

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...   <- USE THIS NAME (not ANON_KEY)
SUPABASE_SERVICE_ROLE_KEY=...              <- server-only, never expose to client
```

---

## Naming Conventions

### TypeScript
- Types: PascalCase (PlayerState, FactionTheme)
- Variables/functions: camelCase (campaignId, loadCampaign)
- Constants: UPPER_SNAKE_CASE (FACTION_THEMES, DEFAULT_RULES)
- Component files: PascalCase.tsx (Card.tsx, Frame.tsx)
- Utility files: camelCase.ts (supabaseBrowser.ts, theme.ts)

### SQL
- Tables: snake_case plural (campaign_members, recon_ops)
- Columns: snake_case (round_number, zone_key, revealed_public)
- FK columns: target_id pattern (campaign_id, relic_id)
- Policy names: table_action_scope (moves_read_self)
- Index names: table_column_idx (relics_template_idx)

### Keys
- Zone keys: snake_case text ("zone_alpha")
- Sector keys: grid notation ("A1", "B2")
- Faction keys: snake_case ("space_marines", "tau_empire")
- Edge functions: kebab-case ("advance-round")
- URL params: snake_case (?campaign=uuid)

---

## Known Issues

| # | Severity | Status | Issue |
|---|---|---|---|
| 1 | Low | Open | `let PlayerState = ps` in dashboard/page.tsx uses PascalCase for a variable. Should be `let playerState = ps` |
| 2 | Medium | ✅ Fixed 2026-02-28 | `rulesets` and `maps` tables had RLS disabled. Fixed with `005_rls_rulesets_maps.sql` |
| 3 | Medium | Open | `player_state_secret` table exists in live DB with no migration and no code references. Clarify purpose |
| 4 | Low | Open | `start-campaign/index.ts` is an empty file |
| 5 | Low | Open | No shared src/types/index.ts — Campaign, Membership etc. redefined per page with slight differences |
| 6 | Low | ✅ Fixed 2026-02-28 | Catch-up migration 007_catchup_schema.sql written to document all schema drift |
| 7 | Low | ✅ Fixed 2026-02-28 | `storage_campaign_id` and `block_faction_change_unless_lead` functions had mutable search_path. Fixed with `ALTER FUNCTION ... SET search_path = public` |
| 8 | Performance | 2705 Fixed 2026-02-28 | 40+ RLS policies wrapped with `(select auth.uid())` via migration 006 |
| 9 | Performance | 2705 Fixed 2026-02-28 | Duplicate permissive policies merged into single OR-condition policies via migration 006 |
| 10 | Performance | 2705 Fixed 2026-02-28 | Duplicate constraint `player_state_unique_user_campaign` dropped via migration 006 |

---

## Pro Tier Recommendations

These improvements require Supabase Pro tier or above. Revisit if you upgrade.

| # | Feature | Where to enable | Why |
|---|---|---|---|
| P1 | **Leaked Password Protection** | Supabase Dashboard → Authentication → Security → Enable "Check for leaked passwords" | Prevents players signing up with passwords found in HaveIBeenPwned data breaches. Free tier blocks this toggle. |

---

## Change Log

| # | Date | Files | Change |
|---|---|---|---|
| 001 | 2026-02-28 | - | Initial reference doc from code review of commit 6ea6657 |
| 002 | 2026-02-28 | - | Updated with live Supabase schema via MCP. Found rulesets, maps, player_state_secret tables and extra columns on campaigns, campaign_members, player_state not in migration files |
| 003 | 2026-02-28 | SQL Editor | Enabled RLS on rulesets and maps tables. Added read-only policies for authenticated users. No frontend changes needed |
| 004 | 2026-02-28 | SQL Editor | Fixed mutable search_path on storage_campaign_id and block_faction_change_unless_lead with ALTER FUNCTION ... SET search_path = public |
| 005 | 2026-02-28 | REFERENCE.md | Added Pro Tier Recommendations section. Logged leaked password protection (P1) as blocked on free tier |
| 006 | 2026-02-28 | SQL Editor + supabase/migrations/006_perf_rls_fixes.sql | Wrapped all auth.uid()/auth.role() calls in (select ...) across 40+ policies. Merged duplicate permissive policies. Dropped duplicate constraint player_state_unique_user_campaign |
| 007 | 2026-02-28 | supabase/migrations/007_catchup_schema.sql | Documented all live DB schema drift: rulesets, maps, player_state_secret tables; ruleset_id/map_id/rules_overrides on campaigns; faction_key/faction_locked/faction_set_at on campaign_members; public_location/secret_location/starting_location on player_state |
