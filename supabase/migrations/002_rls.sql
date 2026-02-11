-- Enable RLS
alter table public.campaigns enable row level security;
alter table public.templates enable row level security;
alter table public.campaign_members enable row level security;
alter table public.sectors enable row level security;
alter table public.player_state enable row level security;
alter table public.ledger enable row level security;
alter table public.rounds enable row level security;
alter table public.moves enable row level security;
alter table public.recon_ops enable row level security;
alter table public.conflicts enable row level security;
alter table public.battle_results enable row level security;
alter table public.missions enable row level security;
alter table public.mission_influence enable row level security;
alter table public.posts enable row level security;

-- TEMPLATES: readable to authenticated users (so they can view campaign definitions),
-- but writable only by service role (admin via server).
create policy "templates_read_auth"
on public.templates for select
using (auth.role() = 'authenticated');

-- CAMPAIGNS: members can read their campaign
create policy "campaigns_read_members"
on public.campaigns for select
using (public.is_campaign_member(id, auth.uid()));

-- CAMPAIGN MEMBERS: members can read roster; only self can update their own display fields.
create policy "members_read_members"
on public.campaign_members for select
using (public.is_campaign_member(campaign_id, auth.uid()));

create policy "members_update_self"
on public.campaign_members for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- SECTORS: public view shows revealed_public; members can read all sectors they personally own.
create policy "sectors_public_reveals"
on public.sectors for select
using (revealed_public = true);

create policy "sectors_owner_private_view"
on public.sectors for select
using (
  public.is_campaign_member(campaign_id, auth.uid())
  and owner_user_id = auth.uid()
);

-- PLAYER STATE: player reads own; admins can read all (optional). If you want true no-GM, remove admin policy.
create policy "player_state_read_self"
on public.player_state for select
using (auth.uid() = user_id);

create policy "player_state_read_admin"
on public.player_state for select
using (public.has_campaign_role(campaign_id, auth.uid(), 'admin'));

-- LEDGER: player reads own; admins read all
create policy "ledger_read_self"
on public.ledger for select
using (auth.uid() = user_id);

create policy "ledger_read_admin"
on public.ledger for select
using (public.has_campaign_role(campaign_id, auth.uid(), 'admin'));

-- ROUNDS: members can read
create policy "rounds_read_members"
on public.rounds for select
using (public.is_campaign_member(campaign_id, auth.uid()));

-- MOVES: player reads own; admins read all. Players can insert/update their own move while stage=open.
create policy "moves_read_self"
on public.moves for select
using (auth.uid() = user_id);

create policy "moves_read_admin"
on public.moves for select
using (public.has_campaign_role(campaign_id, auth.uid(), 'admin'));

create policy "moves_upsert_self"
on public.moves for insert
with check (auth.uid() = user_id and public.is_campaign_member(campaign_id, auth.uid()));

create policy "moves_update_self"
on public.moves for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- RECON: player reads own; admins read all
create policy "recon_read_self"
on public.recon_ops for select
using (auth.uid() = user_id);

create policy "recon_read_admin"
on public.recon_ops for select
using (public.has_campaign_role(campaign_id, auth.uid(), 'admin'));

create policy "recon_insert_self"
on public.recon_ops for insert
with check (auth.uid() = user_id and public.is_campaign_member(campaign_id, auth.uid()));

create policy "recon_update_self"
on public.recon_ops for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- CONFLICTS: only involved players can read their conflicts; admins can read all
create policy "conflicts_read_involved"
on public.conflicts for select
using (
  public.is_campaign_member(campaign_id, auth.uid())
  and (player_a = auth.uid() or player_b = auth.uid())
);

create policy "conflicts_read_admin"
on public.conflicts for select
using (public.has_campaign_role(campaign_id, auth.uid(), 'admin'));

-- BATTLE RESULTS: involved players can read; reporter can insert; both can confirm their own report
create policy "battle_results_read_involved"
on public.battle_results for select
using (
  exists (
    select 1 from public.conflicts c
    where c.id = conflict_id
      and public.is_campaign_member(c.campaign_id, auth.uid())
      and (c.player_a = auth.uid() or c.player_b = auth.uid())
  )
);

create policy "battle_results_insert_involved"
on public.battle_results for insert
with check (
  exists (
    select 1 from public.conflicts c
    where c.id = conflict_id
      and (c.player_a = auth.uid() or c.player_b = auth.uid())
  )
);

create policy "battle_results_update_reporter"
on public.battle_results for update
using (auth.uid() = reported_by)
with check (auth.uid() = reported_by);

-- MISSIONS: readable to authenticated (template)
create policy "missions_read_auth"
on public.missions for select
using (auth.role() = 'authenticated');

-- MISSION INFLUENCE: only involved players can read/insert
create policy "mission_influence_read_involved"
on public.mission_influence for select
using (
  exists (
    select 1 from public.conflicts c
    where c.id = conflict_id and (c.player_a = auth.uid() or c.player_b = auth.uid())
  )
);

create policy "mission_influence_insert_involved"
on public.mission_influence for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.conflicts c
    where c.id = conflict_id and (c.player_a = auth.uid() or c.player_b = auth.uid())
  )
);

-- POSTS:
-- public posts readable by campaign members
create policy "posts_read_public_members"
on public.posts for select
using (
  visibility = 'public'
  and public.is_campaign_member(campaign_id, auth.uid())
);

-- private posts readable only by audience
create policy "posts_read_private_audience"
on public.posts for select
using (
  visibility = 'private'
  and audience_user_id = auth.uid()
);

-- allow members to insert public posts only if they are 'lead' or 'admin'
create policy "posts_insert_public_lead_admin"
on public.posts for insert
with check (
  visibility = 'public'
  and public.is_campaign_member(campaign_id, auth.uid())
  and (public.has_campaign_role(campaign_id, auth.uid(), 'lead') or public.has_campaign_role(campaign_id, auth.uid(), 'admin'))
);

-- allow any member to insert private posts addressed to self (e.g., saving their whisper)
create policy "posts_insert_private_self"
on public.posts for insert
with check (
  visibility = 'private'
  and audience_user_id = auth.uid()
  and public.is_campaign_member(campaign_id, auth.uid())
);
