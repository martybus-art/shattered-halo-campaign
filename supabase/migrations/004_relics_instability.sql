-- Relics + Instability Event Tables (Evolution Pack)

create table if not exists public.relics (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id) on delete cascade,
  name text not null,
  lore text not null default '',
  rarity text not null default 'common',
  phase_min int not null default 1,
  zone_tags jsonb not null default '[]'::jsonb,
  effect_json jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists relics_template_idx on public.relics(template_id);

create table if not exists public.campaign_relics (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  relic_id uuid not null references public.relics(id) on delete restrict,
  controller_user_id uuid references auth.users(id),
  status text not null default 'unknown',
  discovered_round int,
  claimed_round int,
  notes text not null default '',
  created_at timestamptz not null default now(),
  unique (campaign_id, relic_id)
);

create index if not exists campaign_relics_campaign_idx on public.campaign_relics(campaign_id);
create index if not exists campaign_relics_controller_idx on public.campaign_relics(controller_user_id);

create table if not exists public.instability_events (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id) on delete cascade,
  threshold_min int not null default 0,
  d10 int not null check (d10 between 1 and 10),
  name text not null,
  public_text text not null,
  effect_json jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (template_id, threshold_min, d10)
);

create index if not exists instability_events_template_idx on public.instability_events(template_id);

create table if not exists public.campaign_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  round_number int not null,
  instability_after int not null,
  event_name text not null,
  event_roll int,
  visibility text not null default 'public',
  effect_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists campaign_events_campaign_idx on public.campaign_events(campaign_id);

alter table public.relics enable row level security;
alter table public.campaign_relics enable row level security;
alter table public.instability_events enable row level security;
alter table public.campaign_events enable row level security;

create policy "relics_read_all"
on public.relics for select
using (true);

create policy "campaign_relics_read_members"
on public.campaign_relics for select
using (public.is_campaign_member(campaign_id, auth.uid()));

create policy "instability_events_read_all"
on public.instability_events for select
using (true);

create policy "campaign_events_read_members"
on public.campaign_events for select
using (public.is_campaign_member(campaign_id, auth.uid()));

-- No direct inserts/updates/deletes from clients; handled by edge functions with service role.
