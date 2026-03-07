-- migration: 008_admin_adjustments
-- description: Creates admin_adjustments audit log table for lead/admin
--              manual overrides to player resources, sector ownership, and
--              campaign instability. Used by AdminPanel.tsx and the three
--              admin-* edge functions.
-- changelog:
--   2026-03-07 -- Initial creation.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.admin_adjustments (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  adjusted_by      uuid not null references auth.users(id),
  player_id        uuid references auth.users(id),          -- null for instability adjustments
  adjustment_type  text not null check (adjustment_type in ('nip', 'ncp', 'sector_owner', 'instability')),
  old_value        text,
  new_value        text,
  delta            integer,                                  -- null for sector_owner changes
  reason           text not null,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------

create index if not exists admin_adjustments_campaign_created_idx
  on public.admin_adjustments (campaign_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.admin_adjustments enable row level security;

-- Lead and admin members of the campaign can read the audit log
create policy "admin_adjustments_select_lead_admin"
  on public.admin_adjustments
  for select
  using (
    exists (
      select 1 from public.campaign_members cm
      where cm.campaign_id = admin_adjustments.campaign_id
        and cm.user_id     = auth.uid()
        and cm.role        in ('lead', 'admin')
    )
  );

-- Only service role (edge functions using adminClient) can insert.
-- No direct client insert policy — all writes go through edge functions.
