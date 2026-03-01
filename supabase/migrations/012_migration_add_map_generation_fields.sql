-- ============================================================
-- Migration: add_map_generation_fields
-- Purpose:   Adds AI image generation tracking columns to the
--            existing `maps` table so generate-map edge function
--            can store prompts, status, and asset paths.
-- Apply via: Supabase Dashboard > SQL Editor, or supabase db push
-- ============================================================

ALTER TABLE public.maps
  -- Deterministic seed used for layout generation + OpenAI prompt
  ADD COLUMN IF NOT EXISTS seed               TEXT,

  -- Layout template: ring | continent | radial | ship_line
  ADD COLUMN IF NOT EXISTS layout             TEXT NOT NULL DEFAULT 'ring',

  -- Number of zones: 4 | 8 | 12
  ADD COLUMN IF NOT EXISTS zone_count         INTEGER NOT NULL DEFAULT 8,

  -- Planet climate profile (uniform or mixed biomes)
  -- Example: { "mode": "uniform", "uniformBiome": "ash_wastes" }
  --          { "mode": "mixed",   "biomes": ["gothic_ruins","ash_wastes"] }
  ADD COLUMN IF NOT EXISTS planet_profile     JSONB,

  -- Ship profile — only populated when layout = 'ship_line'
  -- Example: { "class": "Cruiser", "name": "Vengeful Reliquary of Kharos" }
  ADD COLUMN IF NOT EXISTS ship_profile       JSONB,

  -- Art version string — bump to force regeneration for all campaigns
  ADD COLUMN IF NOT EXISTS art_version        TEXT NOT NULL DEFAULT 'grimdark-v1',

  -- Path in 'campaign-maps' storage bucket to the raw AI background image
  -- (before any overlay/label rendering)
  ADD COLUMN IF NOT EXISTS bg_image_path      TEXT,

  -- Zone thumbnail metadata (populated in Phase 2 when thumb generation added)
  -- Array of { zone_id: number, thumb_path: string }
  ADD COLUMN IF NOT EXISTS thumbs             JSONB,

  -- Cache key: sha-like string of art_version+seed+layout+zone_count+profiles
  -- Used to avoid regenerating identical maps
  ADD COLUMN IF NOT EXISTS cache_key          TEXT,

  -- Generation lifecycle status
  -- none      = no generation requested (legacy rows / manual maps)
  -- pending   = queued but not started
  -- generating = OpenAI call in progress
  -- complete  = image stored, image_path set
  -- failed    = error occurred (check logs)
  ADD COLUMN IF NOT EXISTS generation_status  TEXT NOT NULL DEFAULT 'none';

-- Unique index on cache_key to enable fast cache lookups
-- (nullable values are excluded from uniqueness check in Postgres)
CREATE UNIQUE INDEX IF NOT EXISTS maps_cache_key_unique
  ON public.maps (cache_key)
  WHERE cache_key IS NOT NULL;

-- Index for polling generation status on a campaign's map
CREATE INDEX IF NOT EXISTS maps_generation_status_idx
  ON public.maps (generation_status);

-- ============================================================
-- NOTE: The existing `image_path` column continues to be used
-- as the "final displayed map image". After Phase 2 overlay
-- work, image_path will point to the overlaid version while
-- bg_image_path holds the raw AI output.
-- For Phase 1, both bg_image_path and image_path point to
-- the same raw AI image.
-- ============================================================
