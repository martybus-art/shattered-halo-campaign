-- Embers of the Shattered Halo - Core Schema
-- Requires pgcrypto for gen_random_uuid()
create extension if not exists pgcrypto;

-- =========================
-- Core campaign templates
-- =========================
create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  map_json jsonb not null,
  rules_json jsonb not null,
  instability_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id) on delete cascade,
  name text not null,
  phase int not null default 1,
  round_number int not null default 1,
  instability int not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- =========================
-- Membership & roles
-- role: 'player' | 'admin' | 'lead'
-- =========================
create table if not exists public.campaign_members (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'player',
  faction_name text,
  commander_name text,
  created_at timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

-- =========================
-- Map state: 8 zones each 2x2 sectors (32 rows), but template-driven
-- revealed_public controls the public map layer.
-- =========================
create table if not exists public.sectors (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  zone_key text not null,
  sector_key text not null, -- A1/A2/B1/B2 or template custom
  owner_user_id uuid references auth.users(id),
  fortified boolean not null default false,
  revealed_public boolean not null default false,
  tags jsonb not null default '{}'::jsonb,
  unique (campaign_id, zone_key, sector_key)
);

-- =========================
-- Player state: secret location + economy
-- =========================
create table if not exists public.player_state (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  current_zone_key text not null,
  current_sector_key text not null,
  nip int not null default 0,
  ncp int not null default 0,
  status text not null default 'normal', -- normal/underdog/inactive/newcomer
  last_active_at timestamptz,
  primary key (campaign_id, user_id)
);

-- Immutable economy ledger (audit log)
create table if not exists public.ledger (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  round_number int not null,
  entry_type text not null, -- earn/spend/system
  currency text not null, -- NIP/NCP
  amount int not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- =========================
-- Round & stage control
-- =========================
create table if not exists public.rounds (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  round_number int not null,
  stage text not null default 'movement',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  primary key (campaign_id, round_number)
);

-- Moves (secret)
create table if not exists public.moves (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  round_number int not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  from_zone_key text not null,
  from_sector_key text not null,
  to_zone_key text not null,
  to_sector_key text not null,
  spend_json jsonb not null default '{}'::jsonb, -- e.g. {"forced_march":true}
  submitted_at timestamptz not null default now(),
  unique (campaign_id, round_number, user_id)
);

-- Recon ops (private results)
create table if not exists public.recon_ops (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  round_number int not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  target_zone_key text,
  target_sector_key text,
  nip_spent int not null default 0,
  roll int,
  result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (campaign_id, round_number, user_id)
);

-- Conflicts detected by system
create table if not exists public.conflicts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  round_number int not null,
  zone_key text not null,
  sector_key text not null,
  player_a uuid not null references auth.users(id) on delete cascade,
  player_b uuid not null references auth.users(id) on delete cascade,
  mission_id uuid,
  mission_status text not null default 'unassigned', -- unassigned/pending_influence/assigned
  twist_tags jsonb not null default '[]'::jsonb,
  status text not null default 'scheduled' -- scheduled/resolved
);

-- Battle result confirmation (both players confirm)
create table if not exists public.battle_results (
  id uuid primary key default gen_random_uuid(),
  conflict_id uuid not null references public.conflicts(id) on delete cascade,
  reported_by uuid not null references auth.users(id) on delete cascade,
  winner_user_id uuid references auth.users(id),
  outcome_json jsonb not null default '{}'::jsonb, -- objectives, cinematic moments, casualties
  confirmed boolean not null default false,
  created_at timestamptz not null default now()
);

-- =========================
-- Missions (template-driven)
-- =========================
create table if not exists public.missions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id) on delete cascade,
  name text not null,
  description text not null,
  phase_min int not null default 1,
  zone_tags jsonb not null default '[]'::jsonb,
  mission_type text not null, -- raid/hold/retrieval/assassination/ritual/sabotage
  is_active boolean not null default true
);

-- Mission influence spends
create table if not exists public.mission_influence (
  id uuid primary key default gen_random_uuid(),
  conflict_id uuid not null references public.conflicts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  influence_type text not null, -- preference/choose/veto/twist
  nip_spent int not null,
  payload jsonb not null default '{}'::jsonb, -- e.g. chosen mission id, twist tag
  created_at timestamptz not null default now()
);

-- =========================
-- Posts: bulletins, whispers, bounties, events, recap prompts
-- =========================
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  round_number int not null,
  visibility text not null, -- public/private
  audience_user_id uuid references auth.users(id),
  title text not null,
  body text not null,
  tags jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Helpful index
create index if not exists idx_posts_campaign_round on public.posts(campaign_id, round_number);

-- =========================
-- Helper function: is member / role
-- =========================
create or replace function public.is_campaign_member(p_campaign uuid, p_user uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.campaign_members
    where campaign_id = p_campaign and user_id = p_user
  );
$$;

create or replace function public.has_campaign_role(p_campaign uuid, p_user uuid, p_role text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.campaign_members
    where campaign_id = p_campaign and user_id = p_user and role = p_role
  );
$$;
