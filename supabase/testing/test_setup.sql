-- =============================================================================
-- SHATTERED HALO — TEST SETUP
-- =============================================================================
-- Run any SCENARIO block independently in the Supabase SQL Editor.
-- All test data is tagged with metadata->>'test': 'true' for clean removal.
-- Run test_cleanup.sql to remove everything created here.
--
-- KNOWN IDs (Embers of the Shattered Halo - Test campaign)
-- -----------------------------------------------------------------------------
-- campaign_id : 9a7ea648-a292-4351-9529-ec75a69d759f
-- lead user   : ce87b3b8-187d-482e-8b53-7d3faef01125  (Space Marines)
-- player user : 01f91ac7-c122-4246-a6fb-fbfcdf70e7b2  (Chaos Space Marines)
-- map_id      : 07ca5b96-0755-4d8c-b098-6f62fc7ff6ee
-- template_id : 8147ef28-7fd8-411b-a35a-b0ff863aae28
--
-- MISSIONS (any can be used in conflict setup)
-- a8699212  Silent Extraction   (control)
-- 5ce04e16  Ashen Skirmish      (skirmish)
-- 388ce403  Forest Ambush       (ambush)
-- 04edf421  Signal Intercept    (control)
-- f0cb0744  Relic Surge         (relic)
-- c14c69ba  Manufactorum Purge  (assault)
-- 4f6a0c5a  Warp Scar Containment (hazard)
-- 52645fc2  Vault Breach        (siege)
-- =============================================================================

-- Convenience variables — edit these once to retarget a different campaign
\set campaign_id '9a7ea648-a292-4351-9529-ec75a69d759f'
\set lead_uid    'ce87b3b8-187d-482e-8b53-7d3faef01125'
\set player_uid  '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2'

-- =============================================================================
-- SCENARIO 0 — FOUNDATION
-- Allocates starting locations, NIP/NCP, and a round row.
-- Run this before any other scenario.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead      UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player    UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';
BEGIN
  RAISE NOTICE 'SCENARIO 0 — Foundation setup';

  -- ── player_state (public) ────────────────────────────────────────────────
  INSERT INTO player_state (campaign_id, user_id, nip, ncp, status, public_location, current_zone_key, current_sector_key)
  VALUES
    (v_campaign, v_lead,   10, 2, 'normal', 'Vault Ruins',   'vault_ruins',   'a'),
    (v_campaign, v_player, 10, 2, 'normal', 'Ash Wastes',    'ash_wastes',    'a')
  ON CONFLICT (campaign_id, user_id) DO UPDATE SET
    nip            = EXCLUDED.nip,
    ncp            = EXCLUDED.ncp,
    status         = EXCLUDED.status,
    public_location = EXCLUDED.public_location,
    current_zone_key = EXCLUDED.current_zone_key,
    current_sector_key = EXCLUDED.current_sector_key;

  -- ── player_state_secret ──────────────────────────────────────────────────
  INSERT INTO player_state_secret (campaign_id, user_id, starting_location, secret_location)
  VALUES
    (v_campaign, v_lead,   'vault_ruins:a', 'vault_ruins:a'),
    (v_campaign, v_player, 'ash_wastes:a',  'ash_wastes:a')
  ON CONFLICT (campaign_id, user_id) DO UPDATE SET
    starting_location = EXCLUDED.starting_location,
    secret_location   = EXCLUDED.secret_location;

  -- ── sectors — give each player a home sector ─────────────────────────────
  INSERT INTO sectors (campaign_id, zone_key, sector_key, owner_user_id, revealed_public, fortified)
  VALUES
    (v_campaign, 'vault_ruins', 'a', v_lead,   true, false),
    (v_campaign, 'ash_wastes',  'a', v_player, true, false)
  ON CONFLICT DO NOTHING;

  -- ── round row ────────────────────────────────────────────────────────────
  INSERT INTO rounds (campaign_id, round_number, stage)
  VALUES (v_campaign, 1, 'conflicts')
  ON CONFLICT (campaign_id, round_number) DO UPDATE SET stage = 'conflicts';

  RAISE NOTICE 'SCENARIO 0 complete — locations set, round 1 in conflicts stage';
END $$;


-- =============================================================================
-- SCENARIO 1 — BASIC CONFLICT
-- Creates one unresolved conflict between lead and player in vault_ruins:b.
-- Mission: Vault Breach (siege). Status: scheduled.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead      UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player    UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';
  v_mission   UUID := '52645fc2-ceca-4ec7-a517-b6c2bcb6db2e';  -- Vault Breach (siege)
  v_conflict  UUID;
BEGIN
  RAISE NOTICE 'SCENARIO 1 — Basic conflict setup';

  INSERT INTO conflicts (campaign_id, round_number, zone_key, sector_key, player_a, player_b, mission_id, mission_status, status, twist_tags)
  VALUES (v_campaign, 1, 'vault_ruins', 'b', v_lead, v_player, v_mission, 'assigned', 'scheduled', '[]')
  RETURNING id INTO v_conflict;

  RAISE NOTICE 'SCENARIO 1 complete — conflict id: %', v_conflict;
END $$;


-- =============================================================================
-- SCENARIO 2 — CONFLICT WITH FIRST RESULT REPORTED
-- Lead has already submitted their result (they claim they won).
-- Player still needs to confirm or dispute.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead      UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player    UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';
  v_mission   UUID := 'c14c69ba-2613-4579-afee-0301c4bccef4';  -- Manufactorum Purge (assault)
  v_conflict  UUID;
BEGIN
  RAISE NOTICE 'SCENARIO 2 — Conflict with first result pending confirmation';

  INSERT INTO conflicts (campaign_id, round_number, zone_key, sector_key, player_a, player_b, mission_id, mission_status, status)
  VALUES (v_campaign, 1, 'sunken_manufactorum', 'b', v_lead, v_player, v_mission, 'assigned', 'scheduled')
  RETURNING id INTO v_conflict;

  -- Lead reports: they won, 2 NIP, 1 NCP
  INSERT INTO battle_results (conflict_id, reported_by, winner_user_id, confirmed, outcome_json)
  VALUES (
    v_conflict, v_lead, v_lead, false,
    jsonb_build_object(
      'winner_user_id', v_lead,
      'nip_earned', 2,
      'ncp_earned', 1,
      'notes', 'Test: lead-reported result awaiting player confirmation'
    )
  );

  RAISE NOTICE 'SCENARIO 2 complete — conflict id: %, result submitted by lead, player confirm pending', v_conflict;
END $$;


-- =============================================================================
-- SCENARIO 3 — DISPUTED RESULT
-- Both players reported different winners. Lead adjudication needed.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead      UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player    UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';
  v_mission   UUID := 'f0cb0744-5f94-434d-b1bc-46daa92ff5f8';  -- Relic Surge (relic)
  v_conflict  UUID;
BEGIN
  RAISE NOTICE 'SCENARIO 3 — Disputed result requiring lead adjudication';

  INSERT INTO conflicts (campaign_id, round_number, zone_key, sector_key, player_a, player_b, mission_id, mission_status, status)
  VALUES (v_campaign, 1, 'halo_spire', 'c', v_lead, v_player, v_mission, 'assigned', 'scheduled')
  RETURNING id INTO v_conflict;

  -- Both reported, flagged as disputed
  INSERT INTO battle_results (conflict_id, reported_by, winner_user_id, confirmed, outcome_json)
  VALUES (
    v_conflict, v_lead, v_lead, true,
    jsonb_build_object(
      'winner_user_id', v_lead,
      'nip_earned', 2,
      'ncp_earned', 0,
      'confirmed_by', v_player,
      'disputed', true,
      'confirmer_winner', v_player,
      'notes', 'Test: both sides claim victory'
    )
  );

  RAISE NOTICE 'SCENARIO 3 complete — conflict id: %, result disputed', v_conflict;
END $$;


-- =============================================================================
-- SCENARIO 4 — PLAYER ON THE EDGE OF ELIMINATION
-- Player has exactly 1 sector. If they lose the next conflict, they are out.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead      UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player    UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';
  v_mission   UUID := 'a8699212-25f4-4f4c-bf37-2fc277fa60d6';  -- Silent Extraction (control)
  v_conflict  UUID;
BEGIN
  RAISE NOTICE 'SCENARIO 4 — Player on edge of elimination (1 sector left)';

  -- Remove any extra sectors the player has, leave only ash_wastes:a
  DELETE FROM sectors
  WHERE campaign_id = v_campaign
    AND owner_user_id = v_player
    AND NOT (zone_key = 'ash_wastes' AND sector_key = 'a');

  -- Ensure the one sector exists
  INSERT INTO sectors (campaign_id, zone_key, sector_key, owner_user_id, revealed_public)
  VALUES (v_campaign, 'ash_wastes', 'a', v_player, true)
  ON CONFLICT DO NOTHING;

  -- Conflict over that last sector
  INSERT INTO conflicts (campaign_id, round_number, zone_key, sector_key, player_a, player_b, mission_id, mission_status, status)
  VALUES (v_campaign, 1, 'ash_wastes', 'a', v_lead, v_player, v_mission, 'assigned', 'scheduled')
  RETURNING id INTO v_conflict;

  RAISE NOTICE 'SCENARIO 4 complete — conflict id: %. Resolve with lead winning to test elimination.', v_conflict;
END $$;


-- =============================================================================
-- SCENARIO 5 — MULTI-CONFLICT ROUND
-- Three conflicts at once to test the conflicts page list view.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead      UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player    UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';
BEGIN
  RAISE NOTICE 'SCENARIO 5 — Multi-conflict round (3 simultaneous)';

  INSERT INTO conflicts (campaign_id, round_number, zone_key, sector_key, player_a, player_b, mission_id, mission_status, status, twist_tags)
  VALUES
    (v_campaign, 1, 'warp_scar_basin',      'a', v_lead, v_player,
     '4f6a0c5a-84b0-493f-92c5-e3f7b911b256', 'assigned', 'scheduled',
     '["power_flicker"]'::jsonb),
    (v_campaign, 1, 'obsidian_fields',      'b', v_lead, v_player,
     '5ce04e16-f7c9-446e-9188-b570342d2176', 'assigned', 'scheduled',
     '[]'::jsonb),
    (v_campaign, 1, 'signal_crater',        'c', v_lead, v_player,
     '04edf421-ce73-470f-a519-ade076044ef8', 'unassigned', 'scheduled',
     '[]'::jsonb);

  RAISE NOTICE 'SCENARIO 5 complete — 3 conflicts created';
END $$;


-- =============================================================================
-- SCENARIO 6 — RESOLVED CONFLICT (past round history)
-- Creates a completed conflict from round 0 with full result + sector transfer.
-- Useful for testing the chronicle generator and past engagements UI.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead      UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player    UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';
  v_mission   UUID := '388ce403-3581-4ca7-bd5f-b2cc2eb415e7';  -- Forest Ambush (ambush)
  v_conflict  UUID;
BEGIN
  RAISE NOTICE 'SCENARIO 6 — Resolved historical conflict (round 0)';

  -- Ensure a round 0 exists
  INSERT INTO rounds (campaign_id, round_number, stage)
  VALUES (v_campaign, 0, 'results')
  ON CONFLICT DO NOTHING;

  INSERT INTO conflicts (campaign_id, round_number, zone_key, sector_key, player_a, player_b, mission_id, mission_status, status)
  VALUES (v_campaign, 0, 'xenos_forest', 'd', v_lead, v_player, v_mission, 'assigned', 'resolved')
  RETURNING id INTO v_conflict;

  INSERT INTO battle_results (conflict_id, reported_by, winner_user_id, confirmed, outcome_json)
  VALUES (
    v_conflict, v_player, v_player, true,
    jsonb_build_object(
      'winner_user_id', v_player,
      'nip_earned', 3,
      'ncp_earned', 1,
      'confirmed_by', v_lead,
      'disputed', false,
      'notes', 'Test: historical resolved battle — player ambushed lead forces in the Xenos Forest'
    )
  );

  -- Give the sector to the winner
  INSERT INTO sectors (campaign_id, zone_key, sector_key, owner_user_id, revealed_public)
  VALUES (v_campaign, 'xenos_forest', 'd', v_player, true)
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'SCENARIO 6 complete — resolved historical conflict id: %', v_conflict;
END $$;


-- =============================================================================
-- SCENARIO 7 — FORCE ROUND STAGE
-- Sets the round to a specific stage for testing stage-gated UI.
-- Edit the stage value as needed.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  -- Valid stages: movement | recon | conflicts | missions | results | spend | publish
  v_stage     TEXT := 'conflicts';
BEGIN
  RAISE NOTICE 'SCENARIO 7 — Setting round stage to: %', v_stage;

  INSERT INTO rounds (campaign_id, round_number, stage)
  VALUES (v_campaign, 1, v_stage)
  ON CONFLICT (campaign_id, round_number) DO UPDATE SET stage = v_stage;

  RAISE NOTICE 'SCENARIO 7 complete — round 1 is now in stage: %', v_stage;
END $$;


-- =============================================================================
-- SCENARIO 8 — GIVE PLAYERS RESOURCES
-- Sets NIP and NCP to test amounts.
-- =============================================================================
DO $$
DECLARE
  v_campaign  UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead      UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player    UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';
  v_nip       INT  := 15;
  v_ncp       INT  := 5;
BEGIN
  RAISE NOTICE 'SCENARIO 8 — Setting resources: NIP=%, NCP=%', v_nip, v_ncp;

  UPDATE player_state
  SET nip = v_nip, ncp = v_ncp
  WHERE campaign_id = v_campaign
    AND user_id IN (v_lead, v_player);

  RAISE NOTICE 'SCENARIO 8 complete';
END $$;


-- =============================================================================
-- VERIFICATION QUERY
-- Run after any scenario to see current test state.
-- =============================================================================
SELECT
  'conflicts' AS table_name,
  c.id, c.round_number, c.zone_key, c.sector_key, c.status, c.mission_status,
  m.name AS mission_name,
  (SELECT COUNT(*) FROM battle_results br WHERE br.conflict_id = c.id) AS result_count,
  (SELECT confirmed FROM battle_results br WHERE br.conflict_id = c.id LIMIT 1) AS result_confirmed
FROM conflicts c
LEFT JOIN missions m ON m.id = c.mission_id
WHERE c.campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f'
ORDER BY c.round_number, c.created_at;
