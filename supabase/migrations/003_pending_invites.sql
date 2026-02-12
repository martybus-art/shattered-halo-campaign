-- Pending invites for users who haven't signed up yet.
create table if not exists public.pending_invites (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  email text not null,
  role text not null default 'player', -- invited role; creator is always lead via campaign_members
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (campaign_id, email)
);

alter table public.pending_invites enable row level security;

-- Members can read invites for their campaign only if they are lead/admin (prevents leaking who is invited)
create policy "pending_invites_read_lead_admin"
on public.pending_invites for select
using (
  public.is_campaign_member(campaign_id, auth.uid())
  and (public.has_campaign_role(campaign_id, auth.uid(), 'lead') or public.has_campaign_role(campaign_id, auth.uid(), 'admin'))
);

-- No direct inserts/updates by clients; handled by edge functions with service role.
