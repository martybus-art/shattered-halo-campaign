-- ============================================================
-- Migration 007: Catch-up schema
--
-- Documents everything that exists in the live database but
-- was never captured in a migration file. These changes were
-- applied directly to the DB during development.
--
-- All statements use IF NOT EXISTS / IF EXISTS guards so this
-- is safe to run even if some items already exist.
--
-- Covers:
--   1. Three missing tables: rulesets, maps, player_state_secret
--   2. Missing columns on campaigns (ruleset_id, map_id, rules_overrides)
--   3. Missing columns on campaign_members (faction_key, faction_locked, faction_set_at)
--   4. Missing columns on player_state (public_location, secret_location, starting_location)
--   5. RLS policies for rulesets and maps (applied via SQL editor, not a migration)
--   6. Indexes on the new FK columns
-- ============================================================


-- ============================================================
-- 1. MISSING TABLES
-- ============================================================

-- RULESETS
-- Admin-seeded config. Clients read only; writes via service role.
create table if not exists public.rulesets (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  description text,
  version     int not null default 1,
  rules_json  jsonb not null default '{}',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.rulesets enable row level security;

create policy "rulesets_read_auth"
on public.rulesets for select
using (true);


-- MAPS
-- Admin-seeded config. Clients read only; writes via service role.
create table if not exists public.maps (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  version     int not null default 1,
  map_json    jsonb not null,
  image_path  text,
  is_active   boolean not null default true,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

alter table public.maps enable row level security;

create policy "maps_read_auth"
on public.maps for select
using (true);

create index if not exists idx_maps_created_by on public.maps(created_by);


-- PLAYER_STATE_SECRET
-- Purpose unclear - appears to be an early attempt to store secret
-- location data under stricter RLS. No code references it.
-- Documented here for completeness. Clarify intent before building on it.
create table if not exists public.player_state_secret (
  campaign_id      uuid not null,
  user_id          uuid not null,
  starting_location text,
  secret_location  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

alter table public.player_state_secret enable row level security;

create policy "pss_select_self"
on public.player_state_secret for select
using (user_id = (select auth.uid()));


-- ============================================================
-- 2. MISSING COLUMNS ON campaigns
-- ============================================================

alter table public.campaigns
  add column if not exists ruleset_id uuid references public.rulesets(id),
  add column if not exists map_id uuid references public.maps(id),
  add column if not exists rules_overrides jsonb not null default '{}';

create index if not exists idx_campaigns_ruleset_id on public.campaigns(ruleset_id);
create index if not exists idx_campaigns_map_id on public.campaigns(map_id);


-- ============================================================
-- 3. MISSING COLUMNS ON campaign_members
-- ============================================================

alter table public.campaign_members
  add column if not exists faction_key text,
  add column if not exists faction_locked boolean not null default false,
  add column if not exists faction_set_at timestamptz;


-- ============================================================
-- 4. MISSING COLUMNS ON player_state
-- ============================================================

alter table public.player_state
  add column if not exists public_location text,
  add column if not exists secret_location text,
  add column if not exists starting_location text;

create index if not exists idx_player_state_campaign on public.player_state(campaign_id);
create index if not exists idx_player_state_user on public.player_state(user_id);
