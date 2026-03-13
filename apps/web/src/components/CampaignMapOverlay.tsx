"use client";

/**
 * CampaignMapOverlay
 *
 * Renders the AI-generated campaign map image with a live tactical SVG overlay
 * showing zone colouring and per-sector occupancy state (units, held, enemy,
 * fog-of-war, etc.).
 *
 * Accepts DB row shapes directly — no pre-conversion needed in the page.
 *
 * Supported layouts:
 *   "ring"      — fully implemented (ring/halo megastructure)
 *   "spokes"    — fully implemented (hub + spoke wedges radiating from centre)
 *   "continent" — fully implemented (planet sphere with clustered wedge-continents)
 *   "void_ship" — fully implemented (rectangular 2-column port/starboard grid)
 *   others      — image shown without overlay (stub, extend as needed)
 *
 * Sector key → overlay position mapping (ring layout):
 *   "a" = inner band, first angular half  (inner-leading)
 *   "b" = inner band, second angular half (inner-trailing)
 *   "c" = outer band, first angular half  (outer-leading)
 *   "d" = outer band, second angular half (outer-trailing)
 *
 * Map Calibration (lead only):
 *   When isLead=true a "Calibrate Overlay" toggle appears below the map.
 *   The panel exposes 5 sliders that control how the SVG ellipse aligns to
 *   the background image. Values are saved to localStorage keyed by campaignId so
 *   each map remembers its own settings independently. A "Copy Config" button
 *   outputs a ready-to-paste TypeScript snippet for hardcoding the values once
 *   calibration is complete.
 *
 * Deploy to: apps/web/src/components/CampaignMapOverlay.tsx
 *
 * changelog:
 *   2026-03-10 — FEATURE: Map Calibration panel (lead only). RingConfig type
 *                replaces all module-level geometry constants. All geometry
 *                functions (polarToCartesian, wedgePath, wedgeCentroid,
 *                useRingGeometry, RingOverlay) now accept cfg: RingConfig
 *                so slider values flow through to every path without reload.
 *                New props: isLead?: boolean, campaignId?: string.
 *                useCalibConfig hook handles localStorage init/persist/reset.
 *                CalibrationPanel component renders sliders + Copy Config.
 *   2026-03-10 — TUNE: RING_INNER 250->275, RING_OUTER 430->480,
 *                PERSPECTIVE_Y 0.60->0.55, CY 415->410 (pass 2 alignment).
 *   2026-03-10 — FIX: Elliptical arc perspective correction. polarToCartesian
 *                applies PERSPECTIVE_Y to Y axis; wedgePath uses separate
 *                rx/ry in SVG arc commands. CY shifted 500->415.
 *   2026-03-11 — FEATURE: Spokes layout overlay. SpokesConfig type + sliders,
 *                pieSectorPath for centre hub, useSpokesGeometry, SpokesOverlay.
 *                CalibrationPanel generalised (sliderDefs + buildCopySnippet props).
 *                Zone key convention: zoneKeys[0] = centre zone, zoneKeys[1..N]
 *                = outer zones clockwise. spokeGapDeg slider controls wedge width.
 *   2026-03-14 — FEATURE: Continent layout overlay. ContinentConfig type + sliders,
 *                useContinentGeometry, ContinentOverlay. Planet sphere with clustered
 *                wedge-zones converging to a near-point (innerRFraction). Cluster/zone
 *                count logic mirrors buildAdjacency "continent" in page.tsx. Reuses
 *                wedgePath / wedgeCentroid / polarToCartesian throughout.
 *   2026-03-14 — FEATURE: Voidship layout overlay. VoidshipConfig type + sliders,
 *                useVoidshipGeometry, VoidshipOverlay. Rectangular 2-column (port /
 *                starboard) zone grid with no wedges. New rectPath / rectCentroid
 *                helpers and SECTOR_GRID lookup for 2×2 sub-rect sector subdivision.
 *                MapLayout type extended with "void_ship" (DB-native spelling).
 *   2026-03-14 — UPDATE: Main export calls all 4 layout hooks unconditionally.
 *                isOverlayLayout in page.tsx extended to include "continent" and
 *                "void_ship". Stub fallback narrowed to truly unimplemented types.
 */

import React, { useCallback, useMemo, useState } from "react";

// ── Public types ───────────────────────────────────────────────────────────────

/** State that drives the fill/stroke colour of a sector wedge. */
export type SectorState =
  | "mine_unit"   // current player has an active unit here
  | "mine_empty"  // current player owns it, no unit present
  | "enemy"       // another player owns it (visible)
  | "reachable"   // unowned + revealed_public
  | "fog"         // not revealed to current player
  | "unknown"     // no sector row exists (shouldn't happen in normal play)
  | "selected";   // UI selection highlight

/** Shape of a sectors table row (only the fields this component needs). */
export type DbSector = {
  zone_key: string;
  sector_key: string;           // "a" | "b" | "c" | "d"
  owner_user_id: string | null;
  revealed_public: boolean;
  fortified: boolean;
};

/** Shape of a units table row (only the fields this component needs). */
export type DbUnit = {
  zone_key: string;
  sector_key: string;
  user_id: string;
  status: string;               // only "active" units are drawn
};

export type MapLayout = "ring" | "spokes" | "continent" | "radial" | "ship_line" | "void_ship";

export type CampaignMapOverlayProps = {
  /** Signed URL or public path for the AI-generated map image. */
  mapUrl: string;

  /** Layout type — determines which SVG renderer to use. */
  layout: MapLayout;

  /** Number of zones in this campaign map. */
  zoneCount: number;

  /**
   * Ordered list of zone_key strings.
   * The array index corresponds to the zone's clockwise position in the ring
   * (index 0 = topmost zone, increasing clockwise).
   * Length must be >= zoneCount.
   */
  zoneKeys: string[];

  /**
   * Display names for each zone, parallel to zoneKeys.
   * If omitted, zone labels fall back to the key with underscores replaced by spaces.
   * Pass effectiveZones.map(z => z.name) from page.tsx.
   */
  zoneNames?: string[];

  /** All sector rows for this campaign (from the `sectors` table). */
  sectors: DbSector[];

  /** All unit rows for this campaign (from the `units` table). */
  units: DbUnit[];

  /** The currently authenticated user's ID (or null if not signed in). */
  currentUserId: string | null;

  /**
   * Currently selected sector, in "zoneKey:sectorKey" format.
   * e.g. "ash_wastes:c"
   */
  selectedSectorId?: string | null;

  /** Called when the player clicks a sector wedge. */
  onSectorClick?: (zoneKey: string, sectorKey: string) => void;

  /**
   * When true, zone names are rendered on the outer band of each zone.
   * Off by default to keep the map clean.
   */
  showZoneLabels?: boolean;

  /**
   * When true, the Map Calibration panel is shown below the map.
   * Only the lead player should receive this as true.
   */
  isLead?: boolean;

  /**
   * Campaign map ID — used to namespace calibration config in localStorage
   * so each map remembers its own alignment settings independently.
   */
  campaignId?: string;
};

// ── Internal types ─────────────────────────────────────────────────────────────

type SectorGeometry = {
  id: string;               // "zoneKey:sectorKey"
  zoneKey: string;
  sectorKey: string;
  zoneIndex: number;
  state: SectorState;
  fortified: boolean;
  hasUnit: boolean;
  /** SVG path string for the wedge shape. */
  path: string;
  /** Visual centre of the wedge (for dot/icon placement). */
  centroid: { x: number; y: number };
  /** Centroid of the whole zone's outer band (for label placement). */
  zoneLabelPoint: { x: number; y: number };
};

// ── Ring geometry config ──────────────────────────────────────────────────────
//
// RingConfig holds all five constants that control how the SVG ellipse aligns
// to the AI-generated map image. All geometry functions accept cfg: RingConfig
// instead of reading module-level globals, so the lead player's calibration
// slider values flow through to every path without a page reload.
//
//   perspectiveY — Y-axis compression ratio (1.0 = perfect circle,
//                  lower = more squashed; ~0.55 matches typical AI overhead shot)
//   cx / cy      — SVG viewBox centre of the ellipse; cy < 500 shifts ring upward
//   ringInner    — inner void edge semi-major axis (horizontal rx)
//   ringOuter    — outer atmosphere edge semi-major axis (horizontal rx)
//
// ringMid is always derived as (ringInner + ringOuter) / 2 — not stored.

export type RingConfig = {
  cx:             number;
  cy:             number;
  perspectiveY:   number;
  ringInner:      number;
  ringOuter:      number;
  /**
   * Independent vertical centre offsets for the inner and outer ellipses.
   * In a perspective view the outer edge ellipse centre sits lower than the
   * inner edge — these offsets let you dial that in independently.
   * Positive = shift that ellipse centre downward.
   *
   * Effect on band width:
   *   outerCyOffset > innerCyOffset  =>  bottom band wider, top band narrower
   *   outerCyOffset < innerCyOffset  =>  top band wider, bottom band narrower
   */
  innerCyOffset:  number;
  outerCyOffset:  number;
  /** Master opacity for the SVG overlay (0 = invisible, 1 = fully opaque). */
  overlayOpacity: number;
};

/** Derives the mid-band radius — computed from config, never stored. */
function ringMid(cfg: RingConfig): number {
  return (cfg.ringInner + cfg.ringOuter) / 2;
}

/**
 * Tuned defaults for the current Shattered Halo AI map image.
 * Once calibration is finalised, update these values so the overlay is correct
 * even for users who have never opened the calibration panel.
 */
export const DEFAULT_RING_CONFIG: RingConfig = {
  cx:             500,
  cy:             410,   // ring visual centre sits above canvas midpoint
  perspectiveY:   0.55,  // Y-axis compression (1.0 = circle)
  ringInner:      275,   // inner void edge rx
  ringOuter:      480,   // outer atmosphere edge rx
  innerCyOffset:  0,     // inner ellipse cy nudge (positive = down)
  outerCyOffset:  0,     // outer ellipse cy nudge (positive = down)
  overlayOpacity: 1.0,   // SVG overlay master opacity (0–1)
};

// ── Spokes geometry config ────────────────────────────────────────────────────
//
// SpokesConfig controls the hub-and-spoke layout.
// Zone key convention: zoneKeys[0] = centre hub zone, zoneKeys[1..N] = outer zones.
//
//   centerR      — radius of the centre hub ellipse (horizontal rx)
//   spokeInnerR  — where wedge-spokes begin (inner radius, should be > centerR)
//   spokeOuterR  — outer extent of each spoke wedge
//   spokeGapDeg  — angular gap in degrees between adjacent spokes; the effective
//                  wedge sweep = (360 / outerZoneCount) - spokeGapDeg. Increase
//                  this to make the spokes narrower / more separated.
//   innerCyOffset / outerCyOffset — independent perspective offsets, same as ring.

export type SpokesConfig = {
  cx:             number;
  cy:             number;
  perspectiveY:   number;
  centerR:        number;
  spokeInnerR:    number;
  spokeOuterR:    number;
  /** Angular gap (degrees) between adjacent spokes. Widens or narrows each wedge. */
  spokeGapDeg:    number;
  innerCyOffset:  number;
  outerCyOffset:  number;
  overlayOpacity: number;
};

export const DEFAULT_SPOKES_CONFIG: SpokesConfig = {
  cx:             500,
  cy:             400,
  perspectiveY:   0.55,
  centerR:        80,
  spokeInnerR:    110,
  spokeOuterR:    420,
  spokeGapDeg:    6,
  innerCyOffset:  0,
  outerCyOffset:  0,
  overlayOpacity: 1.0,
};

const CALIB_STORAGE_PREFIX        = "shattered-halo:map-calib:";
const SPOKES_CALIB_STORAGE_PREFIX = "shattered-halo:spokes-calib:";

// ── Continent geometry config ─────────────────────────────────────────────────
//
// ContinentConfig controls the fractured-continents (planet sphere) overlay.
// Zones are grouped into clusters of ~3, matching buildAdjacency / computePositions
// "continent" logic in page.tsx:
//   clusterSize  = max(2, round(zoneCount / 3))
//   clusterCount = ceil(zoneCount / clusterSize)
//
// Each cluster is an angular slice of the planet sphere. Zone wedges within a
// cluster converge toward the planet core (innerRFraction controls tip sharpness).
//
//   planetR        — outer radius of the planet sphere (horizontal rx)
//   innerRFraction — where zone wedges taper to, as fraction of planetR
//                    0.0 = exact centre (sharpest tips), 0.12 = near-centre
//   clusterGapDeg  — angular "ocean" gap between continent clusters
//   zoneGapDeg     — angular "rift" gap between zones within a cluster

export type ContinentConfig = {
  cx:             number;
  cy:             number;
  planetR:        number;
  perspectiveY:   number;
  innerRFraction: number;
  clusterGapDeg:  number;
  zoneGapDeg:     number;
  innerCyOffset:  number;
  outerCyOffset:  number;
  overlayOpacity: number;
};

export const DEFAULT_CONTINENT_CONFIG: ContinentConfig = {
  cx:             500,
  cy:             500,
  planetR:        440,
  perspectiveY:   0.60,
  innerRFraction: 0.12,
  clusterGapDeg:  40,
  zoneGapDeg:     4,
  innerCyOffset:  0,
  outerCyOffset:  0,
  overlayOpacity: 1.0,
};

const CONTINENT_CALIB_STORAGE_PREFIX = "shattered-halo:continent-calib:";

// ── Voidship geometry config ──────────────────────────────────────────────────
//
// VoidshipConfig controls the rectangular void-ship overlay.
// Zones are arranged in two columns (port / starboard) of rectangle cells.
// No wedges or ellipses — the ship is a rectilinear structure.
//
// Zone order: port column (zones[0..perCol-1] top-to-bottom),
//             starboard column (zones[perCol..N-1] top-to-bottom).
// perCol = ceil(zoneCount / 2) — matches page.tsx void_ship computePositions.
//
//   shipX / shipY  — top-left corner of the ship bounding box (SVG units 0–1000)
//   shipW / shipH  — total width and height of the ship bounding box
//   gapX           — centerline corridor width between port and starboard columns
//   gapY           — bulkhead gap height between zone rows
//   sectorGap      — gap between the 4 sector sub-rectangles (2×2 grid) per zone

export type VoidshipConfig = {
  shipX:          number;
  shipY:          number;
  shipW:          number;
  shipH:          number;
  gapX:           number;
  gapY:           number;
  sectorGap:      number;
  overlayOpacity: number;
};

export const DEFAULT_VOIDSHIP_CONFIG: VoidshipConfig = {
  shipX:          120,
  shipY:           80,
  shipW:          760,
  shipH:          840,
  gapX:            40,
  gapY:             6,
  sectorGap:        3,
  overlayOpacity:  1.0,
};

const VOIDSHIP_CALIB_STORAGE_PREFIX = "shattered-halo:voidship-calib:";

const SECTOR_KEYS = ["a", "b", "c", "d"] as const;

// ── Zone colour palette ───────────────────────────────────────────────────────

const ZONE_COLOURS = [
  "#7dd3fc", // sky blue
  "#86efac", // green
  "#f9a8d4", // pink
  "#fcd34d", // yellow
  "#c4b5fd", // purple
  "#fb923c", // orange
  "#67e8f9", // cyan
  "#a3e635", // lime
  "#fca5a5", // rose
  "#93c5fd", // blue
  "#f5d0fe", // violet
  "#fde68a", // amber
] as const;

function zoneColour(zoneIndex: number): string {
  return ZONE_COLOURS[zoneIndex % ZONE_COLOURS.length];
}

// ── SVG path helpers ──────────────────────────────────────────────────────────

/**
 * Converts polar coordinates to SVG cartesian, applying perspectiveY
 * compression on the Y axis so the ring appears as a foreshortened ellipse
 * matching the AI map camera angle.
 */
function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
  perspectiveY: number,
): { x: number; y: number } {
  // Subtract 90 deg so angle 0 = top (north) instead of right (east).
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad) * perspectiveY,
  };
}

/**
 * Builds an SVG path for a ring wedge (annular sector) using elliptical arcs
 * so horizontal and vertical radii differ by perspectiveY.
 * innerCy / outerCy allow the two ellipses to have independent vertical centres,
 * which is necessary to match perspective foreshortening on the ring band.
 */
function wedgePath(
  cx: number,
  innerCy: number,
  outerCy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number,
  perspectiveY: number,
): string {
  const p1 = polarToCartesian(cx, outerCy, outerR, startAngle, perspectiveY);
  const p2 = polarToCartesian(cx, outerCy, outerR, endAngle,   perspectiveY);
  const p3 = polarToCartesian(cx, innerCy, innerR, endAngle,   perspectiveY);
  const p4 = polarToCartesian(cx, innerCy, innerR, startAngle, perspectiveY);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  // Elliptical arc: rx = r (horizontal), ry = r * perspectiveY (compressed vertical)
  const outerRy = (outerR * perspectiveY).toFixed(2);
  const innerRy = (innerR * perspectiveY).toFixed(2);
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${outerR} ${outerRy} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${innerR} ${innerRy} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function wedgeCentroid(
  cx: number,
  innerCy: number,
  outerCy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number,
  perspectiveY: number,
): { x: number; y: number } {
  const midAngle = (startAngle + endAngle) / 2;
  const midR = (innerR + outerR) / 2;
  const midCy = (innerCy + outerCy) / 2;
  return polarToCartesian(cx, midCy, midR, midAngle, perspectiveY);
}

/**
 * Builds an SVG path for a pie-slice sector (inner radius = 0) used by
 * the centre hub zone in the spokes layout.
 */
function pieSectorPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  perspectiveY: number,
): string {
  const p1 = polarToCartesian(cx, cy, r, startAngle, perspectiveY);
  const p2 = polarToCartesian(cx, cy, r, endAngle, perspectiveY);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  const ry = (r * perspectiveY).toFixed(2);
  return [
    `M ${cx.toFixed(2)} ${cy.toFixed(2)}`,
    `L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${r} ${ry} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function pieSectorCentroid(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  perspectiveY: number,
): { x: number; y: number } {
  // Centroid at ~2/3 radius, mid-angle
  return polarToCartesian(cx, cy, r * 0.66, (startAngle + endAngle) / 2, perspectiveY);
}

// ── Rectangle path helpers (voidship layout) ──────────────────────────────────

/**
 * Returns an SVG path for an axis-aligned rectangle given its top-left corner
 * and dimensions. Used for zone sector sub-cells in the voidship layout.
 */
function rectPath(x: number, y: number, w: number, h: number): string {
  return [
    `M ${x.toFixed(2)} ${y.toFixed(2)}`,
    `H ${(x + w).toFixed(2)}`,
    `V ${(y + h).toFixed(2)}`,
    `H ${x.toFixed(2)}`,
    "Z",
  ].join(" ");
}

/** Visual centre of a rectangle — used for unit dot / fortification placement. */
function rectCentroid(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return { x: x + w / 2, y: y + h / 2 };
}

/**
 * Maps SECTOR_KEYS ("a"/"b"/"c"/"d") to a [gridCol, gridRow] position in the
 * 2×2 sub-rectangle that subdivides each voidship zone.
 *
 *   a = [0, 0]  top-left      (inner-leading)
 *   b = [1, 0]  top-right     (inner-trailing)
 *   c = [0, 1]  bottom-left   (outer-leading)
 *   d = [1, 1]  bottom-right  (outer-trailing)
 */
const SECTOR_GRID: Readonly<Record<string, [number, number]>> = {
  a: [0, 0],
  b: [1, 0],
  c: [0, 1],
  d: [1, 1],
};

// ── State derivation ──────────────────────────────────────────────────────────

function deriveSectorState(
  dbSector: DbSector | undefined,
  hasActiveUnit: boolean,
  currentUserId: string | null,
  isSelected: boolean
): SectorState {
  if (isSelected) return "selected";
  if (!dbSector) return "unknown";

  const { owner_user_id, revealed_public } = dbSector;

  if (currentUserId !== null && owner_user_id === currentUserId) {
    return hasActiveUnit ? "mine_unit" : "mine_empty";
  }

  // Not owned by current player
  if (!revealed_public) return "fog";
  if (owner_user_id !== null) return "enemy";
  return "reachable"; // revealed + unowned
}

// ── Sector fill / stroke ──────────────────────────────────────────────────────

function sectorFill(state: SectorState): string {
  switch (state) {
    case "mine_unit":  return "rgba(234,179,8,0.45)";
    case "mine_empty": return "rgba(202,138,4,0.22)";
    case "enemy":      return "rgba(127,29,29,0.40)";
    case "fog":        return "rgba(10,15,35,0.65)";
    case "unknown":    return "rgba(51,65,85,0.35)";
    case "reachable":  return "rgba(34,197,94,0.18)";
    case "selected":   return "rgba(250,204,21,0.42)";
  }
}

function sectorStroke(state: SectorState, zoneIndex: number): string {
  switch (state) {
    case "selected":   return "rgba(250,204,21,0.95)";
    case "mine_unit":
    case "mine_empty": return "rgba(250,204,21,0.70)";
    case "enemy":      return "rgba(220,50,50,0.85)";
    case "reachable":  return "rgba(134,239,172,0.80)";
    // fog + unknown: use the zone colour at reduced opacity
    default:           return zoneColour(zoneIndex) + "99";
  }
}

function sectorStrokeWidth(state: SectorState): number {
  return state === "selected" ? 3.5 : 1.5;
}

// ── Ring geometry hook ────────────────────────────────────────────────────────

function useRingGeometry(
  props: CampaignMapOverlayProps,
  cfg: RingConfig,
): SectorGeometry[] {
  const { zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId } = props;
  const { cx, cy, perspectiveY, ringInner, ringOuter, innerCyOffset, outerCyOffset } = cfg;
  const mid = ringMid(cfg);

  // Effective vertical centres for each ellipse — inner and outer can be offset
  // independently so the band width differs at the top vs bottom of the image.
  const innerCy = cy + innerCyOffset;
  const outerCy = cy + outerCyOffset;
  const midCy   = (innerCy + outerCy) / 2;

  return useMemo(() => {
    const zoneSweep = 360 / Math.max(zoneCount, 1);
    const halfSweep = zoneSweep / 2;

    // Build O(1) lookup maps from DB rows
    const sectorMap = new Map<string, DbSector>();
    for (const s of sectors) {
      sectorMap.set(`${s.zone_key}:${s.sector_key}`, s);
    }

    const activeUnitSet = new Set<string>();
    for (const u of units) {
      if (u.user_id === currentUserId && u.status === "active") {
        activeUnitSet.add(`${u.zone_key}:${u.sector_key}`);
      }
    }

    const result: SectorGeometry[] = [];

    for (let zi = 0; zi < zoneCount; zi++) {
      const zoneKey = zoneKeys[zi] ?? `zone_${zi}`;
      const zoneStart = zi * zoneSweep;

      // Midpoint of the full zone for label placement (outer band centroid)
      const zoneLabelPoint = wedgeCentroid(
        cx, midCy, outerCy, mid, ringOuter,
        zoneStart, zoneStart + zoneSweep,
        perspectiveY
      );

      for (let si = 0; si < 4; si++) {
        const sectorKey = SECTOR_KEYS[si];
        const id = `${zoneKey}:${sectorKey}`;
        const isSelected = selectedSectorId === id;

        // Sector geometry within the zone:
        //   si 0,1 = inner band (ringInner -> mid)
        //   si 2,3 = outer band (mid -> ringOuter)
        const isInnerBand = si < 2;
        const localHalf = si % 2; // 0 = leading half, 1 = trailing half

        const innerR = isInnerBand ? ringInner : mid;
        const outerR = isInnerBand ? mid : ringOuter;
        // Use the appropriate cy pair for each band:
        //   inner band: innerCy (void edge) -> midCy (mid ring)
        //   outer band: midCy (mid ring)    -> outerCy (atmosphere edge)
        const bandInnerCy = isInnerBand ? innerCy : midCy;
        const bandOuterCy = isInnerBand ? midCy   : outerCy;

        const startAngle = zoneStart + localHalf * halfSweep;
        const endAngle = startAngle + halfSweep;

        const dbSector = sectorMap.get(id);
        const hasUnit = activeUnitSet.has(id);
        const state = deriveSectorState(dbSector, hasUnit, currentUserId, isSelected);

        result.push({
          id,
          zoneKey,
          sectorKey,
          zoneIndex: zi,
          state,
          fortified: dbSector?.fortified ?? false,
          hasUnit,
          path:     wedgePath(cx, bandInnerCy, bandOuterCy, innerR, outerR, startAngle, endAngle, perspectiveY),
          centroid: wedgeCentroid(cx, bandInnerCy, bandOuterCy, innerR, outerR, startAngle, endAngle, perspectiveY),
          zoneLabelPoint,
        });
      }
    }

    return result;
  // cfg values included individually so the memo invalidates on slider change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId,
      cx, cy, perspectiveY, ringInner, ringOuter, innerCyOffset, outerCyOffset]);
}

// ── Spokes geometry hook ──────────────────────────────────────────────────────
//
// Zone key convention: zoneKeys[0] = centre hub zone, zoneKeys[1..N] = outer zones.
// Centre zone sectors: 4 equal quadrants (a=NE, b=SE, c=SW, d=NW).
// Outer zone sectors: same a/b/c/d inner-band / outer-band split as ring layout.

function useSpokesGeometry(
  props: CampaignMapOverlayProps,
  cfg: SpokesConfig,
): SectorGeometry[] {
  const { zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId } = props;
  const {
    cx, cy, perspectiveY,
    centerR, spokeInnerR, spokeOuterR, spokeGapDeg,
    innerCyOffset, outerCyOffset,
  } = cfg;

  const outerZoneCount = Math.max(zoneCount - 1, 1);
  const spokeMidR  = (spokeInnerR + spokeOuterR) / 2;
  const innerCy    = cy + innerCyOffset;
  const outerCy    = cy + outerCyOffset;
  const midCy      = (innerCy + outerCy) / 2;

  return useMemo(() => {
    const sectorMap = new Map<string, DbSector>();
    for (const s of sectors) sectorMap.set(`${s.zone_key}:${s.sector_key}`, s);

    const activeUnitSet = new Set<string>();
    for (const u of units) {
      if (u.user_id === currentUserId && u.status === "active") {
        activeUnitSet.add(`${u.zone_key}:${u.sector_key}`);
      }
    }

    const result: SectorGeometry[] = [];

    // ── Centre hub zone (zoneKeys[0]) ─────────────────────────────────────
    const centreKey = zoneKeys[0] ?? "centre";
    // Four equal quadrants: a=0-90°, b=90-180°, c=180-270°, d=270-360°
    const CENTRE_SECTORS = [
      { key: "a", start:   0, end:  90 },
      { key: "b", start:  90, end: 180 },
      { key: "c", start: 180, end: 270 },
      { key: "d", start: 270, end: 360 },
    ] as const;
    // Label sits just above the hub ellipse
    const centreLabelPoint = { x: cx, y: cy - centerR * perspectiveY - 8 };

    for (const { key: sk, start, end } of CENTRE_SECTORS) {
      const id = `${centreKey}:${sk}`;
      const dbSector = sectorMap.get(id);
      const hasUnit  = activeUnitSet.has(id);
      const state    = deriveSectorState(dbSector, hasUnit, currentUserId, selectedSectorId === id);
      result.push({
        id,
        zoneKey: centreKey,
        sectorKey: sk,
        zoneIndex: 0,
        state,
        fortified: dbSector?.fortified ?? false,
        hasUnit,
        path:     pieSectorPath(cx, cy, centerR, start, end, perspectiveY),
        centroid: pieSectorCentroid(cx, cy, centerR, start, end, perspectiveY),
        zoneLabelPoint: centreLabelPoint,
      });
    }

    // ── Outer spoke zones (zoneKeys[1..N]) ────────────────────────────────
    const fullSweep      = 360 / outerZoneCount;
    // Effective wedge sweep after removing the gap between spokes
    const effectiveSweep = Math.max(fullSweep - spokeGapDeg, 5); // min 5° so path is never degenerate
    const halfSweep      = effectiveSweep / 2;

    for (let oi = 0; oi < outerZoneCount; oi++) {
      const zi      = oi + 1;                    // index into zoneKeys
      const zoneKey = zoneKeys[zi] ?? `zone_${zi}`;

      // Centre each spoke in its angular slot; angle 0° = top (north)
      const slotMid  = oi * fullSweep;
      const zoneStart = slotMid - effectiveSweep / 2;
      const zoneEnd   = slotMid + effectiveSweep / 2;

      // Label positioned just beyond outer edge at slot midpoint
      const zoneLabelPoint = polarToCartesian(cx, outerCy, spokeOuterR + 22, slotMid, perspectiveY);

      for (let si = 0; si < 4; si++) {
        const sectorKey  = SECTOR_KEYS[si];
        const id         = `${zoneKey}:${sectorKey}`;
        const isInnerBand = si < 2;
        const localHalf  = si % 2; // 0 = leading angular half, 1 = trailing

        const innerR      = isInnerBand ? spokeInnerR : spokeMidR;
        const outerR      = isInnerBand ? spokeMidR   : spokeOuterR;
        const bandInnerCy = isInnerBand ? innerCy     : midCy;
        const bandOuterCy = isInnerBand ? midCy       : outerCy;

        const startAngle = zoneStart + localHalf * halfSweep;
        const endAngle   = startAngle + halfSweep;

        const dbSector = sectorMap.get(id);
        const hasUnit  = activeUnitSet.has(id);
        const state    = deriveSectorState(dbSector, hasUnit, currentUserId, id === selectedSectorId);

        result.push({
          id,
          zoneKey,
          sectorKey,
          zoneIndex: zi,
          state,
          fortified: dbSector?.fortified ?? false,
          hasUnit,
          path:     wedgePath(cx, bandInnerCy, bandOuterCy, innerR, outerR, startAngle, endAngle, perspectiveY),
          centroid: wedgeCentroid(cx, bandInnerCy, bandOuterCy, innerR, outerR, startAngle, endAngle, perspectiveY),
          zoneLabelPoint,
        });
      }
    }

    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId,
      cx, cy, perspectiveY, centerR, spokeInnerR, spokeOuterR, spokeGapDeg,
      innerCyOffset, outerCyOffset]);
}

// ── Continent geometry hook ───────────────────────────────────────────────────
//
// Cluster derivation mirrors page.tsx buildAdjacency / computePositions "continent":
//   clusterSize  = max(2, round(zoneCount / 3))
//   clusterCount = ceil(zoneCount / clusterSize)
//
// Clusters are evenly spaced around the planet sphere with clusterGapDeg ocean
// gaps between them. Within each cluster, zones are sub-wedges with zoneGapDeg
// rifts between them. All wedges use the same wedgePath / wedgeCentroid as ring/spokes.

function useContinentGeometry(
  props: CampaignMapOverlayProps,
  cfg: ContinentConfig,
): SectorGeometry[] {
  const { zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId } = props;
  const {
    cx, cy, planetR, perspectiveY,
    innerRFraction, clusterGapDeg, zoneGapDeg,
    innerCyOffset, outerCyOffset,
  } = cfg;

  const innerR  = planetR * innerRFraction;
  const midR    = (innerR + planetR) / 2;
  const innerCy = cy + innerCyOffset;
  const outerCy = cy + outerCyOffset;
  const midCy   = (innerCy + outerCy) / 2;

  return useMemo(() => {
    const sectorMap = new Map<string, DbSector>();
    for (const s of sectors) sectorMap.set(`${s.zone_key}:${s.sector_key}`, s);

    const activeUnitSet = new Set<string>();
    for (const u of units) {
      if (u.user_id === currentUserId && u.status === "active") {
        activeUnitSet.add(`${u.zone_key}:${u.sector_key}`);
      }
    }

    const result: SectorGeometry[] = [];
    if (zoneCount === 0) return result;

    // Cluster shape — matches page.tsx "continent" logic
    const clusterSize  = Math.max(2, Math.round(zoneCount / 3));
    const clusterCount = Math.ceil(zoneCount / clusterSize);

    const totalGapDeg  = clusterCount * clusterGapDeg;
    const totalZoneDeg = Math.max(360 - totalGapDeg, clusterCount * 10);
    const clusterSweep = totalZoneDeg / clusterCount;

    let globalZoneIndex = 0;

    for (let ci = 0; ci < clusterCount; ci++) {
      const zonesInCluster = Math.min(clusterSize, zoneCount - ci * clusterSize);
      if (zonesInCluster <= 0) break;

      // Cluster starts at an evenly-spaced angle around the sphere
      const clusterStart = ci * (clusterSweep + clusterGapDeg);

      const totalZoneGapInCluster = (zonesInCluster - 1) * zoneGapDeg;
      const zoneSweep      = Math.max((clusterSweep - totalZoneGapInCluster) / zonesInCluster, 5);
      const halfZoneSweep  = zoneSweep / 2;

      for (let zic = 0; zic < zonesInCluster; zic++) {
        const zi      = globalZoneIndex++;
        const zoneKey = zoneKeys[zi] ?? `zone_${zi}`;

        const zoneStart  = clusterStart + zic * (zoneSweep + zoneGapDeg);
        const zoneEnd    = zoneStart + zoneSweep;
        const slotMid    = (zoneStart + zoneEnd) / 2;

        // Label sits just beyond the planet outer edge at the zone midpoint angle
        const zoneLabelPoint = polarToCartesian(cx, outerCy, planetR + 24, slotMid, perspectiveY);

        for (let si = 0; si < 4; si++) {
          const sectorKey   = SECTOR_KEYS[si];
          const id          = `${zoneKey}:${sectorKey}`;
          const isInnerBand = si < 2;
          const localHalf   = si % 2; // 0 = leading half, 1 = trailing half

          const sInnerR     = isInnerBand ? innerR : midR;
          const sOuterR     = isInnerBand ? midR   : planetR;
          const bandInnerCy = isInnerBand ? innerCy : midCy;
          const bandOuterCy = isInnerBand ? midCy   : outerCy;

          const startAngle = zoneStart + localHalf * halfZoneSweep;
          const endAngle   = startAngle + halfZoneSweep;

          const dbSector = sectorMap.get(id);
          const hasUnit  = activeUnitSet.has(id);
          const state    = deriveSectorState(dbSector, hasUnit, currentUserId, id === selectedSectorId);

          result.push({
            id,
            zoneKey,
            sectorKey,
            zoneIndex: zi,
            state,
            fortified: dbSector?.fortified ?? false,
            hasUnit,
            path:     wedgePath(cx, bandInnerCy, bandOuterCy, sInnerR, sOuterR, startAngle, endAngle, perspectiveY),
            centroid: wedgeCentroid(cx, bandInnerCy, bandOuterCy, sInnerR, sOuterR, startAngle, endAngle, perspectiveY),
            zoneLabelPoint,
          });
        }
      }
    }

    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId,
      cx, cy, planetR, perspectiveY, innerRFraction, clusterGapDeg, zoneGapDeg,
      innerCyOffset, outerCyOffset]);
}

// ── Voidship geometry hook ────────────────────────────────────────────────────
//
// Zone order: port column (zones[0..perCol-1] top-to-bottom),
//             starboard column (zones[perCol..N-1] top-to-bottom).
// perCol = ceil(zoneCount / 2) — matches page.tsx void_ship computePositions.
// Each zone is subdivided into a 2×2 grid of sector rectangles using SECTOR_GRID.

function useVoidshipGeometry(
  props: CampaignMapOverlayProps,
  cfg: VoidshipConfig,
): SectorGeometry[] {
  const { zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId } = props;
  const { shipX, shipY, shipW, shipH, gapX, gapY, sectorGap } = cfg;

  return useMemo(() => {
    const sectorMap = new Map<string, DbSector>();
    for (const s of sectors) sectorMap.set(`${s.zone_key}:${s.sector_key}`, s);

    const activeUnitSet = new Set<string>();
    for (const u of units) {
      if (u.user_id === currentUserId && u.status === "active") {
        activeUnitSet.add(`${u.zone_key}:${u.sector_key}`);
      }
    }

    const result: SectorGeometry[] = [];
    if (zoneCount === 0) return result;

    const perCol = Math.ceil(zoneCount / 2);
    const colW   = (shipW - gapX) / 2;
    // Zone height: divide ship height evenly, with row gaps between zones
    const zoneH  = perCol > 1 ? (shipH - (perCol - 1) * gapY) / perCol : shipH;
    const subW   = (colW - sectorGap) / 2;
    const subH   = (zoneH - sectorGap) / 2;

    for (let zi = 0; zi < zoneCount; zi++) {
      const zoneKey = zoneKeys[zi] ?? `zone_${zi}`;
      const col     = zi < perCol ? 0 : 1;           // 0 = port, 1 = starboard
      const row     = zi < perCol ? zi : zi - perCol;

      const zoneX = shipX + col * (colW + gapX);
      const zoneY = shipY + row * (zoneH + gapY);

      // Zone label sits just above the zone rectangle
      const zoneLabelPoint = { x: zoneX + colW / 2, y: zoneY - 8 };

      for (let si = 0; si < 4; si++) {
        const sectorKey = SECTOR_KEYS[si];
        const id        = `${zoneKey}:${sectorKey}`;
        const [gc, gr]  = SECTOR_GRID[sectorKey] ?? [0, 0];

        const sx = zoneX + gc * (subW + sectorGap);
        const sy = zoneY + gr * (subH + sectorGap);

        const dbSector = sectorMap.get(id);
        const hasUnit  = activeUnitSet.has(id);
        const state    = deriveSectorState(dbSector, hasUnit, currentUserId, id === selectedSectorId);

        result.push({
          id,
          zoneKey,
          sectorKey,
          zoneIndex: zi,
          state,
          fortified: dbSector?.fortified ?? false,
          hasUnit,
          path:     rectPath(sx, sy, subW, subH),
          centroid: rectCentroid(sx, sy, subW, subH),
          zoneLabelPoint,
        });
      }
    }

    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId,
      shipX, shipY, shipW, shipH, gapX, gapY, sectorGap]);
}

// ── Legend ────────────────────────────────────────────────────────────────────

const LEGEND_ITEMS: Array<{ state: SectorState; label: string }> = [
  { state: "mine_unit",  label: "Unit present" },
  { state: "mine_empty", label: "Held (empty)" },
  { state: "enemy",      label: "Enemy" },
  { state: "fog",        label: "Fog / unknown" },
];

function MapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400 pb-2">
      {LEGEND_ITEMS.map(({ state, label }) => (
        <span key={state} className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm border"
            style={{
              background: sectorFill(state),
              borderColor: sectorStroke(state, 0),
              borderWidth: 1.5,
            }}
          />
          {label}
        </span>
      ))}
      <span className="flex items-center gap-1.5 ml-1">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
        unit
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-2.5 h-2.5 rounded-full border border-amber-400 bg-transparent" />
        fort
      </span>
    </div>
  );
}

// ── Ring SVG overlay ──────────────────────────────────────────────────────────

function RingOverlay({
  props,
  geometry,
  cfg,
}: {
  props: CampaignMapOverlayProps;
  geometry: SectorGeometry[];
  cfg: RingConfig;
}) {
  const { zoneCount, onSectorClick, showZoneLabels, zoneNames } = props;
  const { cx, cy, perspectiveY, ringInner, ringOuter, innerCyOffset, outerCyOffset } = cfg;
  const innerCy = cy + innerCyOffset;
  const outerCy = cy + outerCyOffset;
  const zoneSweep = 360 / Math.max(zoneCount, 1);

  // Deduplicated zone label points (one per zone)
  const zoneLabelEntries = useMemo(() => {
    const seen = new Set<number>();
    const entries: Array<{ zi: number; zoneKey: string; point: { x: number; y: number } }> = [];
    for (const sg of geometry) {
      if (!seen.has(sg.zoneIndex)) {
        seen.add(sg.zoneIndex);
        entries.push({
          zi: sg.zoneIndex,
          zoneKey: sg.zoneKey,
          point: sg.zoneLabelPoint,
        });
      }
    }
    return entries;
  }, [geometry]);

  return (
    <svg
      viewBox="0 0 1000 1000"
      className="absolute inset-0 h-full w-full"
      aria-label="Tactical map overlay"
      style={{ opacity: cfg.overlayOpacity }}
    >
      {/* ── Zone boundary outlines (always visible, zone colour) ── */}
      {Array.from({ length: zoneCount }, (_, zi) => {
        const zoneStart = zi * zoneSweep;
        const zoneEnd = zoneStart + zoneSweep;
        return (
          <path
            key={`zone-outline-${zi}`}
            d={wedgePath(cx, innerCy, outerCy, ringInner, ringOuter, zoneStart, zoneEnd, perspectiveY)}
            fill="none"
            stroke={zoneColour(zi)}
            strokeWidth={2.5}
            opacity={0.60}
            pointerEvents="none"
          />
        );
      })}

      {/* ── Sector fills, boundary lines, and icons ── */}
      {geometry.map((sg) => (
        <g key={sg.id}>
          {/* Sector fill (state-driven colour) */}
          <path
            d={sg.path}
            fill={sectorFill(sg.state)}
            stroke={sectorStroke(sg.state, sg.zoneIndex)}
            strokeWidth={sectorStrokeWidth(sg.state)}
            className="transition-colors duration-150"
            onClick={() => onSectorClick?.(sg.zoneKey, sg.sectorKey)}
            style={{ cursor: onSectorClick ? "pointer" : "default" }}
          />

          {/* Fortification ring */}
          {sg.fortified && (
            <circle
              cx={sg.centroid.x}
              cy={sg.centroid.y}
              r={11}
              fill="rgba(245,158,11,0.85)"
              stroke="rgba(255,255,255,0.55)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}

          {/* Active unit dot */}
          {sg.hasUnit && (
            <circle
              cx={sg.centroid.x}
              cy={sg.centroid.y}
              r={sg.fortified ? 4 : 6}
              fill="rgba(250,204,21,0.95)"
              stroke="rgba(0,0,0,0.45)"
              strokeWidth={1}
              pointerEvents="none"
            />
          )}
        </g>
      ))}

      {/* ── Zone name labels (outer band, optional) ── */}
      {showZoneLabels &&
        zoneLabelEntries.map(({ zi, zoneKey, point }) => (
          <text
            key={`zone-label-${zi}`}
            x={point.x.toFixed(1)}
            y={(point.y + 5).toFixed(1)}
            textAnchor="middle"
            fontSize={17}
            fontWeight="700"
            fill={zoneColour(zi)}
            stroke="rgba(0,0,0,0.65)"
            strokeWidth={3}
            paintOrder="stroke"
            pointerEvents="none"
            style={{ fontFamily: "sans-serif", letterSpacing: "-0.3px" }}
          >
            {/* Use provided display name, fall back to key with underscores replaced */}
            {zoneNames?.[zi] ?? zoneKey.replace(/_/g, " ")}
          </text>
        ))}
    </svg>
  );
}

// ── Spokes SVG overlay ────────────────────────────────────────────────────────

function SpokesOverlay({
  props,
  geometry,
  cfg,
}: {
  props: CampaignMapOverlayProps;
  geometry: SectorGeometry[];
  cfg: SpokesConfig;
}) {
  const { zoneCount, onSectorClick, showZoneLabels, zoneNames } = props;
  const {
    cx, cy, perspectiveY,
    centerR, spokeInnerR, spokeOuterR, spokeGapDeg,
    innerCyOffset, outerCyOffset,
  } = cfg;

  const outerZoneCount  = Math.max(zoneCount - 1, 1);
  const fullSweep       = 360 / outerZoneCount;
  const effectiveSweep  = Math.max(fullSweep - spokeGapDeg, 5);
  const innerCy         = cy + innerCyOffset;
  const outerCy         = cy + outerCyOffset;

  // Build hub ellipse outline path (two semicircles)
  const hubRy = (centerR * perspectiveY).toFixed(2);
  const hubOutlinePath = [
    `M ${(cx - centerR).toFixed(2)} ${cy.toFixed(2)}`,
    `A ${centerR} ${hubRy} 0 1 1 ${(cx + centerR).toFixed(2)} ${cy.toFixed(2)}`,
    `A ${centerR} ${hubRy} 0 1 1 ${(cx - centerR).toFixed(2)} ${cy.toFixed(2)}`,
    "Z",
  ].join(" ");

  // Deduplicated label points
  const zoneLabelEntries = useMemo(() => {
    const seen = new Set<number>();
    const entries: Array<{ zi: number; zoneKey: string; point: { x: number; y: number } }> = [];
    for (const sg of geometry) {
      if (!seen.has(sg.zoneIndex)) {
        seen.add(sg.zoneIndex);
        entries.push({ zi: sg.zoneIndex, zoneKey: sg.zoneKey, point: sg.zoneLabelPoint });
      }
    }
    return entries;
  }, [geometry]);

  return (
    <svg
      viewBox="0 0 1000 1000"
      className="absolute inset-0 h-full w-full"
      aria-label="Tactical map overlay"
      style={{ opacity: cfg.overlayOpacity }}
    >
      {/* ── Hub zone boundary outline ── */}
      <path
        d={hubOutlinePath}
        fill="none"
        stroke={zoneColour(0)}
        strokeWidth={2.5}
        opacity={0.60}
        pointerEvents="none"
      />

      {/* ── Spoke zone boundary outlines ── */}
      {Array.from({ length: outerZoneCount }, (_, oi) => {
        const zi         = oi + 1;
        const slotMid    = oi * fullSweep;
        const zoneStart  = slotMid - effectiveSweep / 2;
        const zoneEnd    = slotMid + effectiveSweep / 2;
        return (
          <path
            key={`spoke-outline-${zi}`}
            d={wedgePath(cx, innerCy, outerCy, spokeInnerR, spokeOuterR, zoneStart, zoneEnd, perspectiveY)}
            fill="none"
            stroke={zoneColour(zi)}
            strokeWidth={2.5}
            opacity={0.60}
            pointerEvents="none"
          />
        );
      })}

      {/* ── Sector fills, icons ── */}
      {geometry.map((sg) => (
        <g key={sg.id}>
          <path
            d={sg.path}
            fill={sectorFill(sg.state)}
            stroke={sectorStroke(sg.state, sg.zoneIndex)}
            strokeWidth={sectorStrokeWidth(sg.state)}
            className="transition-colors duration-150"
            onClick={() => onSectorClick?.(sg.zoneKey, sg.sectorKey)}
            style={{ cursor: onSectorClick ? "pointer" : "default" }}
          />
          {sg.fortified && (
            <circle
              cx={sg.centroid.x} cy={sg.centroid.y} r={11}
              fill="rgba(245,158,11,0.85)"
              stroke="rgba(255,255,255,0.55)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}
          {sg.hasUnit && (
            <circle
              cx={sg.centroid.x} cy={sg.centroid.y}
              r={sg.fortified ? 4 : 6}
              fill="rgba(250,204,21,0.95)"
              stroke="rgba(0,0,0,0.45)"
              strokeWidth={1}
              pointerEvents="none"
            />
          )}
        </g>
      ))}

      {/* ── Zone name labels ── */}
      {showZoneLabels &&
        zoneLabelEntries.map(({ zi, zoneKey, point }) => (
          <text
            key={`spokes-label-${zi}`}
            x={point.x.toFixed(1)}
            y={(point.y + 5).toFixed(1)}
            textAnchor="middle"
            fontSize={17}
            fontWeight="700"
            fill={zoneColour(zi)}
            stroke="rgba(0,0,0,0.65)"
            strokeWidth={3}
            paintOrder="stroke"
            pointerEvents="none"
            style={{ fontFamily: "sans-serif", letterSpacing: "-0.3px" }}
          >
            {zoneNames?.[zi] ?? zoneKey.replace(/_/g, " ")}
          </text>
        ))}
    </svg>
  );
}

// ── Continent SVG overlay ─────────────────────────────────────────────────────

function ContinentOverlay({
  props,
  geometry,
  cfg,
}: {
  props: CampaignMapOverlayProps;
  geometry: SectorGeometry[];
  cfg: ContinentConfig;
}) {
  const { zoneCount, onSectorClick, showZoneLabels, zoneNames } = props;
  const {
    cx, cy, planetR, perspectiveY,
    innerRFraction, clusterGapDeg, zoneGapDeg,
    innerCyOffset, outerCyOffset,
  } = cfg;
  const outerCy = cy + outerCyOffset;

  // Re-derive cluster structure to draw zone boundary outlines (one wedge per zone)
  const clusterSize  = Math.max(2, Math.round(zoneCount / 3));
  const clusterCount = Math.ceil(zoneCount / clusterSize);
  const totalGapDeg  = clusterCount * clusterGapDeg;
  const totalZoneDeg = Math.max(360 - totalGapDeg, clusterCount * 10);
  const clusterSweep = totalZoneDeg / clusterCount;
  const innerR       = planetR * innerRFraction;

  // Build list of (zoneIndex, startAngle, endAngle) for zone outlines
  const zoneOutlines = useMemo(() => {
    const entries: Array<{ zi: number; start: number; end: number }> = [];
    let gi = 0;
    for (let ci = 0; ci < clusterCount; ci++) {
      const zonesInCluster = Math.min(clusterSize, zoneCount - ci * clusterSize);
      if (zonesInCluster <= 0) break;
      const clusterStart = ci * (clusterSweep + clusterGapDeg);
      const totalZoneGap = (zonesInCluster - 1) * zoneGapDeg;
      const zoneSweep    = Math.max((clusterSweep - totalZoneGap) / zonesInCluster, 5);
      for (let zic = 0; zic < zonesInCluster; zic++) {
        const start = clusterStart + zic * (zoneSweep + zoneGapDeg);
        entries.push({ zi: gi++, start, end: start + zoneSweep });
      }
    }
    return entries;
  }, [zoneCount, clusterCount, clusterSize, clusterSweep, clusterGapDeg, zoneGapDeg]);

  // Deduplicated label points
  const zoneLabelEntries = useMemo(() => {
    const seen = new Set<number>();
    const entries: Array<{ zi: number; zoneKey: string; point: { x: number; y: number } }> = [];
    for (const sg of geometry) {
      if (!seen.has(sg.zoneIndex)) {
        seen.add(sg.zoneIndex);
        entries.push({ zi: sg.zoneIndex, zoneKey: sg.zoneKey, point: sg.zoneLabelPoint });
      }
    }
    return entries;
  }, [geometry]);

  // Planet sphere outline (full ellipse)
  const outerRy = (planetR * perspectiveY).toFixed(2);
  const planetOutline = [
    `M ${(cx - planetR).toFixed(2)} ${outerCy.toFixed(2)}`,
    `A ${planetR} ${outerRy} 0 1 1 ${(cx + planetR).toFixed(2)} ${outerCy.toFixed(2)}`,
    `A ${planetR} ${outerRy} 0 1 1 ${(cx - planetR).toFixed(2)} ${outerCy.toFixed(2)}`,
    "Z",
  ].join(" ");

  return (
    <svg
      viewBox="0 0 1000 1000"
      className="absolute inset-0 h-full w-full"
      aria-label="Tactical map overlay"
      style={{ opacity: cfg.overlayOpacity }}
    >
      {/* ── Planet sphere faint background ── */}
      <path
        d={planetOutline}
        fill="rgba(0,0,0,0.08)"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={1}
        pointerEvents="none"
      />

      {/* ── Zone boundary outlines (full wedge per zone, zone colour) ── */}
      {zoneOutlines.map(({ zi, start, end }) => (
        <path
          key={`cont-outline-${zi}`}
          d={wedgePath(cx, cy + innerCyOffset, outerCy, innerR, planetR, start, end, perspectiveY)}
          fill="none"
          stroke={zoneColour(zi)}
          strokeWidth={2.5}
          opacity={0.55}
          pointerEvents="none"
        />
      ))}

      {/* ── Sector fills, icons ── */}
      {geometry.map((sg) => (
        <g key={sg.id}>
          <path
            d={sg.path}
            fill={sectorFill(sg.state)}
            stroke={sectorStroke(sg.state, sg.zoneIndex)}
            strokeWidth={sectorStrokeWidth(sg.state)}
            className="transition-colors duration-150"
            onClick={() => onSectorClick?.(sg.zoneKey, sg.sectorKey)}
            style={{ cursor: onSectorClick ? "pointer" : "default" }}
          />
          {sg.fortified && (
            <circle
              cx={sg.centroid.x} cy={sg.centroid.y} r={11}
              fill="rgba(245,158,11,0.85)"
              stroke="rgba(255,255,255,0.55)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}
          {sg.hasUnit && (
            <circle
              cx={sg.centroid.x} cy={sg.centroid.y}
              r={sg.fortified ? 4 : 6}
              fill="rgba(250,204,21,0.95)"
              stroke="rgba(0,0,0,0.45)"
              strokeWidth={1}
              pointerEvents="none"
            />
          )}
        </g>
      ))}

      {/* ── Zone name labels ── */}
      {showZoneLabels &&
        zoneLabelEntries.map(({ zi, zoneKey, point }) => (
          <text
            key={`cont-label-${zi}`}
            x={point.x.toFixed(1)}
            y={(point.y + 5).toFixed(1)}
            textAnchor="middle"
            fontSize={17}
            fontWeight="700"
            fill={zoneColour(zi)}
            stroke="rgba(0,0,0,0.65)"
            strokeWidth={3}
            paintOrder="stroke"
            pointerEvents="none"
            style={{ fontFamily: "sans-serif", letterSpacing: "-0.3px" }}
          >
            {zoneNames?.[zi] ?? zoneKey.replace(/_/g, " ")}
          </text>
        ))}
    </svg>
  );
}

// ── Voidship SVG overlay ──────────────────────────────────────────────────────

function VoidshipOverlay({
  props,
  geometry,
  cfg,
}: {
  props: CampaignMapOverlayProps;
  geometry: SectorGeometry[];
  cfg: VoidshipConfig;
}) {
  const { zoneCount, onSectorClick, showZoneLabels, zoneNames } = props;
  const { shipX, shipY, shipW, shipH, gapX, gapY } = cfg;

  const perCol = Math.ceil(zoneCount / 2);
  const colW   = (shipW - gapX) / 2;
  const zoneH  = perCol > 1 ? (shipH - (perCol - 1) * gapY) / perCol : shipH;

  // Zone boundary outlines — one per zone
  const zoneRects = useMemo(() => {
    const rects: Array<{ zi: number; x: number; y: number; w: number; h: number }> = [];
    for (let zi = 0; zi < zoneCount; zi++) {
      const col  = zi < perCol ? 0 : 1;
      const row  = zi < perCol ? zi : zi - perCol;
      rects.push({
        zi,
        x: shipX + col * (colW + gapX),
        y: shipY + row * (zoneH + gapY),
        w: colW,
        h: zoneH,
      });
    }
    return rects;
  }, [zoneCount, perCol, shipX, shipY, colW, gapX, zoneH, gapY]);

  // Deduplicated label points
  const zoneLabelEntries = useMemo(() => {
    const seen = new Set<number>();
    const entries: Array<{ zi: number; zoneKey: string; point: { x: number; y: number } }> = [];
    for (const sg of geometry) {
      if (!seen.has(sg.zoneIndex)) {
        seen.add(sg.zoneIndex);
        entries.push({ zi: sg.zoneIndex, zoneKey: sg.zoneKey, point: sg.zoneLabelPoint });
      }
    }
    return entries;
  }, [geometry]);

  // Ship hull outline — outer rectangle around both columns
  const hullPath = rectPath(shipX, shipY, shipW, shipH);
  // Centerline corridor outline
  const corridorX = shipX + colW;
  const corridorPath = rectPath(corridorX, shipY, gapX, shipH);

  return (
    <svg
      viewBox="0 0 1000 1000"
      className="absolute inset-0 h-full w-full"
      aria-label="Tactical map overlay"
      style={{ opacity: cfg.overlayOpacity }}
    >
      {/* ── Ship hull faint background ── */}
      <path
        d={hullPath}
        fill="rgba(0,0,0,0.08)"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={1.5}
        pointerEvents="none"
      />

      {/* ── Centerline corridor ── */}
      <path
        d={corridorPath}
        fill="rgba(0,0,0,0.25)"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={1}
        pointerEvents="none"
      />

      {/* ── Zone boundary outlines ── */}
      {zoneRects.map(({ zi, x, y, w, h }) => (
        <rect
          key={`vs-zone-${zi}`}
          x={x} y={y} width={w} height={h}
          fill="none"
          stroke={zoneColour(zi)}
          strokeWidth={2.5}
          opacity={0.55}
          pointerEvents="none"
        />
      ))}

      {/* ── Sector fills, icons ── */}
      {geometry.map((sg) => (
        <g key={sg.id}>
          <path
            d={sg.path}
            fill={sectorFill(sg.state)}
            stroke={sectorStroke(sg.state, sg.zoneIndex)}
            strokeWidth={sectorStrokeWidth(sg.state)}
            className="transition-colors duration-150"
            onClick={() => onSectorClick?.(sg.zoneKey, sg.sectorKey)}
            style={{ cursor: onSectorClick ? "pointer" : "default" }}
          />
          {sg.fortified && (
            <circle
              cx={sg.centroid.x} cy={sg.centroid.y} r={11}
              fill="rgba(245,158,11,0.85)"
              stroke="rgba(255,255,255,0.55)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}
          {sg.hasUnit && (
            <circle
              cx={sg.centroid.x} cy={sg.centroid.y}
              r={sg.fortified ? 4 : 6}
              fill="rgba(250,204,21,0.95)"
              stroke="rgba(0,0,0,0.45)"
              strokeWidth={1}
              pointerEvents="none"
            />
          )}
        </g>
      ))}

      {/* ── Zone name labels ── */}
      {showZoneLabels &&
        zoneLabelEntries.map(({ zi, zoneKey, point }) => (
          <text
            key={`vs-label-${zi}`}
            x={point.x.toFixed(1)}
            y={(point.y - 2).toFixed(1)}
            textAnchor="middle"
            fontSize={15}
            fontWeight="700"
            fill={zoneColour(zi)}
            stroke="rgba(0,0,0,0.65)"
            strokeWidth={3}
            paintOrder="stroke"
            pointerEvents="none"
            style={{ fontFamily: "sans-serif", letterSpacing: "-0.3px" }}
          >
            {zoneNames?.[zi] ?? zoneKey.replace(/_/g, " ")}
          </text>
        ))}
    </svg>
  );
}

type SliderDef = {
  key: string;   // keyof the config object being calibrated
  label: string;
  min: number;
  max: number;
  step: number;
  description: string;
};

const RING_SLIDER_DEFS: SliderDef[] = [
  {
    key: "cx",
    label: "Centre X",
    min: 300, max: 700, step: 1,
    description: "Horizontal centre of the ring ellipse (500 = canvas midpoint)",
  },
  {
    key: "cy",
    label: "Centre Y",
    min: 200, max: 600, step: 1,
    description: "Vertical centre — lower value shifts the ring upward",
  },
  {
    key: "perspectiveY",
    label: "Y Compression",
    min: 0.30, max: 1.00, step: 0.01,
    description: "1.0 = circle, lower = more squashed (matches camera elevation angle)",
  },
  {
    key: "ringInner",
    label: "Inner Radius",
    min: 150, max: 400, step: 1,
    description: "Semi-major axis of the inner void ellipse (horizontal rx)",
  },
  {
    key: "ringOuter",
    label: "Outer Radius",
    min: 300, max: 700, step: 1,
    description: "Semi-major axis of the outer atmosphere ellipse (horizontal rx)",
  },
  {
    key: "innerCyOffset",
    label: "Inner Centre Y Offset",
    min: -80, max: 80, step: 1,
    description: "Shifts inner ellipse centre up (negative) or down (positive) — adjusts band width at top/bottom",
  },
  {
    key: "outerCyOffset",
    label: "Outer Centre Y Offset",
    min: -80, max: 80, step: 1,
    description: "Shifts outer ellipse centre up (negative) or down (positive) — move this to fix bottom OD alignment",
  },
  {
    key: "overlayOpacity",
    label: "Overlay Opacity",
    min: 0.0, max: 1.0, step: 0.01,
    description: "Master transparency of the SVG overlay (0 = invisible, 1 = fully opaque)",
  },
];

const SPOKES_SLIDER_DEFS: SliderDef[] = [
  {
    key: "cx",
    label: "Centre X",
    min: 300, max: 700, step: 1,
    description: "Horizontal centre of the hub",
  },
  {
    key: "cy",
    label: "Centre Y",
    min: 200, max: 600, step: 1,
    description: "Vertical centre of the hub",
  },
  {
    key: "perspectiveY",
    label: "Y Compression",
    min: 0.30, max: 1.00, step: 0.01,
    description: "1.0 = circle, lower = more squashed (matches camera elevation angle)",
  },
  {
    key: "centerR",
    label: "Hub Radius",
    min: 30, max: 200, step: 1,
    description: "Radius of the central hub zone",
  },
  {
    key: "spokeInnerR",
    label: "Spoke Inner Radius",
    min: 50, max: 300, step: 1,
    description: "Where spokes begin — should be ≥ hub radius + gap",
  },
  {
    key: "spokeOuterR",
    label: "Spoke Outer Radius",
    min: 150, max: 700, step: 1,
    description: "Outer extent of each spoke wedge",
  },
  {
    key: "spokeGapDeg",
    label: "Spoke Gap (°)",
    min: 0, max: 30, step: 0.5,
    description: "Angular gap between adjacent spokes — increase to narrow / separate the wedges",
  },
  {
    key: "innerCyOffset",
    label: "Inner Centre Y Offset",
    min: -80, max: 80, step: 1,
    description: "Shifts inner spoke ellipse centre up (−) or down (+)",
  },
  {
    key: "outerCyOffset",
    label: "Outer Centre Y Offset",
    min: -80, max: 80, step: 1,
    description: "Shifts outer spoke ellipse centre — fixes bottom alignment",
  },
  {
    key: "overlayOpacity",
    label: "Overlay Opacity",
    min: 0.0, max: 1.0, step: 0.01,
    description: "Master transparency of the SVG overlay (0 = invisible, 1 = fully opaque)",
  },
];

const CONTINENT_SLIDER_DEFS: SliderDef[] = [
  {
    key: "cx",
    label: "Centre X",
    min: 300, max: 700, step: 1,
    description: "Horizontal centre of the planet sphere (500 = canvas midpoint)",
  },
  {
    key: "cy",
    label: "Centre Y",
    min: 200, max: 700, step: 1,
    description: "Vertical centre of the planet sphere",
  },
  {
    key: "planetR",
    label: "Planet Radius",
    min: 200, max: 600, step: 1,
    description: "Outer radius of the planet sphere (horizontal rx)",
  },
  {
    key: "perspectiveY",
    label: "Y Compression",
    min: 0.30, max: 1.00, step: 0.01,
    description: "1.0 = circle, lower = more squashed (matches camera elevation angle)",
  },
  {
    key: "innerRFraction",
    label: "Wedge Tip Fraction",
    min: 0.0, max: 0.40, step: 0.01,
    description: "Where continent wedges taper toward — 0.0 = sharp tips at core, higher = blunted",
  },
  {
    key: "clusterGapDeg",
    label: "Ocean Gap (°)",
    min: 5, max: 90, step: 1,
    description: "Angular gap between continent clusters — represents open ocean / void",
  },
  {
    key: "zoneGapDeg",
    label: "Rift Gap (°)",
    min: 0, max: 20, step: 0.5,
    description: "Angular gap between zones within a continent — represents rifts / straits",
  },
  {
    key: "innerCyOffset",
    label: "Inner Centre Y Offset",
    min: -80, max: 80, step: 1,
    description: "Shifts inner ellipse centre up (−) or down (+) — adjusts band width at top/bottom",
  },
  {
    key: "outerCyOffset",
    label: "Outer Centre Y Offset",
    min: -80, max: 80, step: 1,
    description: "Shifts outer ellipse centre — use to fix bottom hemisphere alignment",
  },
  {
    key: "overlayOpacity",
    label: "Overlay Opacity",
    min: 0.0, max: 1.0, step: 0.01,
    description: "Master transparency of the SVG overlay (0 = invisible, 1 = fully opaque)",
  },
];

const VOIDSHIP_SLIDER_DEFS: SliderDef[] = [
  {
    key: "shipX",
    label: "Ship Left Edge",
    min: 0, max: 400, step: 1,
    description: "X position of the ship's port-side outer hull edge",
  },
  {
    key: "shipY",
    label: "Ship Top Edge",
    min: 0, max: 300, step: 1,
    description: "Y position of the ship's bow (top)",
  },
  {
    key: "shipW",
    label: "Ship Width",
    min: 200, max: 900, step: 1,
    description: "Total width of the ship (both columns + corridor)",
  },
  {
    key: "shipH",
    label: "Ship Height",
    min: 300, max: 950, step: 1,
    description: "Total height of the ship (bow to stern)",
  },
  {
    key: "gapX",
    label: "Corridor Width",
    min: 10, max: 120, step: 1,
    description: "Width of the centerline corridor between port and starboard columns",
  },
  {
    key: "gapY",
    label: "Bulkhead Gap",
    min: 0, max: 40, step: 1,
    description: "Height of the bulkhead gap between zone rows",
  },
  {
    key: "sectorGap",
    label: "Sector Gap",
    min: 0, max: 20, step: 1,
    description: "Gap between the 4 sector sub-rectangles within each zone",
  },
  {
    key: "overlayOpacity",
    label: "Overlay Opacity",
    min: 0.0, max: 1.0, step: 0.01,
    description: "Master transparency of the SVG overlay (0 = invisible, 1 = fully opaque)",
  },
];

function CalibrationPanel({
  cfg,
  sliderDefs,
  buildCopySnippet,
  onChange,
  onReset,
  campaignId,
  derivedValues,
}: {
  cfg: Record<string, number>;
  sliderDefs: SliderDef[];
  /** Returns the text pasted to clipboard when the user clicks "Copy Config". */
  buildCopySnippet: () => string;
  onChange: (key: string, value: number) => void;
  onReset: () => void;
  campaignId?: string;
  /** Extra computed values shown at the bottom of the panel for verification. */
  derivedValues?: Array<{ label: string; value: string }>;
}) {
  const [copied, setCopied] = useState(false);

  const copyConfig = useCallback(() => {
    navigator.clipboard.writeText(buildCopySnippet()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }, [buildCopySnippet]);

  return (
    <div className="rounded-lg border border-brass/30 bg-black/85 p-4 space-y-4 text-sm">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-brass font-semibold font-mono tracking-wide text-xs uppercase">
            Map Calibration
          </p>
          <p className="text-zinc-500 text-xs mt-0.5">
            Adjust sliders until the overlay aligns with the background image.
            {campaignId
              ? " Values are saved automatically."
              : " Values apply this session only (no campaignId supplied)."}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={onReset}
            className="px-2.5 py-1 rounded border border-zinc-600 hover:border-zinc-400 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
          >
            Reset
          </button>
          <button
            onClick={copyConfig}
            className="px-3 py-1 rounded border border-brass/40 hover:border-brass/70 bg-brass/10 hover:bg-brass/20 text-brass text-xs font-mono transition-colors"
          >
            {copied ? "✓ Copied!" : "Copy Config"}
          </button>
        </div>
      </div>

      {/* Sliders */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sliderDefs.map(({ key, label, min, max, step, description }) => {
          const value = cfg[key] ?? 0;
          // Show decimal places when step is fractional
          const displayValue = step < 1 ? value.toFixed(2) : String(value);
          return (
            <div key={key} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-zinc-300 text-xs font-mono">{label}</label>
                <span className="text-brass font-mono text-xs tabular-nums">
                  {displayValue}
                </span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(key, parseFloat(e.target.value))}
                className="w-full h-1.5 rounded appearance-none bg-zinc-700 accent-amber-400 cursor-pointer"
              />
              <p className="text-zinc-600 text-xs leading-tight">{description}</p>
            </div>
          );
        })}
      </div>

      {/* Derived values — layout-specific computed properties for verification */}
      {derivedValues && derivedValues.length > 0 && (
        <div className="pt-2 border-t border-zinc-800 flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono text-zinc-600">
          {derivedValues.map(({ label, value }) => (
            <span key={label}>{label}: {value}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Calibration config hook ───────────────────────────────────────────────────

/**
 * Loads calibration config from localStorage (keyed by campaignId), returns it as
 * state, and provides a setter that persists on every change plus a reset fn.
 */
function useCalibConfig(
  campaignId?: string
): [RingConfig, (cfg: RingConfig) => void, () => void] {
  const storageKey = CALIB_STORAGE_PREFIX + (campaignId ?? "default");

  const [cfg, setCfgState] = useState<RingConfig>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        // Merge over defaults so new fields added in future won't be missing
        return { ...DEFAULT_RING_CONFIG, ...JSON.parse(stored) };
      }
    } catch {
      // localStorage unavailable (SSR, private browsing) — fall back silently
    }
    return { ...DEFAULT_RING_CONFIG };
  });

  const setCfg = useCallback(
    (next: RingConfig) => {
      setCfgState(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage write failed — ignore (overlay still works, just won't persist)
      }
    },
    [storageKey]
  );

  const reset = useCallback(() => {
    setCfg({ ...DEFAULT_RING_CONFIG });
    try {
      localStorage.removeItem(storageKey);
    } catch { /* ignore */ }
  }, [setCfg, storageKey]);

  return [cfg, setCfg, reset];
}

// Spokes variant — identical pattern, different storage key prefix and defaults.
function useSpokesCalibConfig(
  campaignId?: string
): [SpokesConfig, (cfg: SpokesConfig) => void, () => void] {
  const storageKey = SPOKES_CALIB_STORAGE_PREFIX + (campaignId ?? "default");

  const [cfg, setCfgState] = useState<SpokesConfig>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) return { ...DEFAULT_SPOKES_CONFIG, ...JSON.parse(stored) };
    } catch { /* SSR / private browsing */ }
    return { ...DEFAULT_SPOKES_CONFIG };
  });

  const setCfg = useCallback(
    (next: SpokesConfig) => {
      setCfgState(next);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
    },
    [storageKey]
  );

  const reset = useCallback(() => {
    setCfg({ ...DEFAULT_SPOKES_CONFIG });
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }, [setCfg, storageKey]);

  return [cfg, setCfg, reset];
}

// Continent variant — same pattern as ring/spokes.
function useContinentCalibConfig(
  campaignId?: string
): [ContinentConfig, (cfg: ContinentConfig) => void, () => void] {
  const storageKey = CONTINENT_CALIB_STORAGE_PREFIX + (campaignId ?? "default");

  const [cfg, setCfgState] = useState<ContinentConfig>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) return { ...DEFAULT_CONTINENT_CONFIG, ...JSON.parse(stored) };
    } catch { /* SSR / private browsing */ }
    return { ...DEFAULT_CONTINENT_CONFIG };
  });

  const setCfg = useCallback(
    (next: ContinentConfig) => {
      setCfgState(next);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
    },
    [storageKey]
  );

  const reset = useCallback(() => {
    setCfg({ ...DEFAULT_CONTINENT_CONFIG });
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }, [setCfg, storageKey]);

  return [cfg, setCfg, reset];
}

// Voidship variant — same pattern, no perspective fields.
function useVoidshipCalibConfig(
  campaignId?: string
): [VoidshipConfig, (cfg: VoidshipConfig) => void, () => void] {
  const storageKey = VOIDSHIP_CALIB_STORAGE_PREFIX + (campaignId ?? "default");

  const [cfg, setCfgState] = useState<VoidshipConfig>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) return { ...DEFAULT_VOIDSHIP_CONFIG, ...JSON.parse(stored) };
    } catch { /* SSR / private browsing */ }
    return { ...DEFAULT_VOIDSHIP_CONFIG };
  });

  const setCfg = useCallback(
    (next: VoidshipConfig) => {
      setCfgState(next);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
    },
    [storageKey]
  );

  const reset = useCallback(() => {
    setCfg({ ...DEFAULT_VOIDSHIP_CONFIG });
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }, [setCfg, storageKey]);

  return [cfg, setCfg, reset];
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function CampaignMapOverlay(props: CampaignMapOverlayProps) {
  const { mapUrl, layout, isLead, campaignId } = props;

  // All four config hooks called unconditionally — React rules of hooks forbid
  // conditional hook calls, so every hook is always initialised regardless of
  // which layout is active. Only the matching layout's state is ever rendered.
  const [ringCfg,       setRingCfg,       resetRingCfg      ] = useCalibConfig(campaignId);
  const [spokesCfg,     setSpokesCfg,     resetSpokesCfg    ] = useSpokesCalibConfig(campaignId);
  const [continentCfg,  setContinentCfg,  resetContinentCfg ] = useContinentCalibConfig(campaignId);
  const [voidshipCfg,   setVoidshipCfg,   resetVoidshipCfg  ] = useVoidshipCalibConfig(campaignId);

  const [calibOpen, setCalibOpen] = useState(false);

  const handleRingSliderChange = useCallback(
    (key: string, value: number) => setRingCfg({ ...ringCfg, [key]: value }),
    [ringCfg, setRingCfg]
  );
  const handleSpokesSliderChange = useCallback(
    (key: string, value: number) => setSpokesCfg({ ...spokesCfg, [key]: value }),
    [spokesCfg, setSpokesCfg]
  );
  const handleContinentSliderChange = useCallback(
    (key: string, value: number) => setContinentCfg({ ...continentCfg, [key]: value }),
    [continentCfg, setContinentCfg]
  );
  const handleVoidshipSliderChange = useCallback(
    (key: string, value: number) => setVoidshipCfg({ ...voidshipCfg, [key]: value }),
    [voidshipCfg, setVoidshipCfg]
  );

  // All four geometry hooks called unconditionally.
  // Only the result matching the active layout is ever passed to an Overlay component.
  const ringGeometry       = useRingGeometry(props, ringCfg);
  const spokesGeometry     = useSpokesGeometry(props, spokesCfg);
  const continentGeometry  = useContinentGeometry(props, continentCfg);
  const voidshipGeometry   = useVoidshipGeometry(props, voidshipCfg);

  // ── Calibration toggle button (shared across all layouts) ─────────────────
  const calibToggle = (
    <button
      onClick={() => setCalibOpen((prev) => !prev)}
      className="flex items-center gap-2 text-xs font-mono text-zinc-500 hover:text-brass/80 transition-colors px-1 select-none"
    >
      <span
        className="text-zinc-600 transition-transform duration-200 inline-block"
        style={{ transform: calibOpen ? "rotate(90deg)" : "rotate(0deg)" }}
      >
        ▶
      </span>
      {calibOpen ? "Hide Calibration" : "◈ Calibrate Overlay"}
      <span className="text-zinc-700 italic ml-0.5">Lead only</span>
    </button>
  );

  // ── Stub for truly unimplemented layouts ──────────────────────────────────
  if (layout !== "ring" && layout !== "spokes" && layout !== "continent" && layout !== "void_ship") {
    return (
      <div className="space-y-2">
        <MapLegend />
        <div className="relative w-full aspect-video overflow-hidden rounded-xl border border-zinc-700 bg-black">
          <img
            src={mapUrl}
            alt="Campaign theatre map"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 flex items-end justify-center pb-4">
            <p className="text-zinc-400 text-xs bg-black/70 rounded px-3 py-1">
              Tactical overlay — {layout} layout coming soon
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Spokes layout ─────────────────────────────────────────────────────────
  if (layout === "spokes") {
    const spokeMid = (spokesCfg.spokeInnerR + spokesCfg.spokeOuterR) / 2;
    const buildSpokesCopySnippet = () => [
      "// Spokes Calibration — paste into DEFAULT_SPOKES_CONFIG in CampaignMapOverlay.tsx",
      "export const DEFAULT_SPOKES_CONFIG: SpokesConfig = {",
      `  cx:             ${spokesCfg.cx},`,
      `  cy:             ${spokesCfg.cy},`,
      `  perspectiveY:   ${spokesCfg.perspectiveY.toFixed(2)},`,
      `  centerR:        ${spokesCfg.centerR},`,
      `  spokeInnerR:    ${spokesCfg.spokeInnerR},`,
      `  spokeOuterR:    ${spokesCfg.spokeOuterR},`,
      `  spokeGapDeg:    ${spokesCfg.spokeGapDeg},`,
      `  innerCyOffset:  ${spokesCfg.innerCyOffset},`,
      `  outerCyOffset:  ${spokesCfg.outerCyOffset},`,
      `  overlayOpacity: ${spokesCfg.overlayOpacity.toFixed(2)},`,
      "};",
    ].join("\n");

    return (
      <div className="space-y-2">
        <MapLegend />
        <div className="relative w-full aspect-square overflow-hidden rounded-xl border border-zinc-700 bg-black">
          <img
            src={mapUrl}
            alt="Campaign theatre map"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/15" />
          <SpokesOverlay props={props} geometry={spokesGeometry} cfg={spokesCfg} />
        </div>
        {isLead && (
          <div className="space-y-2 pt-1">
            {calibToggle}
            {calibOpen && (
              <CalibrationPanel
                cfg={spokesCfg as unknown as Record<string, number>}
                sliderDefs={SPOKES_SLIDER_DEFS}
                buildCopySnippet={buildSpokesCopySnippet}
                onChange={handleSpokesSliderChange}
                onReset={resetSpokesCfg}
                campaignId={campaignId}
                derivedValues={[
                  { label: "spokeMid",         value: spokeMid.toFixed(1) },
                  { label: "innerCy",           value: (spokesCfg.cy + spokesCfg.innerCyOffset).toFixed(0) },
                  { label: "outerCy",           value: (spokesCfg.cy + spokesCfg.outerCyOffset).toFixed(0) },
                  { label: "hubRy",             value: (spokesCfg.centerR * spokesCfg.perspectiveY).toFixed(1) },
                  { label: "outerRy",           value: (spokesCfg.spokeOuterR * spokesCfg.perspectiveY).toFixed(1) },
                  { label: "effectiveSweep°",   value: Math.max(360 / Math.max(props.zoneCount - 1, 1) - spokesCfg.spokeGapDeg, 5).toFixed(1) },
                ]}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Continent layout ──────────────────────────────────────────────────────
  if (layout === "continent") {
    const clusterSize  = Math.max(2, Math.round(props.zoneCount / 3));
    const clusterCount = Math.ceil(props.zoneCount / clusterSize);
    const buildContinentCopySnippet = () => [
      "// Continent Calibration — paste into DEFAULT_CONTINENT_CONFIG in CampaignMapOverlay.tsx",
      "export const DEFAULT_CONTINENT_CONFIG: ContinentConfig = {",
      `  cx:             ${continentCfg.cx},`,
      `  cy:             ${continentCfg.cy},`,
      `  planetR:        ${continentCfg.planetR},`,
      `  perspectiveY:   ${continentCfg.perspectiveY.toFixed(2)},`,
      `  innerRFraction: ${continentCfg.innerRFraction.toFixed(2)},`,
      `  clusterGapDeg:  ${continentCfg.clusterGapDeg},`,
      `  zoneGapDeg:     ${continentCfg.zoneGapDeg},`,
      `  innerCyOffset:  ${continentCfg.innerCyOffset},`,
      `  outerCyOffset:  ${continentCfg.outerCyOffset},`,
      `  overlayOpacity: ${continentCfg.overlayOpacity.toFixed(2)},`,
      "};",
    ].join("\n");

    return (
      <div className="space-y-2">
        <MapLegend />
        <div className="relative w-full aspect-square overflow-hidden rounded-xl border border-zinc-700 bg-black">
          <img
            src={mapUrl}
            alt="Campaign theatre map"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/15" />
          <ContinentOverlay props={props} geometry={continentGeometry} cfg={continentCfg} />
        </div>
        {isLead && (
          <div className="space-y-2 pt-1">
            {calibToggle}
            {calibOpen && (
              <CalibrationPanel
                cfg={continentCfg as unknown as Record<string, number>}
                sliderDefs={CONTINENT_SLIDER_DEFS}
                buildCopySnippet={buildContinentCopySnippet}
                onChange={handleContinentSliderChange}
                onReset={resetContinentCfg}
                campaignId={campaignId}
                derivedValues={[
                  { label: "clusters",    value: String(clusterCount) },
                  { label: "zonesPerCluster", value: String(clusterSize) },
                  { label: "innerR",      value: (continentCfg.planetR * continentCfg.innerRFraction).toFixed(1) },
                  { label: "outerRy",     value: (continentCfg.planetR * continentCfg.perspectiveY).toFixed(1) },
                  { label: "innerCy",     value: (continentCfg.cy + continentCfg.innerCyOffset).toFixed(0) },
                  { label: "outerCy",     value: (continentCfg.cy + continentCfg.outerCyOffset).toFixed(0) },
                ]}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Voidship layout ───────────────────────────────────────────────────────
  if (layout === "void_ship") {
    const perCol = Math.ceil(props.zoneCount / 2);
    const colW   = (voidshipCfg.shipW - voidshipCfg.gapX) / 2;
    const zoneH  = perCol > 1
      ? (voidshipCfg.shipH - (perCol - 1) * voidshipCfg.gapY) / perCol
      : voidshipCfg.shipH;
    const buildVoidshipCopySnippet = () => [
      "// Voidship Calibration — paste into DEFAULT_VOIDSHIP_CONFIG in CampaignMapOverlay.tsx",
      "export const DEFAULT_VOIDSHIP_CONFIG: VoidshipConfig = {",
      `  shipX:          ${voidshipCfg.shipX},`,
      `  shipY:          ${voidshipCfg.shipY},`,
      `  shipW:          ${voidshipCfg.shipW},`,
      `  shipH:          ${voidshipCfg.shipH},`,
      `  gapX:           ${voidshipCfg.gapX},`,
      `  gapY:           ${voidshipCfg.gapY},`,
      `  sectorGap:      ${voidshipCfg.sectorGap},`,
      `  overlayOpacity: ${voidshipCfg.overlayOpacity.toFixed(2)},`,
      "};",
    ].join("\n");

    return (
      <div className="space-y-2">
        <MapLegend />
        {/* Voidship uses aspect-video (16:9) — the ship is taller than wide */}
        <div className="relative w-full aspect-video overflow-hidden rounded-xl border border-zinc-700 bg-black">
          <img
            src={mapUrl}
            alt="Campaign theatre map"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/15" />
          <VoidshipOverlay props={props} geometry={voidshipGeometry} cfg={voidshipCfg} />
        </div>
        {isLead && (
          <div className="space-y-2 pt-1">
            {calibToggle}
            {calibOpen && (
              <CalibrationPanel
                cfg={voidshipCfg as unknown as Record<string, number>}
                sliderDefs={VOIDSHIP_SLIDER_DEFS}
                buildCopySnippet={buildVoidshipCopySnippet}
                onChange={handleVoidshipSliderChange}
                onReset={resetVoidshipCfg}
                campaignId={campaignId}
                derivedValues={[
                  { label: "perCol",   value: String(perCol) },
                  { label: "colW",     value: colW.toFixed(1) },
                  { label: "zoneH",    value: zoneH.toFixed(1) },
                  { label: "subW",     value: ((colW - voidshipCfg.sectorGap) / 2).toFixed(1) },
                  { label: "subH",     value: ((zoneH - voidshipCfg.sectorGap) / 2).toFixed(1) },
                ]}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Ring layout (default) ─────────────────────────────────────────────────
  const buildRingCopySnippet = () => [
    "// Ring Calibration — paste into DEFAULT_RING_CONFIG in CampaignMapOverlay.tsx",
    "export const DEFAULT_RING_CONFIG: RingConfig = {",
    `  cx:             ${ringCfg.cx},`,
    `  cy:             ${ringCfg.cy},`,
    `  perspectiveY:   ${ringCfg.perspectiveY.toFixed(2)},`,
    `  ringInner:      ${ringCfg.ringInner},`,
    `  ringOuter:      ${ringCfg.ringOuter},`,
    `  innerCyOffset:  ${ringCfg.innerCyOffset},`,
    `  outerCyOffset:  ${ringCfg.outerCyOffset},`,
    `  overlayOpacity: ${ringCfg.overlayOpacity.toFixed(2)},`,
    "};",
  ].join("\n");

  return (
    <div className="space-y-2">
      <MapLegend />
      <div className="relative w-full aspect-square overflow-hidden rounded-xl border border-zinc-700 bg-black">
        <img
          src={mapUrl}
          alt="Campaign theatre map"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-black/15" />
        <RingOverlay props={props} geometry={ringGeometry} cfg={ringCfg} />
      </div>
      {isLead && (
        <div className="space-y-2 pt-1">
          {calibToggle}
          {calibOpen && (
            <CalibrationPanel
              cfg={ringCfg as unknown as Record<string, number>}
              sliderDefs={RING_SLIDER_DEFS}
              buildCopySnippet={buildRingCopySnippet}
              onChange={handleRingSliderChange}
              onReset={resetRingCfg}
              campaignId={campaignId}
              derivedValues={[
                { label: "ringMid",  value: ringMid(ringCfg).toFixed(1) },
                { label: "innerCy",  value: (ringCfg.cy + ringCfg.innerCyOffset).toFixed(0) },
                { label: "outerCy",  value: (ringCfg.cy + ringCfg.outerCyOffset).toFixed(0) },
                { label: "innerRy",  value: (ringCfg.ringInner * ringCfg.perspectiveY).toFixed(1) },
                { label: "outerRy",  value: (ringCfg.ringOuter * ringCfg.perspectiveY).toFixed(1) },
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}
