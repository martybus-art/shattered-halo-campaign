-- Migration 008: Add invite_message column to campaigns
-- Stores the AI-generated narrative blurb used in player invite emails
-- Safe to run: uses IF NOT EXISTS guard

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS invite_message TEXT DEFAULT NULL;

COMMENT ON COLUMN public.campaigns.invite_message IS
  'AI-generated narrative invite text shown to players when they receive a campaign invite';
