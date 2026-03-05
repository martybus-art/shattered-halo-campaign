-- Migration: underdog_choices
-- Creates the table that tracks catchup offers from the lead player to the
-- identified underdog (player with fewest sectors) at the end of a results stage.
-- Run this in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.underdog_choices (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid        NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  round_number   integer     NOT NULL,
  user_id        uuid        NOT NULL,   -- the underdog player receiving the offer
  offered_by     uuid        NOT NULL,   -- lead who triggered the offer
  offered_at     timestamptz NOT NULL DEFAULT now(),
  chosen_option  text,                   -- null until the player accepts
  chosen_at      timestamptz,
  status         text        NOT NULL DEFAULT 'pending', -- pending | accepted | expired
  UNIQUE (campaign_id, round_number, user_id)
);

ALTER TABLE public.underdog_choices ENABLE ROW LEVEL SECURITY;

-- Lead/admin: full access on their own campaigns
CREATE POLICY underdog_choices_lead
  ON public.underdog_choices
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.campaign_members cm
      WHERE cm.campaign_id = underdog_choices.campaign_id
        AND cm.user_id = auth.uid()
        AND cm.role IN ('lead', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.campaign_members cm
      WHERE cm.campaign_id = underdog_choices.campaign_id
        AND cm.user_id = auth.uid()
        AND cm.role IN ('lead', 'admin')
    )
  );

-- Player: can read their own offer
CREATE POLICY underdog_choices_player_read
  ON public.underdog_choices
  FOR SELECT
  USING (user_id = auth.uid());

-- Player: can accept (update) their own pending offer
CREATE POLICY underdog_choices_player_update
  ON public.underdog_choices
  FOR UPDATE
  USING (user_id = auth.uid() AND status = 'pending')
  WITH CHECK (user_id = auth.uid());
