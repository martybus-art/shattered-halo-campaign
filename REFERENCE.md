# Shattered Halo Campaign — Project Reference

**Last updated:** March 2026  
**Production URL:** https://shattered-halo-campaign.vercel.app  
**GitHub:** https://github.com/martybus-art/shattered-halo-campaign  
**Supabase project:** `yzqzlajmehzilxfruskq` (region: ap-northeast-1)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Schema](#2-database-schema)
3. [Edge Functions](#3-edge-functions)
4. [Frontend Structure](#4-frontend-structure)
5. [Coding Standards & Patterns](#5-coding-standards--patterns)
6. [Game Design Logic & Rules](#6-game-design-logic--rules)
7. [Changelog](#7-changelog)

---

## 1. Architecture Overview

```
Player/Lead Browser
       │
       ▼
  Vercel (Next.js App Router)
  apps/web/src/
       │
       ├─ /app/api/*         ← API Routes (server-side, uses service role key)
       ├─ /components/*      ← React UI components
       │
       ▼
  Supabase
       ├─ Postgres DB (24 public tables, all RLS-enabled)
       ├─ Auth (email magic link, ECC JWT signing)
       ├─ Edge Functions (17 deployed, Deno runtime)
       └─ Storage (map images)
       │
       ▼
  OpenAI API (gpt-image-1)
       └─ AI map generation via `generate-map` edge function
```

### Key architectural decisions

- **No omniscient GM required** — the system is the arbiter of round flow and game state.
- **Service role key is server-only** — never exposed to the client. Used only in Vercel API routes and edge functions.
- **ECC asymmetric JWT** — Supabase migrated from HS256 to ECC. All edge functions use the `requireUser` utility from `utils.ts`. Do not use the older `getAuthenticatedUser` pattern.
- **Edge functions use `verify_jwt: false`** — authentication is implemented inside each function body.
- **effect_json pattern** — game effects are stored as structured JSON with an explicit `type` field (e.g. `{"type":"nip_penalty_all","amount":2}`), not as descriptive text. This enables clean automation.

---

## 2. Database Schema

### 2.1 Table Overview

All tables are in the `public` schema with RLS enabled.

| Table | Rows (approx.) | Purpose |
|---|---|---|
| `templates` | — | Campaign templates (map, rules, instability config) |
| `campaigns` | active | Core campaign record |
| `campaign_members` | per campaign | Player roster + roles |
| `player_state` | per player | NIP, NCP, location (public) |
| `player_state_secret` | per player | Secret location (restricted RLS) |
| `sectors` | per campaign | Fog-of-war sector ownership |
| `rounds` | per campaign | Round stage tracking |
| `moves` | per round | Player movement submissions |
| `recon_ops` | per round | Recon spend + results |
| `conflicts` | per round | Scheduled battles |
| `battle_results` | per conflict | Reported outcomes |
| `mission_influence` | per conflict | NIP spends to influence mission assignment |
| `posts` | per campaign | Public / private narrative posts |
| `ledger` | per campaign | Immutable NIP/NCP transaction log |
| `round_spends` | per round | NIP spend records |
| `pending_invites` | per campaign | Email-based player invitations |
| `missions` | 20 seeded | Mission pool (zone/phase filtered) |
| `relics` | — | Relic definitions |
| `campaign_relics` | per campaign | Relic instances + ownership |
| `instability_events` | 30 seeded | Event pool (threshold + d10 keyed) |
| `campaign_events` | per campaign | Fired instability event log |
| `rulesets` | 2 seeded | Named rule configurations |
| `maps` | per campaign | Map definitions + AI generation state |
| `templates` | — | Campaign content bundles |

### 2.2 Key Column Notes

**`campaigns`**
- `phase` (int): Campaign phase 1–3.
- `round_number` (int): Current round.
- `instability` (int): Current instability score (0–10+).
- `status` (text): `active` | `ended`.
- `ruleset_id` (uuid FK → rulesets): Selected ruleset.
- `map_id` (uuid FK → maps): Attached map.
- `rules_overrides` (jsonb): Per-campaign rule overrides on top of ruleset.
- `invite_message` (text): AI-generated narrative invite text.

**`campaign_members`**
- `role` (text): `lead` | `player`.
- `faction_key` (text): Faction identifier (e.g. `space_marines`, `chaos_space_marines`).
- `faction_locked` (bool): Prevents further changes once set.
- `faction_set_at` (timestamptz): When faction was locked.

**`player_state`**
- `nip` (int): Narrative Influence Points — spendable currency.
- `ncp` (int): Narrative Campaign Points — victory score.
- `current_zone_key` / `current_sector_key` (text): Public location.
- `public_location` / `secret_location` (text): Narrative location labels.

**`instability_events`**
- `threshold_min` (int): Minimum instability score for this event to be eligible. Values: `0`, `4`, `8`.
- `d10` (int 1–10): Die result that triggers this event within its threshold band.
- `effect_json` (jsonb): Structured effect. See §6.3 for all effect types.

**`missions`**
- `phase_min` (int 1–3): Earliest phase in which this mission can appear.
- `zone_tags` (jsonb array): Zone keys that must match for this mission to be eligible (empty = any zone).
- `mission_type` (text): `skirmish`, `assassination`, `raid`, `hold`, `control`, `retrieval`, `sabotage`, `ritual`, `ambush`, `siege`, `hazard`, `assault`, `relic`, `exfiltration`, `dynamic_control`, `finale`, `endgame`.

**`maps`**
- `layout` (text): Map topology. Default `ring`, `zone_count` default 8.
- `generation_status` (text): `none` | `generating` | `complete` | `failed`.
- `planet_profile` / `ship_profile` (jsonb): Environment parameters for AI image prompt.
- `art_version` (text): Currently `grimdark-v1`.

---

## 3. Edge Functions

All functions are deployed to Supabase, use the Deno runtime (`jsr:@supabase/supabase-js@2`), and are located in `supabase/functions/<slug>/index.ts`. All use `verify_jwt: false` with internal auth via `requireUser`.

| Slug | Version | Purpose |
|---|---|---|
| `create-campaign` | 45 | Creates campaign record, attaches template and ruleset |
| `accept-invites` | 38 | Processes pending_invites when a new user signs in |
| `advance-round` | 45 | Closes current round stage, opens next; handles round progression |
| `assign-missions` | 34 | Assigns missions to conflicts; zone-aware + NIP influence-aware |
| `apply-instability` | 34 | Two-phase roll/confirm; applies instability event effects |
| `lead-set-faction` | 14 | Lead overrides a player's faction assignment |
| `set-faction` | 15 | Player sets their own faction (before lock) |
| `ensure-player-state` | 16 | Upserts player_state row for a campaign member |
| `create-map` | 16 | Creates a map record (triggers generate-map if AI requested) |
| `start-campaign` | 13 | Transitions campaign from setup to active; creates round 1 |
| `invite-players` | 6 | Creates pending_invite records and sends email invitations |
| `delete-campaign` | 4 | Hard-deletes campaign and cascades all related data |
| `generate-narrative` | 3 | AI-generates narrative text (invite messages, recap prompts) |
| `submit-move` | 6 | Records a player's movement order for the current round |
| `spend-nip` | 5 | Records NIP spend to ledger + round_spends |
| `resolve-conflict` | 3 | Confirms battle result and applies outcomes |
| `generate-map` | 4 | Calls OpenAI gpt-image-1 to generate a grimdark map image |

### apply-instability: Two-Phase Flow

To prevent accidental double-application of effects:

1. **Roll phase** (`action: "roll"`): Rolls d10 against current instability threshold, returns preview of matched event and its `effect_json`. No state changes.
2. **Confirm phase** (`action: "confirm"`): Applies the previewed event. Writes to `campaign_events`, updates `campaigns.instability`, and executes automated effects.

### Authentication Pattern (All Functions)

```typescript
// Correct — use this pattern
import { requireUser } from '../_shared/utils.ts';
const user = await requireUser(req);

// Do NOT use this — deprecated pattern
// const user = await getAuthenticatedUser(req);
```

---

## 4. Frontend Structure

```
apps/web/src/
├── app/
│   ├── page.tsx                  # Home / landing
│   ├── campaigns/                # Campaign list + creation
│   ├── lead/                     # Lead dashboard (round control, instability, missions)
│   ├── player/                   # Player dashboard (moves, NIP, status)
│   ├── map/                      # Map viewer
│   └── api/                      # Next.js API routes (server-side Supabase calls)
└── components/
    ├── ui/                       # Shared UI primitives (Card, Button, etc.)
    ├── CampaignCard.tsx
    ├── InstabilityPanel.tsx
    ├── MissionPanel.tsx
    ├── MapViewer.tsx
    └── ...
```

### Supabase Client

- **Client-side:** `createBrowserClient` with `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **Server-side (API routes):** `createServerClient` with service role key — used for privileged operations

---

## 5. Coding Standards & Patterns

### Variable Naming

| Concept | Variable Name |
|---|---|
| Campaign identifier | `campaignId` |
| Campaign member row | `member` |
| Player state row | `playerState` |
| Instability score | `instability` |
| Instability event | `event` / `instabilityEvent` |
| Campaign event (fired) | `campaignEvent` |
| Round number | `roundNumber` |
| Zone identifier | `zoneKey` |
| Sector identifier | `sectorKey` |
| NIP amount | `nip` / `nipAmount` |
| NCP amount | `ncp` / `ncpAmount` |
| Ruleset config | `ruleset` / `rulesJson` |
| Effect payload | `effectJson` |
| Mission row | `mission` |
| Relic row | `relic` |
| Map row | `map` |
| User ID (auth) | `userId` |

### Effect JSON Types

Effects follow a strict typed pattern. The `type` field determines automated vs. manual handling:

| `type` | Handling | Description |
|---|---|---|
| `narrative_only` | Auto | No mechanical effect; pure flavour text |
| `nip_penalty_all` | Auto | Deduct `amount` NIP from all players |
| `nip_gain_all` | Auto | Grant `amount` NIP to all players |
| `nip_gain_last` | Auto | Grant `nip` NIP + `ncp` NCP to last-place player |
| `relic_nip_gain` | Auto | Grant `amount` NIP to all players holding a relic |
| `recon_cancel` | Auto | Cancels all recon intelligence for the round |
| `deep_strike_cost` | Auto | Increases deep strike cost by `cost` NIP |
| `sector_remove` | Auto | Removes `count` sector(s) from the map |
| `campaign_end_trigger` | Auto | Flags campaign for end-of-campaign resolution |
| `battle_rule` | Manual | `rule` field contains text shown to players; enforced at the table |
| `zone_impassable` | Manual | Lead selects a zone to block; `instruction` provides guidance |
| `zone_sensor_blind` | Manual | Lead selects a zone to black out recon |
| `zone_battle_hazard` | Manual | `instruction` describes per-battle hazard |
| `zone_nip_penalty` | Manual + Auto | Lead selects zone; players in that zone lose `amount` NIP |
| `manual` | Manual | Lead reads `instruction` and applies by hand |

### File Editing Rules

- TypeScript/JavaScript files must be written using file creation tools directly — never generated via Python string manipulation (Python escaping corrupts JS template literals and JSX).
- After every file edit, verify the output by reading back affected lines and checking for unterminated strings, malformed escapes, and unbalanced JSX tags.
- Files are downloaded by Marty and applied manually — do not auto-push or auto-apply changes.

---

## 6. Game Design Logic & Rules

> This section documents the campaign's game design systems as implemented. All values shown reflect the seeded data in production.

### 6.1 NIP / NCP Economy

**NIP (Narrative Influence Points)** — the spendable currency of the campaign.

| Source | Amount |
|---|---|
| Standard ruleset — base per round | 2 NIP |
| Cinematic ruleset — base per round | 3 NIP |
| Catch-up bonus (standard) | +1 NIP if below leader |
| Catch-up bonus (cinematic) | +2 NIP if below leader |
| Holding a relic (Relic Surge event) | +1 NIP |
| Mass Psychic Event (instability) | +1 NIP all |

**NCP (Narrative Campaign Points)** — the victory score.

| Source | Amount |
|---|---|
| Standard ruleset — base per round | 1 NCP |
| Cinematic ruleset — base per round | 2 NCP |
| Halo Chooses (instability, last place) | +1 NCP |

All NIP and NCP changes are written to the `ledger` table as immutable entries (`entry_type`, `currency`, `amount`, `reason`).

**NIP Spending**

| Action | Cost |
|---|---|
| Recon operation | Variable (player sets) |
| Mission influence bid | Variable (player sets) |
| Deep strike (normal) | Per ruleset |
| Deep strike (Orbital Interference event active) | +5 NIP surcharge |
| Narrative CP exchange | Per ruleset |

### 6.2 Fog of War

- All sector ownership is tracked in the `sectors` table.
- `revealed_public = true` — sector appears on the public map.
- `revealed_public = false` — sector is hidden from other players.
- Recon operations (`recon_ops`) allow players to spend NIP to reveal information about enemy-held sectors.
- Secret locations are stored in `player_state_secret` and are only readable by the owning player (enforced via RLS).
- The Lead has full visibility of all sectors and player states.

### 6.3 Instability System

The Halo's instability is a campaign-wide score tracked in `campaigns.instability`. It rises over time and unlocks progressively worse events.

**Threat Bands**

| Band | Threshold | Flavour |
|---|---|---|
| Tier 1 — Unease | 0+ | Environmental hazards, narrative disruption |
| Tier 2 — Crisis | 4+ | Mechanical penalties, map changes, daemonic activity begins |
| Tier 3 — Collapse | 8+ | Existential threats, potential campaign end |

When instability is triggered, the current score determines which band's event table is used. A d10 is rolled, and the result maps to a specific event.

**Instability Rate**

- Standard ruleset: 1 increment per round.
- Cinematic ruleset: 2 increments per round (multiplier: 2).

**Event Resolution Flow (apply-instability)**

1. Lead triggers roll from the `/lead` dashboard.
2. Edge function rolls d10, matches to event by `threshold_min` and `d10`.
3. Preview of event name, public text, and effect is returned to the Lead.
4. Lead confirms.
5. Automated effects execute; manual effects display instructions to the Lead.
6. Event written to `campaign_events`.

**Complete Event Table**

*Tier 1 (threshold_min: 0)*

| d10 | Name | Effect Type | Detail |
|---|---|---|---|
| 1 | Vox Static | narrative_only | — |
| 2 | Ash Wind | battle_rule | All terrain difficult; near-zero visibility |
| 3 | Tremor in the Deep | zone_impassable | Lead selects one zone to block |
| 4 | Carrion Flock | narrative_only | — |
| 5 | Tainted Water | narrative_only | — |
| 6 | Night That Would Not End | battle_rule | Darkness conditions; 18" range cap for shooting |
| 7 | Mass Desertion | nip_penalty_all | −1 NIP all |
| 8 | Relic Pulse | zone_sensor_blind | Lead selects one zone; recon nullified |
| 9 | Whispers on the Noosphere | narrative_only | — |
| 10 | Old War Wakes | zone_impassable | Lead selects one zone to block (minefield flavour) |

*Tier 2 (threshold_min: 4)*

| d10 | Name | Effect Type | Detail |
|---|---|---|---|
| 1 | The Spire Bleeds | zone_battle_hazard | Warlord in zone: d3 mortal wounds per battle round |
| 2 | Supply Lines Severed | nip_penalty_all | −2 NIP all |
| 3 | Relic Surge | relic_nip_gain | +1 NIP to all relic holders |
| 4 | Warp Scar Widens | battle_rule | Perils on any double; Warp charges +1 CP |
| 5 | Plague Wind | battle_rule | Non-armoured units treat all terrain as difficult; cannot advance |
| 6 | Blackout Protocols | recon_cancel | All recon intelligence voided this round |
| 7 | Faction Reinforcements — Enemy | manual | Strongest player records narrative defeat, loses 1 NCP |
| 8 | Sector Collapse | sector_remove | 1 sector removed from map |
| 9 | Daemonic Incursion — Minor | zone_nip_penalty | Lead selects zone; players there lose 1 NIP |
| 10 | Phase Tremor | manual | Lead redraws one zone adjacency (close one, open one) |

*Tier 3 (threshold_min: 8)*

| d10 | Name | Effect Type | Detail |
|---|---|---|---|
| 1 | The Ashen King Stirs | battle_rule | All players: −1 CP at battle start (or warlord mortal wound at 0 CP) |
| 2 | Cascade Collapse | sector_remove | 3 sectors removed from map |
| 3 | The Veil Tears | battle_rule | Per battle round: d6 roll, 1 = warlord mortal wound (no saves) |
| 4 | Null Field | battle_rule | No psychic powers; all Deny auto-succeed; psykers auto-Perils |
| 5 | The Last Broadcast | manual | Read public list of fallen commanders; narrative only |
| 6 | Orbital Interference | deep_strike_cost | Deep strike costs +5 NIP |
| 7 | Forgotten Engine Wakes | zone_battle_hazard | Both players: d3 mortal wounds on warlord per battle round (no saves) |
| 8 | Mass Psychic Event | nip_gain_all | +1 NIP all |
| 9 | Point of No Return | campaign_end_trigger | Campaign end sequence initiated |
| 10 | The Halo Chooses | nip_gain_last | Last-place player gains 3 NIP + 1 NCP |

### 6.4 Mission System

Missions are assigned to conflicts by the `assign-missions` edge function. Assignment respects zone tags and current campaign phase.

**Mission Pool by Phase**

*Phase 1 (10 missions)*

| Name | Type | Zone Restriction |
|---|---|---|
| Ashen Skirmish | skirmish | ash_wastes, obsidian_fields |
| Dark Ritual | ritual | warp_scar_basin, signal_crater, null_fields |
| Decapitation Strike | assassination | any |
| Forest Ambush | ambush | xenos_forest |
| Lightning Raid | raid | any |
| Relic Recovery | retrieval | vault_ruins, halo_spire, iron_sanctum |
| Sabotage the Supply Lines | sabotage | sunken_manufactorum, obsidian_fields, iron_sanctum |
| Signal Intercept | control | signal_crater |
| Silent Extraction | control | vault_ruins, sunken_manufactorum |
| Territorial Hold | hold | any |

*Phase 2 (adds 6 missions)*

| Name | Type | Zone Restriction |
|---|---|---|
| Hunt the Xenos Cache | retrieval | xenos_forest, ghost_harbor, blighted_reach |
| Manufactorum Purge | assault | sunken_manufactorum |
| Relic Surge | relic | halo_spire, warp_scar_basin |
| Vault Breach | siege | vault_ruins |
| Void-Break Assault | hold | any |
| Warp Scar Containment | hazard | warp_scar_basin |

*Phase 3 (adds 4 endgame missions)*

| Name | Type | Zone Restriction |
|---|---|---|
| Evacuation Protocol | exfiltration | ash_wastes, signal_crater |
| Final Stand at the Spire | finale | halo_spire |
| Relic Storm | dynamic_control | halo_spire, obsidian_fields |
| The Ashen King Stirs | endgame | warp_scar_basin, halo_spire |

**Mission Assignment Modes** (set by ruleset)

- `weighted_random_nip` — missions weighted by NIP spent in `mission_influence` bids, randomised within weights.
- `player_choice_nip` — players spend NIP to directly select preferred mission; highest bidder chooses.

### 6.5 Rulesets

Two named rulesets are seeded. A campaign selects one at creation time. Individual values can be overridden per-campaign via `campaigns.rules_overrides`.

**Standard Rules v1** (`key: standard_v1`)

| Parameter | Value |
|---|---|
| NIP per round (base) | 2 |
| NCP per round (base) | 1 |
| Catch-up bonus | +1 NIP |
| Mission mode | `weighted_random_nip` |
| Instability rate | 1 per round |
| Fog of war | enabled |
| Narrative points | enabled |
| CP exchange | enabled |

**Cinematic Rules v1** (`key: cinematic_v1`)

| Parameter | Value |
|---|---|
| NIP per round (base) | 3 |
| NCP per round (base) | 2 |
| Catch-up bonus | +2 NIP |
| Mission mode | `player_choice_nip` |
| Instability rate multiplier | ×2 (2 per round) |
| Fog of war | enabled |
| Narrative points bonus | +1 |
| CP exchange | enabled |

### 6.6 Relic System

Relics are defined in the `relics` table (linked to a template) and instantiated per-campaign in `campaign_relics`.

**Relic states** (`campaign_relics.status`): `unknown` → `discovered` → `claimed`

- `discovered_round` — round when relic was found.
- `claimed_round` — round when a player secured the relic.
- `controller_user_id` — current holder.

Relics have an `effect_json` field (same typed pattern as instability events) defining their mechanical benefit. Relic holders benefit from the `relic_nip_gain` instability event (Tier 2, d10:3).

### 6.7 Round Flow

Each round progresses through stages tracked in `rounds.stage`:

```
movement → recon → conflicts → mission_assignment → results → publish → [next round]
```

The Lead advances stages via the `/lead` dashboard, which calls the `advance-round` edge function. The function validates the current stage and transitions to the next, enforcing correct order.

---

## 7. Changelog

> Use this section to track changes across chat sessions. Add a new entry whenever a significant change, fix, or decision is made. Link the Vercel/Supabase deployment state where relevant.

---

### Session — February 2026 (Initial Build)

**What was built:**
- Full Next.js + Supabase project scaffolded.
- Initial schema migrations (001–003): campaigns, campaign_members, player_state, ledger, rounds, moves, recon_ops, conflicts, battle_results, posts, pending_invites, sectors, templates.
- Core edge functions deployed: `create-campaign`, `accept-invites`, `advance-round`, `assign-missions`.
- Lead dashboard at `/lead`, player dashboard at `/player`.
- Basic fog-of-war implementation via `sectors.revealed_public`.

---

### Session — February 2026 (Evolution Pack)

**What was added:**
- Migrations 004–006: `relics`, `campaign_relics`, `instability_events`, `campaign_events`, `mission_influence`, `round_spends`, `player_state_secret`.
- Seeded 30 instability events across 3 threat bands.
- Seeded 20 missions across 3 phases.
- Seeded 2 rulesets (`standard_v1`, `cinematic_v1`).
- `apply-instability` edge function with two-phase roll/confirm mechanism.
- `effect_json` pattern standardised across instability events and relics.

**Key decision:** Two-phase instability roll prevents accidental double-application. Lead sees preview before committing.

---

### Session — February 2026 (Faction System)

**What was added:**
- Migration 007: `faction_key`, `faction_locked`, `faction_set_at` on `campaign_members`.
- Edge functions: `lead-set-faction`, `set-faction`, `ensure-player-state`.
- Player faction selection UI with lock-on-confirm behaviour.

---

### Session — February 2026 (AI Map Generation)

**What was added:**
- Migration 008: AI fields on `maps` (`seed`, `layout`, `zone_count`, `planet_profile`, `ship_profile`, `art_version`, `bg_image_path`, `thumbs`, `cache_key`, `generation_status`).
- Migration 009: `invite_message` on `campaigns`, `ruleset_id` FK.
- Edge functions: `create-map`, `generate-map`, `start-campaign`, `invite-players`, `delete-campaign`, `generate-narrative`.
- OpenAI `gpt-image-1` integration for grimdark map art.
- Map viewer component in frontend.

---

### Session — February/March 2026 (Auth Migration & Fixes)

**Problem resolved:** Supabase migrated JWT signing from HS256 to ECC asymmetric keys. Hardcoded secrets in some edge functions were overriding the automatic environment variable, causing persistent `401 Unauthorized` errors across multiple functions.

**Fix applied:** Removed all hardcoded JWT secrets from edge functions. Consolidated all auth around the `requireUser` utility from `utils.ts`. Updated all affected functions and redeployed (all functions now at current versions).

**Key learning:** When Supabase migrates infrastructure (JWT signing, API key format), hardcoded secrets in Edge Functions can silently override the new automatic configuration. Always use the environment variable approach via the `requireUser` utility.

---

### Session — March 2026 (Documentation Update)

**What was done:**
- README.md rewritten to reflect current production state (was still showing starter/template content).
- REFERENCE.md created as a comprehensive project reference.
- Game design logic separated into its own section (§6) covering NIP/NCP economy, fog of war, instability system (full event tables), mission system, rulesets, relic system, and round flow.
- Changelog section established for future session tracking.

**Current production state verified via:**
- GitHub repo (81 commits on main)
- Supabase MCP (project `yzqzlajmehzilxfruskq`): 24 tables, 17 edge functions, 30 instability events, 20 missions, 2 rulesets all confirmed live.

---

*Add new session entries above this line.*
