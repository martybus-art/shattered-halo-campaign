-- ============================================================
-- Migration 006: Performance - RLS policy optimisation
-- 
-- What this does (three things):
--
-- 1. Wraps all auth.uid() / auth.role() calls in (select ...)
--    so Postgres evaluates them ONCE per query instead of once
--    per row. Affects ~40 policies across 15 tables.
--
-- 2. Merges duplicate SELECT/INSERT policies on the same table
--    into single policies using OR conditions. Postgres runs ALL
--    permissive policies and ORs the results, so two policies
--    doing the same job costs double. Affected tables:
--      - player_state (3 SELECT -> 1, including dropping the
--        accidental duplicate player_state_select_self)
--      - campaign_members (2 UPDATE -> 1)
--      - conflicts (2 SELECT -> 1)
--      - ledger (2 SELECT -> 1)
--      - moves (2 SELECT -> 1)
--      - posts (2 SELECT -> 1, 2 INSERT -> 1)
--      - recon_ops (2 SELECT -> 1)
--      - sectors (2 SELECT -> 1)
--
-- 3. Drops the duplicate index on player_state.
--    player_state_unique_user_campaign is identical to the
--    primary key index and wastes write overhead.
--
-- Safe to run on live DB. All DROP POLICY + CREATE POLICY
-- operations are fast metadata changes with no data loss.
-- ============================================================


-- ============================================================
-- TEMPLATES
-- ============================================================
drop policy if exists "templates_read_auth" on public.templates;
create policy "templates_read_auth"
on public.templates for select
using ((select auth.role()) = 'authenticated');


-- ============================================================
-- CAMPAIGNS
-- ============================================================
drop policy if exists "campaigns_read_members" on public.campaigns;
create policy "campaigns_read_members"
on public.campaigns for select
using (public.is_campaign_member(id, (select auth.uid())));


-- ============================================================
-- CAMPAIGN MEMBERS
-- members_update_self and members_set_faction_once both check
-- user_id = auth.uid() - identical condition, merged into one.
-- ============================================================
drop policy if exists "members_read_members" on public.campaign_members;
drop policy if exists "members_update_self" on public.campaign_members;
drop policy if exists "members_set_faction_once" on public.campaign_members;

create policy "members_read_members"
on public.campaign_members for select
using (public.is_campaign_member(campaign_id, (select auth.uid())));

create policy "members_update_self"
on public.campaign_members for update
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));


-- ============================================================
-- SECTORS
-- Merged: revealed sectors (public) OR owned sectors (private)
-- ============================================================
drop policy if exists "sectors_public_reveals" on public.sectors;
drop policy if exists "sectors_owner_private_view" on public.sectors;

create policy "sectors_read"
on public.sectors for select
using (
  (revealed_public = true)
  or (
    public.is_campaign_member(campaign_id, (select auth.uid()))
    and owner_user_id = (select auth.uid())
  )
);


-- ============================================================
-- PLAYER STATE
-- Three SELECT policies -> one. player_state_select_self was an
-- accidental duplicate of player_state_read_self.
-- ============================================================
drop policy if exists "player_state_read_self" on public.player_state;
drop policy if exists "player_state_read_admin" on public.player_state;
drop policy if exists "player_state_select_self" on public.player_state;
drop policy if exists "player_state_insert_self" on public.player_state;
drop policy if exists "player_state_update_self" on public.player_state;

create policy "player_state_read"
on public.player_state for select
using (
  user_id = (select auth.uid())
  or public.has_campaign_role(campaign_id, (select auth.uid()), 'admin')
);

create policy "player_state_insert_self"
on public.player_state for insert
with check (
  user_id = (select auth.uid())
  and public.is_campaign_member(campaign_id, (select auth.uid()))
);

create policy "player_state_update_self"
on public.player_state for update
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));


-- ============================================================
-- PLAYER STATE SECRET
-- ============================================================
drop policy if exists "pss_select_self" on public.player_state_secret;

create policy "pss_select_self"
on public.player_state_secret for select
using (user_id = (select auth.uid()));


-- ============================================================
-- LEDGER
-- ============================================================
drop policy if exists "ledger_read_self" on public.ledger;
drop policy if exists "ledger_read_admin" on public.ledger;

create policy "ledger_read"
on public.ledger for select
using (
  user_id = (select auth.uid())
  or public.has_campaign_role(campaign_id, (select auth.uid()), 'admin')
);


-- ============================================================
-- ROUNDS
-- ============================================================
drop policy if exists "rounds_read_members" on public.rounds;

create policy "rounds_read_members"
on public.rounds for select
using (public.is_campaign_member(campaign_id, (select auth.uid())));


-- ============================================================
-- MOVES
-- ============================================================
drop policy if exists "moves_read_self" on public.moves;
drop policy if exists "moves_read_admin" on public.moves;
drop policy if exists "moves_upsert_self" on public.moves;
drop policy if exists "moves_update_self" on public.moves;

create policy "moves_read"
on public.moves for select
using (
  user_id = (select auth.uid())
  or public.has_campaign_role(campaign_id, (select auth.uid()), 'admin')
);

create policy "moves_upsert_self"
on public.moves for insert
with check (
  user_id = (select auth.uid())
  and public.is_campaign_member(campaign_id, (select auth.uid()))
);

create policy "moves_update_self"
on public.moves for update
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));


-- ============================================================
-- RECON OPS
-- ============================================================
drop policy if exists "recon_read_self" on public.recon_ops;
drop policy if exists "recon_read_admin" on public.recon_ops;
drop policy if exists "recon_insert_self" on public.recon_ops;
drop policy if exists "recon_update_self" on public.recon_ops;

create policy "recon_read"
on public.recon_ops for select
using (
  user_id = (select auth.uid())
  or public.has_campaign_role(campaign_id, (select auth.uid()), 'admin')
);

create policy "recon_insert_self"
on public.recon_ops for insert
with check (
  user_id = (select auth.uid())
  and public.is_campaign_member(campaign_id, (select auth.uid()))
);

create policy "recon_update_self"
on public.recon_ops for update
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));


-- ============================================================
-- CONFLICTS
-- ============================================================
drop policy if exists "conflicts_read_involved" on public.conflicts;
drop policy if exists "conflicts_read_admin" on public.conflicts;

create policy "conflicts_read"
on public.conflicts for select
using (
  (
    public.is_campaign_member(campaign_id, (select auth.uid()))
    and (player_a = (select auth.uid()) or player_b = (select auth.uid()))
  )
  or public.has_campaign_role(campaign_id, (select auth.uid()), 'admin')
);


-- ============================================================
-- BATTLE RESULTS
-- ============================================================
drop policy if exists "battle_results_read_involved" on public.battle_results;
drop policy if exists "battle_results_insert_involved" on public.battle_results;
drop policy if exists "battle_results_update_reporter" on public.battle_results;

create policy "battle_results_read_involved"
on public.battle_results for select
using (
  exists (
    select 1 from public.conflicts c
    where c.id = conflict_id
      and public.is_campaign_member(c.campaign_id, (select auth.uid()))
      and (c.player_a = (select auth.uid()) or c.player_b = (select auth.uid()))
  )
);

create policy "battle_results_insert_involved"
on public.battle_results for insert
with check (
  exists (
    select 1 from public.conflicts c
    where c.id = conflict_id
      and (c.player_a = (select auth.uid()) or c.player_b = (select auth.uid()))
  )
);

create policy "battle_results_update_reporter"
on public.battle_results for update
using (reported_by = (select auth.uid()))
with check (reported_by = (select auth.uid()));


-- ============================================================
-- MISSIONS
-- ============================================================
drop policy if exists "missions_read_auth" on public.missions;

create policy "missions_read_auth"
on public.missions for select
using ((select auth.role()) = 'authenticated');


-- ============================================================
-- MISSION INFLUENCE
-- ============================================================
drop policy if exists "mission_influence_read_involved" on public.mission_influence;
drop policy if exists "mission_influence_insert_involved" on public.mission_influence;

create policy "mission_influence_read_involved"
on public.mission_influence for select
using (
  exists (
    select 1 from public.conflicts c
    where c.id = conflict_id
      and (c.player_a = (select auth.uid()) or c.player_b = (select auth.uid()))
  )
);

create policy "mission_influence_insert_involved"
on public.mission_influence for insert
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.conflicts c
    where c.id = conflict_id
      and (c.player_a = (select auth.uid()) or c.player_b = (select auth.uid()))
  )
);


-- ============================================================
-- POSTS
-- SELECT: public posts for members OR private posts for audience
-- INSERT: public by lead/admin OR private by self
-- ============================================================
drop policy if exists "posts_read_public_members" on public.posts;
drop policy if exists "posts_read_private_audience" on public.posts;
drop policy if exists "posts_insert_public_lead_admin" on public.posts;
drop policy if exists "posts_insert_private_self" on public.posts;

create policy "posts_read"
on public.posts for select
using (
  (visibility = 'public' and public.is_campaign_member(campaign_id, (select auth.uid())))
  or (visibility = 'private' and audience_user_id = (select auth.uid()))
);

create policy "posts_insert"
on public.posts for insert
with check (
  (
    visibility = 'public'
    and public.is_campaign_member(campaign_id, (select auth.uid()))
    and (
      public.has_campaign_role(campaign_id, (select auth.uid()), 'lead')
      or public.has_campaign_role(campaign_id, (select auth.uid()), 'admin')
    )
  )
  or (
    visibility = 'private'
    and audience_user_id = (select auth.uid())
    and public.is_campaign_member(campaign_id, (select auth.uid()))
  )
);


-- ============================================================
-- PENDING INVITES
-- ============================================================
drop policy if exists "pending_invites_read_lead_admin" on public.pending_invites;

create policy "pending_invites_read_lead_admin"
on public.pending_invites for select
using (
  public.is_campaign_member(campaign_id, (select auth.uid()))
  and (
    public.has_campaign_role(campaign_id, (select auth.uid()), 'lead')
    or public.has_campaign_role(campaign_id, (select auth.uid()), 'admin')
  )
);


-- ============================================================
-- CAMPAIGN RELICS
-- ============================================================
drop policy if exists "campaign_relics_read_members" on public.campaign_relics;

create policy "campaign_relics_read_members"
on public.campaign_relics for select
using (public.is_campaign_member(campaign_id, (select auth.uid())));


-- ============================================================
-- CAMPAIGN EVENTS
-- ============================================================
drop policy if exists "campaign_events_read_members" on public.campaign_events;

create policy "campaign_events_read_members"
on public.campaign_events for select
using (public.is_campaign_member(campaign_id, (select auth.uid())));

-- ============================================================
-- DUPLICATE CONSTRAINT
-- player_state_unique_user_campaign duplicates the primary key.
-- DROP CONSTRAINT removes the index automatically.
-- Safe to re-run: IF EXISTS means it's a no-op if already done.
-- ============================================================
alter table public.player_state
  drop constraint if exists player_state_unique_user_campaign;
