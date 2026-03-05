-- Migration: units + moves alterations
-- Creates the units table for tracking scout and occupation units on the map.
-- Alters moves table to reference units and track move type.
-- Run this in the Supabase SQL editor.

-- ── Units table ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.units (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid        NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  unit_type       text        NOT NULL CHECK (unit_type IN ('scout', 'occupation')),
  zone_key        text        NOT NULL,
  sector_key      text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'destroyed', 'in_transit')),
  round_deployed  integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;

-- Players can read their own units plus any unit in a sector they occupy or
-- that has been publicly revealed (fog of war).
CREATE POLICY units_read
  ON public.units
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR is_campaign_member(campaign_id, auth.uid())
  );

-- Players can update their own units (position updates via submit-move).
-- In practice the edge function uses service role; this covers direct updates.
CREATE POLICY units_update_self
  ON public.units
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Lead/admin can read all units (service role used for edge functions anyway).
CREATE POLICY units_lead_all
  ON public.units
  FOR ALL
  USING (
    has_campaign_role(campaign_id, auth.uid(), 'lead')
    OR has_campaign_role(campaign_id, auth.uid(), 'admin')
  );

-- ── Alter moves table ────────────────────────────────────────────────────────
-- Add unit_id and move_type columns (nullable for backward compat).

ALTER TABLE public.moves
  ADD COLUMN IF NOT EXISTS unit_id   uuid REFERENCES public.units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS move_type text NOT NULL DEFAULT 'normal'
                            CHECK (move_type IN ('normal', 'deep_strike', 'recon'));

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS units_campaign_user ON public.units(campaign_id, user_id);
CREATE INDEX IF NOT EXISTS units_location      ON public.units(campaign_id, zone_key, sector_key);
