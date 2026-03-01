-- =============================================================================
-- SHATTERED HALO — TEST CLEANUP
-- =============================================================================
-- Removes all test-created data from the Embers of the Shattered Halo - Test
-- campaign WITHOUT deleting the campaign itself, its members, or their factions.
--
-- Safe to run multiple times (idempotent).
-- Run this before going live or before re-running test scenarios from scratch.
--
-- What this REMOVES:
--   conflicts + battle_results + mission_influence (current campaign)
--   sectors (owned by either test player)
--   player_state location / NIP / NCP resets to zero
--   player_state_secret location clears
--   rounds rows (stage data)
--   moves rows
--   ledger entries
--   posts (test bulletins)
--   campaign_events
--   recon_ops
--
-- What this PRESERVES:
--   campaigns row
--   campaign_members rows (players stay enrolled)
--   faction assignments
--   missions + templates
--   maps
-- =============================================================================

DO $$
DECLARE
  v_campaign UUID := '9a7ea648-a292-4351-9529-ec75a69d759f';
  v_lead     UUID := 'ce87b3b8-187d-482e-8b53-7d3faef01125';
  v_player   UUID := '01f91ac7-c122-4246-a6fb-fbfcdf70e7b2';

  v_conflict_ids UUID[];
  v_deleted_conflicts  INT;
  v_deleted_results    INT;
  v_deleted_influence  INT;
  v_deleted_sectors    INT;
  v_deleted_moves      INT;
  v_deleted_ledger     INT;
  v_deleted_rounds     INT;
  v_deleted_events     INT;
  v_deleted_recon      INT;
  v_deleted_posts      INT;
BEGIN
  RAISE NOTICE '=== SHATTERED HALO TEST CLEANUP ===';
  RAISE NOTICE 'Campaign: %', v_campaign;

  -- ── Gather conflict IDs first (needed for child table deletes) ────────────
  SELECT ARRAY_AGG(id) INTO v_conflict_ids
  FROM conflicts
  WHERE campaign_id = v_campaign;

  -- ── battle_results ────────────────────────────────────────────────────────
  IF v_conflict_ids IS NOT NULL THEN
    DELETE FROM battle_results WHERE conflict_id = ANY(v_conflict_ids);
    GET DIAGNOSTICS v_deleted_results = ROW_COUNT;
    RAISE NOTICE 'Deleted battle_results: %', v_deleted_results;

    DELETE FROM mission_influence WHERE conflict_id = ANY(v_conflict_ids);
    GET DIAGNOSTICS v_deleted_influence = ROW_COUNT;
    RAISE NOTICE 'Deleted mission_influence: %', v_deleted_influence;
  END IF;

  -- ── conflicts ─────────────────────────────────────────────────────────────
  DELETE FROM conflicts WHERE campaign_id = v_campaign;
  GET DIAGNOSTICS v_deleted_conflicts = ROW_COUNT;
  RAISE NOTICE 'Deleted conflicts: %', v_deleted_conflicts;

  -- ── sectors ───────────────────────────────────────────────────────────────
  DELETE FROM sectors WHERE campaign_id = v_campaign;
  GET DIAGNOSTICS v_deleted_sectors = ROW_COUNT;
  RAISE NOTICE 'Deleted sectors: %', v_deleted_sectors;

  -- ── moves ─────────────────────────────────────────────────────────────────
  DELETE FROM moves WHERE campaign_id = v_campaign;
  GET DIAGNOSTICS v_deleted_moves = ROW_COUNT;
  RAISE NOTICE 'Deleted moves: %', v_deleted_moves;

  -- ── ledger ────────────────────────────────────────────────────────────────
  DELETE FROM ledger WHERE campaign_id = v_campaign;
  GET DIAGNOSTICS v_deleted_ledger = ROW_COUNT;
  RAISE NOTICE 'Deleted ledger entries: %', v_deleted_ledger;

  -- ── rounds ────────────────────────────────────────────────────────────────
  DELETE FROM rounds WHERE campaign_id = v_campaign;
  GET DIAGNOSTICS v_deleted_rounds = ROW_COUNT;
  RAISE NOTICE 'Deleted rounds: %', v_deleted_rounds;

  -- ── campaign_events ───────────────────────────────────────────────────────
  DELETE FROM campaign_events WHERE campaign_id = v_campaign;
  GET DIAGNOSTICS v_deleted_events = ROW_COUNT;
  RAISE NOTICE 'Deleted campaign_events: %', v_deleted_events;

  -- ── recon_ops ─────────────────────────────────────────────────────────────
  DELETE FROM recon_ops WHERE campaign_id = v_campaign;
  GET DIAGNOSTICS v_deleted_recon = ROW_COUNT;
  RAISE NOTICE 'Deleted recon_ops: %', v_deleted_recon;

  -- ── posts ─────────────────────────────────────────────────────────────────
  DELETE FROM posts WHERE campaign_id = v_campaign;
  GET DIAGNOSTICS v_deleted_posts = ROW_COUNT;
  RAISE NOTICE 'Deleted posts: %', v_deleted_posts;

  -- ── Reset player_state (zero resources, clear location) ──────────────────
  UPDATE player_state
  SET
    nip                = 0,
    ncp                = 0,
    status             = 'normal',
    public_location    = NULL,
    current_zone_key   = 'unknown',
    current_sector_key = 'unknown',
    starting_location  = NULL
  WHERE campaign_id = v_campaign;
  RAISE NOTICE 'Reset player_state: % rows', (SELECT COUNT(*) FROM player_state WHERE campaign_id = v_campaign);

  -- ── Clear player_state_secret locations ───────────────────────────────────
  UPDATE player_state_secret
  SET
    starting_location = NULL,
    secret_location   = NULL
  WHERE campaign_id = v_campaign;
  RAISE NOTICE 'Cleared player_state_secret: % rows', (SELECT COUNT(*) FROM player_state_secret WHERE campaign_id = v_campaign);

  -- ── Reset campaign counters ───────────────────────────────────────────────
  UPDATE campaigns
  SET
    round_number = 1,
    instability  = 0,
    phase        = 1
  WHERE id = v_campaign;
  RAISE NOTICE 'Reset campaign to round 1, phase 1, instability 0';

  RAISE NOTICE '=== CLEANUP COMPLETE ===';
END $$;


-- =============================================================================
-- POST-CLEANUP VERIFICATION
-- Should show empty tables and reset values.
-- =============================================================================
SELECT 'After cleanup:' AS status;

SELECT
  (SELECT COUNT(*) FROM conflicts        WHERE campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f') AS conflicts,
  (SELECT COUNT(*) FROM sectors          WHERE campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f') AS sectors,
  (SELECT COUNT(*) FROM rounds           WHERE campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f') AS rounds,
  (SELECT COUNT(*) FROM moves            WHERE campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f') AS moves,
  (SELECT COUNT(*) FROM ledger           WHERE campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f') AS ledger,
  (SELECT COUNT(*) FROM campaign_events  WHERE campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f') AS events,
  (SELECT COUNT(*) FROM posts            WHERE campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f') AS posts;

SELECT
  user_id,
  nip, ncp, status,
  public_location, current_zone_key
FROM player_state
WHERE campaign_id = '9a7ea648-a292-4351-9529-ec75a69d759f';
