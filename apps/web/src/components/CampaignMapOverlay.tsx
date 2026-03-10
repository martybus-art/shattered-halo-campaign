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
 *   others      — image shown without overlay (stub, extend as needed)
 *
 * Sector key → overlay position mapping (ring layout):
 *   "a" = inner band, first angular half  (inner-leading)
 *   "b" = inner band, second angular half (inner-trailing)
 *   "c" = outer band, first angular half  (outer-leading)
 *   "d" = outer band, second angular half (outer-trailing)
 *
 * Deploy to: apps/web/src/components/CampaignMapOverlay.tsx
 */

import React, { useMemo } from "react";

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

export type MapLayout = "ring" | "continent" | "radial" | "ship_line";

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

// ── Geometry constants (ring layout) ─────────────────────────────────────────
//
// SVG viewBox: 0 0 1000 1000, centre at (500, 500).
// The ring's inner void edge sits at radius 250 (~50% of frame).
// The ring's outer atmosphere edge sits at radius 430 (~86% of frame).
// These match the proportions requested in the AI generation prompt so the
// terrain detail roughly aligns with the sector division lines.

const CX = 500;
const CY = 500;
const RING_INNER = 250;
const RING_OUTER = 430;
const RING_MID = (RING_INNER + RING_OUTER) / 2;   // 340 — inner/outer band boundary

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

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number
): { x: number; y: number } {
  // Subtract 90° so angle 0 = top (north) instead of right (east)
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function wedgePath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number
): string {
  const p1 = polarToCartesian(cx, cy, outerR, startAngle);
  const p2 = polarToCartesian(cx, cy, outerR, endAngle);
  const p3 = polarToCartesian(cx, cy, innerR, endAngle);
  const p4 = polarToCartesian(cx, cy, innerR, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function wedgeCentroid(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number
): { x: number; y: number } {
  const midAngle = (startAngle + endAngle) / 2;
  const midR = (innerR + outerR) / 2;
  return polarToCartesian(cx, cy, midR, midAngle);
}

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

function useRingGeometry(props: CampaignMapOverlayProps): SectorGeometry[] {
  const { zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId } = props;

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

      // Midpoint of the full zone for label placement (outer band)
      const zoneLabelPoint = wedgeCentroid(
        CX, CY, RING_MID, RING_OUTER, zoneStart, zoneStart + zoneSweep
      );

      for (let si = 0; si < 4; si++) {
        const sectorKey = SECTOR_KEYS[si];
        const id = `${zoneKey}:${sectorKey}`;
        const isSelected = selectedSectorId === id;

        // Sector geometry within the zone:
        // si 0,1 = inner band (RING_INNER → RING_MID)
        // si 2,3 = outer band (RING_MID  → RING_OUTER)
        const isInnerBand = si < 2;
        const localHalf = si % 2; // 0 = leading half, 1 = trailing half

        const innerR = isInnerBand ? RING_INNER : RING_MID;
        const outerR = isInnerBand ? RING_MID : RING_OUTER;
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
          path: wedgePath(CX, CY, innerR, outerR, startAngle, endAngle),
          centroid: wedgeCentroid(CX, CY, innerR, outerR, startAngle, endAngle),
          zoneLabelPoint,
        });
      }
    }

    return result;
  }, [zoneCount, zoneKeys, sectors, units, currentUserId, selectedSectorId]);
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
}: {
  props: CampaignMapOverlayProps;
  geometry: SectorGeometry[];
}) {
  const { zoneCount, zoneKeys, onSectorClick, showZoneLabels } = props;
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
    >
      {/* ── Zone boundary outlines (always visible, zone colour) ── */}
      {Array.from({ length: zoneCount }, (_, zi) => {
        const zoneStart = zi * zoneSweep;
        const zoneEnd = zoneStart + zoneSweep;
        return (
          <path
            key={`zone-outline-${zi}`}
            d={wedgePath(CX, CY, RING_INNER, RING_OUTER, zoneStart, zoneEnd)}
            fill="none"
            stroke={zoneColour(zi)}
            strokeWidth={2.5}
            opacity={0.60}
            pointerEvents="none"
          />
        );
      })}

      {/* ── Sector fills, sector boundary lines, and icons ── */}
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
            {zoneKey.replace(/_/g, " ")}
          </text>
        ))}
    </svg>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function CampaignMapOverlay(props: CampaignMapOverlayProps) {
  const { mapUrl, layout } = props;

  const ringGeometry = useRingGeometry(props);

  // Non-ring layouts: show image with a "coming soon" stub overlay.
  // Extend this block with new layout renderers as they are implemented.
  if (layout !== "ring") {
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

  return (
    <div className="space-y-2">
      <MapLegend />
      <div className="relative w-full aspect-square overflow-hidden rounded-xl border border-zinc-700 bg-black">
        {/* AI-generated background map */}
        <img
          src={mapUrl}
          alt="Campaign theatre map"
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* Slight darkening veil — improves overlay legibility without killing image */}
        <div className="absolute inset-0 bg-black/15" />

        {/* Tactical SVG overlay */}
        <RingOverlay props={props} geometry={ringGeometry} />
      </div>
    </div>
  );
}
