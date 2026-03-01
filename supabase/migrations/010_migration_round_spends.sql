-- round_spends: stores per-round NIP spend choices made during the spend phase
-- spend_type values: 'recon' | 'mission_pref' | 'underdog'
-- UNIQUE constraint ensures one entry per (campaign, round, user, type)

CREATE TABLE IF NOT EXISTS round_spends (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  user_id      uuid NOT NULL,
  spend_type   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  nip_spent    integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, round_number, user_id, spend_type)
);

ALTER TABLE round_spends ENABLE ROW LEVEL SECURITY;

-- Players can see/insert/delete their own rows
-- Leads and admins can read all rows for their campaigns
CREATE POLICY "round_spends_self_or_lead"
  ON round_spends
  FOR ALL
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM campaign_members cm
      WHERE cm.campaign_id = round_spends.campaign_id
        AND cm.user_id = auth.uid()
        AND cm.role IN ('lead', 'admin')
    )
  );
