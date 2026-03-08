-- Migration: 20260308_alliance_proposal
-- Adds alliance proposal support to the conflicts table.
-- alliance_proposed_by stores the user_id of the player who proposed a ceasefire.
-- NULL  = no proposal active
-- <uid> = that player has proposed an alliance; opponent must accept or decline.
-- When accepted, form-alliance edge function sets status = 'allied' and clears this column.

ALTER TABLE conflicts
  ADD COLUMN IF NOT EXISTS alliance_proposed_by uuid REFERENCES auth.users(id);

-- Index for quick lookup of open proposals
CREATE INDEX IF NOT EXISTS conflicts_alliance_proposed_by_idx
  ON conflicts (alliance_proposed_by)
  WHERE alliance_proposed_by IS NOT NULL;
