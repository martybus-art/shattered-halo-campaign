// apps/web/src/app/map/page.tsx
// Tactical Hololith — campaign map viewer with movement order submission.
//
// changelog:
//   2026-03-15 — FEATURE: Sector info popup panel. Three new components added:
//                TagCard (renders a single SectorTag in brass card style),
//                CollapsibleSection (reusable ◈ toggle panel matching
//                CampaignMapOverlay's CalibrationPanel styling), and
//                SectorInfoPopupPanel (full intel display for a clicked zone/sector).
//                SectorInfoPopupPanel passes as popupSidePanel= prop to the
//                fullscreen map popup's CampaignMapOverlay so that clicking any
//                sector on the overlay fills the right column with grouped intel:
//                Field Unit, Defenses, Zone Benefits, Relics Discovered, Resources,
//                and Sector Intel sections — all collapsible, all data-driven.
//                CampaignMapOverlay.tsx gains popupSidePanel?: React.ReactNode prop;
//                all five layout branches render it when calibrationLocked=true.
//   2026-03-15 — FEATURE: Fullscreen map calibration popup. mapPopupOpen state
//                added. Right-column map thumbnail now has a hover expand hint;
//                clicking it opens a fixed fullscreen modal with CampaignMapOverlay
//                in popupMode (map left, calibration sliders right, always open).
//                Clicking the backdrop or ✕ closes the popup. Non-leads see the
//                expanded map without sliders (calibrationLocked=true when started).
//   2026-03-14 — UPDATE: isOverlayLayout extended to include "continent" and
//                "void_ship" layouts. normaliseLayout now also maps "ship_line"
//                -> "void_ship" for legacy DB rows. Both layouts use the full
//                2-column grid (action cards left, overlay map right) and pass
//                through to CampaignMapOverlay with isLead / campaignId props.
//   2026-03-11 — FIX: Normalise "spoke" -> "spokes" at load time. DB may store
//                either spelling; code and isOverlayLayout check require "spokes".
//   2026-03-11 — LAYOUT: For ring/spokes layouts, restructured to 2-column grid:
//                left col = My Units / Movement / Deploy / Pending Orders cards,
//                right col = CampaignMapOverlay map card. Non-ring layouts keep
//                existing single-column stacked layout.
//   2026-03-11 — FIX: Overlay condition was ring-only (mapLayout === "ring").
//                Changed to (mapLayout === "ring" || mapLayout === "spokes") so
//                spokes campaigns also use CampaignMapOverlay instead of falling
//                through to the side-by-side Hololith layout.
//                FIX: layout prop was hardcoded "ring"; now layout={mapLayout as any}.
//                STYLE: Overlay block wrapped in max-w-xl mx-auto container to
//                reduce map footprint on page.
//   2026-03-10 — INTEGRATION: CampaignMapOverlay replaces the side-by-side
//                Tactical Hololith + AI Theatre Map for ring layout campaigns
//                that have a generated AI map image. The new overlay renders
//                the AI image with a live SVG ring-sector overlay on top,
//                wired to the same toZone/toSector movement state. Non-ring
//                layouts and campaigns without an AI image continue to use
//                the original TacticalMap + MapImageDisplay 2-column layout.
//                bg_image_path now fetched from maps table; signed URL stored
//                in mapImageUrl state and passed to CampaignMapOverlay.
//   2026-03-09 — LAYOUT: Tactical Hololith and AI Theatre Map placed side-by-side
//                in a 2-column grid (lg:grid-cols-2). Hololith on the left, map
//                image on the right. Single-column on mobile; right column hidden
//                when no mapId is present.
//   2026-03-08 — FEATURE: Replaced zone/sector dropdowns with an interactive
//                SVG Tactical Layout Map. Design rules:
//                  • ALL zones always visible — layout shape reflects map type
//                    (ring / spoke / continent / void_ship)
//                  • ALL sectors (A/B/C/D) rendered as a 2×2 grid inside every
//                    zone node — always visible but colour-coded by state
//                  • Sectors are only CLICKABLE/SELECTABLE when the active unit
//                    is adjacent (or deep-strike is active) — out-of-range
//                    sectors appear greyed and non-interactive
//                  • Sector intel (tags: relics, NIP bonuses, hazards) is only
//                    shown in the intel panel when YOUR unit currently occupies
//                    that sector (occupation-gated intel reveal)
//                  • Fog-of-war still hides sector ownership from unknown zones,
//                    but the zone node and its 4 cells remain visible
//                  • Undiscovered zones rendered as dark fog-placeholder nodes
//                    using zone_count from the maps table to fill out topology
//   2026-03-07 — Reads rules_overrides.fog.enabled from campaign.
//   2026-03-05 — Initial movement orders panel, unit deployment, My Units card.

"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { bootstrapCampaignId } from "@/lib/campaignSession";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";
import { MapImageDisplay } from "@/components/MapImageDisplay";
import CampaignMapOverlay from "@/components/CampaignMapOverlay";

// ── Constants ─────────────────────────────────────────────────────────────────

const SECTOR_KEYS = ["a", "b", "c", "d"];

const UNIT_NIP_COST: Record<string, number> = {
  scout: 1,
  occupation: 2,
};

// SVG node geometry — all values in SVG user-unit pixels
const CELL   = 22;                      // individual sector cell side length
const GAP    = 3;                       // gap between cells in 2×2 grid
const PAD    = 6;                       // padding inside zone node border
const LBL_H  = 13;                      // zone label height at bottom of node
const GRID_W = CELL * 2 + GAP;         // 47 — two-cell row width
const GRID_H = CELL * 2 + GAP;         // 47 — two-cell column height
const NODE_W = GRID_W + PAD * 2;       // 59 — zone node total width
const NODE_H = GRID_H + PAD * 2 + LBL_H; // 72 — zone node total height
const SVG_W  = 600;
const SVG_H  = 480;

// Grimdark colour tokens
const COL_BRASS      = "#c9a84c";
const COL_BRASS_DIM  = "#7a5f22";
const COL_BLOOD      = "#7a1515";
const COL_GOLD       = "#f5c842";
const COL_GREEN      = "#3a6b3a";
const COL_GREEN_DIM  = "#1b2b1b";
const COL_EDGE_DIM   = "#252535";
const COL_EDGE_LIT   = "#3a3a5a";

// ── Types ─────────────────────────────────────────────────────────────────────

type SectorTag = {
  type:         string;
  label:        string;
  description?: string;
  value?:       number;
  icon?:        string;
};

type Sector = {
  zone_key:        string;
  sector_key:      string;
  owner_user_id:   string | null;
  revealed_public: boolean;
  fortified:       boolean;
  tags?:           SectorTag[] | null;
};

type MapZone = {
  key:      string;
  name:     string;
  sectors?: { key: string; name?: string }[];
};

type Unit = {
  id:             string;
  unit_type:      "scout" | "occupation";
  zone_key:       string;
  sector_key:     string;
  status:         string;
  round_deployed: number;
};

type Move = {
  id:              string;
  unit_id:         string | null;
  from_zone_key:   string;
  from_sector_key: string;
  to_zone_key:     string;
  to_sector_key:   string;
  move_type:       string;
  submitted_at:    string;
};

type Member = {
  user_id:        string;
  commander_name: string | null;
  faction_name:   string | null;
};

// ── Adjacency builder ─────────────────────────────────────────────────────────
// Returns Map<zone_key, Set<adjacent_zone_key>>. Self-adjacency always included.
//
//  "ring"      — circular: each zone → prev + next, wrapping
//  "spoke"     — zones[0] is the hub, connects to every outer zone;
//                outer zones also ring among themselves
//  "void_ship" — 2 parallel corridors (port / starboard), bridged at
//                bow (zones[0] ↔ zones[perCol]) and stern (zones[perCol-1] ↔ zones[n-1])
//  "continent" — clusters of ~3 internally ring-connected, bridged at one
//                chokepoint per cluster boundary

function buildAdjacency(zones: MapZone[], layout = "ring"): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const n   = zones.length;
  for (const z of zones) adj.set(z.key, new Set([z.key]));
  if (n <= 1) return adj;

  const link = (a: string, b: string) => {
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  switch (layout) {
    case "spoke": {
      const hub = zones[0].key;
      for (let i = 1; i < n; i++) {
        link(hub, zones[i].key);
        link(zones[i].key, zones[i === 1 ? n - 1 : i - 1].key);
      }
      break;
    }
    case "void_ship": {
      const perCol = Math.ceil(n / 2);
      for (let i = 0; i < perCol - 1; i++) link(zones[i].key, zones[i + 1].key);
      for (let i = perCol; i < n - 1; i++) link(zones[i].key, zones[i + 1].key);
      if (n > perCol) link(zones[0].key, zones[perCol].key);
      if (perCol > 1 && n > perCol) link(zones[perCol - 1].key, zones[n - 1].key);
      break;
    }
    case "continent": {
      const cs = Math.max(2, Math.round(n / Math.ceil(n / 3)));
      const nc = Math.ceil(n / cs);
      for (let c = 0; c < nc; c++) {
        const s = c * cs, e = Math.min(s + cs, n);
        const cl = zones.slice(s, e);
        for (let i = 0; i < cl.length; i++) link(cl[i].key, cl[(i + 1) % cl.length].key);
        if (c < nc - 1) link(cl[cl.length - 1].key, zones[e].key);
      }
      break;
    }
    case "ring":
    default: {
      for (let i = 0; i < n; i++) link(zones[i].key, zones[(i + 1) % n].key);
      break;
    }
  }
  return adj;
}

// ── Zone SVG positions ────────────────────────────────────────────────────────
// Returns the SVG canvas centre {x, y} for each zone's node bounding box.

function computePositions(zones: MapZone[], layout: string): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const n   = zones.length;
  if (n === 0) return pos;
  const cx = SVG_W / 2, cy = SVG_H / 2;

  switch (layout) {
    case "spoke": {
      pos.set(zones[0].key, { x: cx, y: cy });
      const r = 175;
      for (let i = 1; i < n; i++) {
        const a = ((i - 1) / Math.max(n - 1, 1)) * 2 * Math.PI - Math.PI / 2;
        pos.set(zones[i].key, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      break;
    }
    case "void_ship": {
      const perCol = Math.ceil(n / 2);
      const colX   = [SVG_W * 0.28, SVG_W * 0.72];
      const startY = 70;
      const step   = perCol > 1 ? (SVG_H - 120) / (perCol - 1) : 0;
      for (let i = 0; i < n; i++) {
        const col = i < perCol ? 0 : 1;
        const row = col === 0 ? i : i - perCol;
        pos.set(zones[i].key, { x: colX[col], y: startY + row * step });
      }
      break;
    }
    case "continent": {
      const cs = Math.max(2, Math.round(n / 3));
      const centres = [
        { x: cx * 0.58, y: cy * 0.70 },
        { x: cx * 1.42, y: cy * 0.62 },
        { x: cx,        y: cy * 1.52 },
      ];
      for (let i = 0; i < n; i++) {
        const ci = Math.min(Math.floor(i / cs), centres.length - 1);
        const ri = i % cs;
        const cc = centres[ci];
        const r  = cs <= 1 ? 0 : 82;
        const a  = (ri / cs) * 2 * Math.PI - Math.PI / 2;
        pos.set(zones[i].key, { x: cc.x + r * Math.cos(a), y: cc.y + r * Math.sin(a) });
      }
      break;
    }
    case "ring":
    default: {
      const r = 168;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI - Math.PI / 2;
        pos.set(zones[i].key, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      break;
    }
  }
  return pos;
}

// ── TacticalMap ───────────────────────────────────────────────────────────────

interface TacticalMapProps {
  zones:          MapZone[];
  layout:         string;
  adj:            Map<string, Set<string>>;
  sectors:        Sector[];
  uid:            string;
  memberById:     Map<string, Member>;
  myUnits:        Unit[];
  selectedUnit:   Unit | null;
  toZone:         string;
  toSector:       string;
  fogEnabled:     boolean;
  canMove:        boolean;
  hasDeepStrike:  boolean;
  onSelectSector: (zone: string, sector: string) => void;
}

function TacticalMap({
  zones, layout, adj, sectors, uid, memberById,
  myUnits, selectedUnit, toZone, toSector,
  fogEnabled, canMove, hasDeepStrike, onSelectSector,
}: TacticalMapProps) {
  const positions = useMemo(() => computePositions(zones, layout), [zones, layout]);

  const sectorLookup = useMemo(() => {
    const m = new Map<string, Sector>();
    for (const s of sectors) m.set(`${s.zone_key}:${s.sector_key}`, s);
    return m;
  }, [sectors]);

  // Zones where I currently have a unit
  const myUnitZones = useMemo(() => new Set(myUnits.map((u) => u.zone_key)), [myUnits]);

  // Valid destination zones for the selected unit
  const validZones = useMemo(() => {
    if (!selectedUnit || !canMove) return new Set<string>();
    if (hasDeepStrike) return new Set(zones.map((z) => z.key));
    return adj.get(selectedUnit.zone_key) ?? new Set<string>();
  }, [selectedUnit, canMove, hasDeepStrike, adj, zones]);

  // Deduplicated edges for connector lines
  const edges = useMemo(() => {
    const seen = new Set<string>(), out: [string, string][] = [];
    for (const [zk, nb] of adj.entries())
      for (const n of nb) {
        if (n === zk) continue;
        const k = [zk, n].sort().join("|");
        if (!seen.has(k)) { seen.add(k); out.push([zk, n]); }
      }
    return out;
  }, [adj]);

  // Determine visual state of a sector cell
  const cellState = (zk: string, sk: string) => {
    if (zk.startsWith("_fog_")) return "fog";
    if (toZone === zk && toSector === sk) return "selected";
    const s         = sectorLookup.get(`${zk}:${sk}`);
    const hasMyUnit = myUnits.some((u) => u.zone_key === zk && u.sector_key === sk);
    const zoneKnown = myUnitZones.has(zk) || !fogEnabled;

    if (hasMyUnit)                   return "mine_unit";
    if (s?.owner_user_id === uid)    return "mine_empty";
    if (s?.owner_user_id && s.owner_user_id !== uid) {
      if (!zoneKnown && !s.revealed_public) return "fog_cell";
      return "enemy";
    }
    if (!zoneKnown && !(s?.revealed_public)) return "fog_cell";
    // Unclaimed / unknown — only green/reachable if a unit is selected and range allows
    return (canMove && selectedUnit && validZones.has(zk)) ? "reachable" : "empty";
  };

  type CellState = ReturnType<typeof cellState>;

  const cellFill = (st: CellState): string => ({
    selected:  "#3d3000",
    mine_unit: "#5a3d08",
    mine_empty:"#221800",
    enemy:     "#3a0a0a",
    reachable: COL_GREEN_DIM,
    fog_cell:  "#0a0a10",
    fog:       "#0a0a10",
    empty:     "#0f0f1a",
  }[st] ?? "#0f0f1a");

  const cellStroke = (st: CellState): string => ({
    selected:  COL_GOLD,
    mine_unit: COL_BRASS,
    mine_empty:COL_BRASS_DIM,
    enemy:     COL_BLOOD,
    reachable: COL_GREEN,
    fog_cell:  "#181826",
    fog:       "#181826",
    empty:     COL_EDGE_DIM,
  }[st] ?? COL_EDGE_DIM);

  const cellTextFill = (st: CellState): string => ({
    selected:  COL_GOLD,
    mine_unit: COL_BRASS,
    mine_empty:COL_BRASS_DIM,
    enemy:     "#c04040",
    reachable: "#5aaa5a",
    fog_cell:  "#1e1e30",
    fog:       "#1e1e30",
    empty:     "#2e2e45",
  }[st] ?? "#2e2e45");

  // 2×2 grid cell positions relative to top-left of grid area
  const CELLS = [
    { key: "a", col: 0, row: 0 },
    { key: "b", col: 1, row: 0 },
    { key: "c", col: 0, row: 1 },
    { key: "d", col: 1, row: 1 },
  ] as const;

  if (zones.length === 0) {
    return (
      <div className="flex items-center justify-center h-28 rounded border border-brass/10 bg-void/40">
        <p className="text-parchment/30 text-sm italic">Awaiting tactical data…</p>
      </div>
    );
  }

  const isHubSpoke = (z: MapZone) => layout === "spoke" && zones.indexOf(z) === 0;

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="w-full select-none"
      style={{ background: "transparent" }}
      aria-label="Tactical layout map"
    >
      {/* Adjacency connector lines */}
      {edges.map(([a, b]) => {
        const pa = positions.get(a), pb = positions.get(b);
        if (!pa || !pb) return null;
        const highlight = selectedUnit && canMove && (
          (validZones.has(a) && myUnitZones.has(b)) ||
          (validZones.has(b) && myUnitZones.has(a))
        );
        return (
          <line
            key={`${a}|${b}`}
            x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
            stroke={highlight ? "#4a6a4a" : COL_EDGE_DIM}
            strokeWidth={highlight ? 1.5 : 0.6}
            strokeDasharray={highlight ? undefined : "3 5"}
            opacity={highlight ? 0.8 : 0.35}
          />
        );
      })}

      {/* Zone nodes */}
      {zones.map((zone) => {
        const p = positions.get(zone.key);
        if (!p) return null;

        const isFog   = zone.key.startsWith("_fog_");
        const isMine  = myUnitZones.has(zone.key);
        const isReach = validZones.has(zone.key);
        const isHub   = isHubSpoke(zone);
        const scale   = isHub ? 1.15 : 1.0;

        const nw = NODE_W * scale, nh = NODE_H * scale;
        const nx = p.x - nw / 2, ny = p.y - nh / 2;
        const gx = nx + PAD * scale, gy = ny + PAD * scale;

        const nodeBorder = isMine  ? COL_BRASS
                         : isReach ? COL_GREEN
                         : isFog   ? "#14141e"
                         :           "#222235";
        const nodeFill   = isMine  ? "#120e00"
                         : isFog   ? "#07070e"
                         :           "#0b0b14";

        return (
          <g key={zone.key}>
            {/* Node background */}
            <rect
              x={nx} y={ny} width={nw} height={nh} rx={3}
              fill={nodeFill}
              stroke={nodeBorder}
              strokeWidth={isMine || isHub ? 1.5 : 0.7}
              opacity={isFog ? 0.5 : 1}
            />

            {/* 2×2 sector grid (not drawn for fog placeholder nodes) */}
            {!isFog && CELLS.map(({ key: sk, col, row }) => {
              const cw  = CELL * scale, ch = CELL * scale;
              const cx2 = gx + col * (cw + GAP);
              const cy2 = gy + row * (ch + GAP);
              const st  = cellState(zone.key, sk);
              const fill   = cellFill(st);
              const stroke = cellStroke(st);
              const tclr   = cellTextFill(st);

              // A sector cell is interactive only when:
              //   1. A unit is selected AND it's the movement phase
              //   2. This zone is within adjacency range (or deep-strike)
              //   3. This is not a fog-placeholder zone
              const interactive = isReach && canMove && !!selectedUnit;

              const s       = sectorLookup.get(`${zone.key}:${sk}`);
              const hasUnit = myUnits.some((u) => u.zone_key === zone.key && u.sector_key === sk);

              return (
                <g
                  key={sk}
                  style={{ cursor: interactive ? "pointer" : "default" }}
                  onClick={() => interactive && onSelectSector(zone.key, sk)}
                >
                  {/* Cell background */}
                  <rect
                    x={cx2} y={cy2} width={cw} height={ch} rx={2}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={st === "selected" ? 2 : 1}
                  />
                  {/* Sector key label */}
                  <text
                    x={cx2 + cw / 2} y={cy2 + ch / 2 + 1}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={7.5 * scale}
                    fontFamily="monospace"
                    fontWeight={st === "selected" ? "bold" : "normal"}
                    fill={tclr}
                    style={{ pointerEvents: "none" }}
                  >
                    {(st === "fog_cell") ? "?" : sk.toUpperCase()}
                  </text>
                  {/* Gold dot — my unit present in this cell */}
                  {hasUnit && (
                    <circle
                      cx={cx2 + cw - 4 * scale}
                      cy={cy2 + 4 * scale}
                      r={2.5 * scale}
                      fill={COL_GOLD}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {/* Fortification indicator */}
                  {s?.fortified && st !== "fog_cell" && (
                    <text
                      x={cx2 + 2.5} y={cy2 + ch - 2}
                      fontSize={6 * scale} fill={COL_BLOOD}
                      style={{ pointerEvents: "none" }}
                    >⬡</text>
                  )}
                  {/* Subtle hover glow for reachable cells */}
                  {interactive && st !== "selected" && (
                    <rect
                      x={cx2} y={cy2} width={cw} height={ch} rx={2}
                      fill="transparent"
                      stroke={COL_GREEN}
                      strokeWidth={0.4}
                      opacity={0.5}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                </g>
              );
            })}

            {/* Fog node interior text */}
            {isFog && (
              <text
                x={p.x} y={p.y}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={12} fontFamily="monospace" fill="#1c1c2e"
                style={{ pointerEvents: "none" }}
              >???</text>
            )}

            {/* Zone name label at bottom of node */}
            {!isFog && (
              <text
                x={p.x} y={ny + nh - 2}
                textAnchor="middle" dominantBaseline="auto"
                fontSize={6.5} fontFamily="monospace" letterSpacing={0.4}
                fill={isMine ? COL_BRASS : isReach ? "#5aaa5a" : "#3a3a52"}
                style={{ pointerEvents: "none" }}
              >
                {zone.name.slice(0, 15).toUpperCase()}
              </text>
            )}

            {/* Hub badge for spoke layout centre */}
            {isHub && (
              <text
                x={p.x} y={ny - 4}
                textAnchor="middle" dominantBaseline="auto"
                fontSize={6} fontFamily="monospace" fill={COL_BRASS_DIM}
                style={{ pointerEvents: "none" }}
              >▲ SPIRE</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── SectorIntelPanel ──────────────────────────────────────────────────────────
// Only renders when a unit occupies the given sector AND it has tags or fortification.

function SectorIntelPanel({
  zoneKey, sectorKey, sector,
}: {
  zoneKey: string;
  sectorKey: string;
  sector: Sector | undefined;
}) {
  if (!sector) return null;
  const tags: SectorTag[] = Array.isArray(sector.tags) ? sector.tags : [];
  if (tags.length === 0 && !sector.fortified) return null;

  const fmtKey = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="mt-3 pt-3 border-t border-brass/15 space-y-1.5">
      <p className="text-xs text-brass/50 uppercase tracking-widest font-mono">
        ◈ Intel — {fmtKey(zoneKey)} / {sectorKey.toUpperCase()}
      </p>
      {sector.fortified && (
        <div className="flex items-start gap-2.5 px-3 py-2 rounded border border-blood/30 bg-blood/5">
          <span className="text-blood/80 shrink-0 mt-0.5">⬡</span>
          <div>
            <p className="text-sm text-blood/80 font-semibold">Fortified Position</p>
            <p className="text-xs text-parchment/40 mt-0.5">
              Attacking forces suffer a defensive penalty. Siege assets or overwhelming numbers recommended.
            </p>
          </div>
        </div>
      )}
      {tags.map((tag, i) => (
        <div key={i} className="flex items-start gap-2.5 px-3 py-2 rounded border border-brass/20 bg-brass/5">
          <span className="text-brass shrink-0 mt-0.5">{tag.icon ?? "◈"}</span>
          <div>
            <p className="text-sm text-brass/90 font-semibold">{tag.label}</p>
            {tag.description && (
              <p className="text-xs text-parchment/55 mt-0.5">{tag.description}</p>
            )}
            {tag.value !== undefined && (
              <p className="text-xs text-brass/55 font-mono mt-0.5">
                {tag.type === "nip_bonus" ? `+${tag.value} NIP / round` : `Value: ${tag.value}`}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── TagCard ───────────────────────────────────────────────────────────────────
// Renders a single sector / zone tag in the grimdark card style.
// Reused by SectorInfoPopupPanel and SectorIntelPanel logic.

function TagCard({ tag }: { tag: SectorTag }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2 rounded border border-brass/20 bg-brass/5">
      <span className="text-brass shrink-0 mt-0.5">{tag.icon ?? "◈"}</span>
      <div>
        <p className="text-sm text-brass/90 font-semibold">{tag.label}</p>
        {tag.description && (
          <p className="text-xs text-parchment/55 mt-0.5">{tag.description}</p>
        )}
        {tag.value !== undefined && (
          <p className="text-xs text-brass/55 font-mono mt-0.5">
            {tag.type === "nip_bonus" ? `+${tag.value} NIP / round` : `Value: ${tag.value}`}
          </p>
        )}
      </div>
    </div>
  );
}

// ── CollapsibleSection ────────────────────────────────────────────────────────
// Reusable collapsible panel with a brass ◈ toggle, matching the visual style
// of CampaignMapOverlay's CalibrationPanel for consistency in the map popup.

function CollapsibleSection({
  title,
  defaultOpen = false,
  badge,
  children,
}: {
  title:        string;
  defaultOpen?: boolean;
  badge?:       React.ReactNode;
  children:     React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-brass/20 bg-iron/80 text-sm overflow-hidden">
      <button
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-brass/5 transition-colors text-left group"
        aria-expanded={open}
      >
        <span
          className={`text-brass/60 text-xs shrink-0 transition-transform duration-200 inline-block ${open ? "" : "-rotate-90"}`}
        >
          ◈
        </span>
        <span className="text-brass font-semibold font-mono tracking-wide text-xs uppercase group-hover:text-brass/80 transition-colors flex-1">
          {title}
        </span>
        {badge && <span className="shrink-0 ml-1">{badge}</span>}
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-brass/15 pt-3 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}

// ── SectorInfoPopupPanel ──────────────────────────────────────────────────────
// Shown in the right column of the fullscreen map popup (popupMode=true) once
// the campaign has started and calibration is locked.
//
// Displays structured intel for the currently clicked zone / sector, grouped
// into collapsible sections that match CalibrationPanel's visual style:
//   • Zone / sector header  — ownership badge, fortification status
//   • Field Unit            — scout or occupation, round deployed
//   • Defenses              — fortified position + defensive tags
//   • Zone Benefits         — zone_benefit tags aggregated from zone's sectors
//   • Relics Discovered     — relic tags on this sector
//   • Resources             — nip_bonus tags + zone-wide NIP total
//   • Sector Intel          — all other tags
//
// All sections render only when relevant data exists; a placeholder is shown
// when nothing has been clicked yet.

function SectorInfoPopupPanel({
  zoneKey,
  sectorKey,
  sectors,
  zones,
  myUnits,
  memberById,
  uid,
}: {
  zoneKey:    string;
  sectorKey:  string;
  sectors:    Sector[];
  zones:      MapZone[];
  myUnits:    Unit[];
  memberById: Map<string, Member>;
  uid:        string;
}) {
  // ── Empty state ─────────────────────────────────────────────────────────
  if (!zoneKey || !sectorKey) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-parchment/25 text-sm text-center font-mono space-y-2 px-4">
        <span className="text-3xl opacity-20">◈</span>
        <p className="leading-relaxed">
          Click a sector on the map<br />to view its intelligence report.
        </p>
      </div>
    );
  }

  // ── Data resolution ──────────────────────────────────────────────────────
  const zone        = zones.find((z) => z.key === zoneKey);
  const sector      = sectors.find((s) => s.zone_key === zoneKey && s.sector_key === sectorKey);
  const zoneSectors = sectors.filter((s) => s.zone_key === zoneKey);
  const myUnit      = myUnits.find((u) => u.zone_key === zoneKey && u.sector_key === sectorKey);
  const isMine      = sector?.owner_user_id === uid;
  const isRevealed  = !!(sector?.revealed_public || isMine || myUnit);

  const ownerInfo = sector?.owner_user_id
    ? (sector.owner_user_id === uid
        ? { label: "You", mine: true }
        : { label: memberById.get(sector.owner_user_id)?.commander_name ?? "Enemy Commander", mine: false })
    : null;

  // ── Tag buckets (sector-level) ───────────────────────────────────────────
  const tags: SectorTag[]  = Array.isArray(sector?.tags) ? sector!.tags! : [];
  const defTags   = tags.filter((t) => t.type === "defensive");
  const relicTags = tags.filter((t) => t.type === "relic");
  const nipTags   = tags.filter((t) => t.type === "nip_bonus");
  const otherTags = tags.filter(
    (t) => !["defensive", "relic", "nip_bonus", "zone_benefit"].includes(t.type),
  );

  // ── Zone benefits — deduplicated zone_benefit tags from visible sectors ──
  const seenBenefits   = new Set<string>();
  const zoneBenefitTags: SectorTag[] = [];
  for (const zs of zoneSectors) {
    const canSee = zs.owner_user_id === uid
      || zs.revealed_public
      || myUnits.some((u) => u.zone_key === zoneKey && u.sector_key === zs.sector_key);
    if (!canSee) continue;
    const ztags: SectorTag[] = Array.isArray(zs.tags) ? zs.tags : [];
    for (const t of ztags) {
      if (t.type === "zone_benefit" && !seenBenefits.has(t.label)) {
        seenBenefits.add(t.label);
        zoneBenefitTags.push(t);
      }
    }
  }

  // ── Zone-wide NIP total from owned sectors ───────────────────────────────
  const zoneNipTotal = zoneSectors.reduce((sum, zs) => {
    if (zs.owner_user_id !== uid) return sum;
    const ztags: SectorTag[] = Array.isArray(zs.tags) ? zs.tags : [];
    return sum + ztags
      .filter((t) => t.type === "nip_bonus")
      .reduce((s, t) => s + (t.value ?? 0), 0);
  }, 0);

  const hasNoFeatures = !myUnit && !sector?.fortified
    && defTags.length === 0 && zoneBenefitTags.length === 0
    && relicTags.length === 0 && nipTags.length === 0 && otherTags.length === 0;

  return (
    <div className="space-y-2">

      {/* ── Zone / sector header ── */}
      <div className="rounded-lg border border-brass/30 bg-iron/80 px-4 py-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-brass/60 text-xs uppercase tracking-widest font-mono shrink-0">
            ◈ {fmtKey(zoneKey)} / {sectorKey.toUpperCase()}
          </p>
          {zone && zone.name !== fmtKey(zoneKey) && (
            <span className="text-parchment/30 text-xs font-mono truncate">{zone.name}</span>
          )}
        </div>

        {!isRevealed ? (
          <p className="text-parchment/30 italic text-xs">
            Unknown. Deploy a scout to gather intel on this sector.
          </p>
        ) : ownerInfo ? (
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded border ${
            ownerInfo.mine
              ? "border-brass/30 bg-brass/10 text-brass/80"
              : "border-blood/30 bg-blood/10 text-blood/80"
          }`}>
            <span className="font-semibold text-sm">
              {ownerInfo.mine ? "Held by you" : `Held by ${ownerInfo.label}`}
            </span>
            {sector?.fortified && (
              <span className="ml-auto text-xs border border-blood/30 px-1.5 py-0.5 rounded font-mono">
                ⬡ Fortified
              </span>
            )}
          </div>
        ) : (
          <p className="text-parchment/45 text-xs italic">Uncontrolled sector.</p>
        )}
      </div>

      {/* ── Sections only when sector is visible ── */}
      {isRevealed && (
        <>
          {/* Field Unit */}
          {myUnit && (
            <CollapsibleSection title="Field Unit" defaultOpen>
              <div className={`flex items-center gap-2 px-3 py-2 rounded border ${
                myUnit.unit_type === "scout"
                  ? "border-blue-400/30 bg-blue-500/10"
                  : "border-brass/30 bg-brass/10"
              }`}>
                <span className={`text-xs px-2 py-0.5 rounded border font-mono uppercase font-semibold ${
                  myUnit.unit_type === "scout"
                    ? "bg-blue-500/20 border-blue-400/40 text-blue-300"
                    : "bg-brass/20 border-brass/40 text-brass"
                }`}>
                  {myUnit.unit_type}
                </span>
                <span className="text-parchment/60 text-xs">unit present</span>
                <span className="ml-auto text-parchment/30 text-xs font-mono">
                  R{myUnit.round_deployed}
                </span>
              </div>
              <p className="text-parchment/40 text-xs leading-relaxed">
                {myUnit.unit_type === "scout"
                  ? "Scout unit — grants zone visibility and may move during the recon phase."
                  : "Occupation unit — holds this sector and defends it when attacked."}
              </p>
            </CollapsibleSection>
          )}

          {/* Defenses */}
          {(sector?.fortified || defTags.length > 0) && (
            <CollapsibleSection title="Defenses" defaultOpen>
              {sector?.fortified && (
                <div className="flex items-start gap-2.5 px-3 py-2 rounded border border-blood/30 bg-blood/5">
                  <span className="text-blood/80 shrink-0 mt-0.5">⬡</span>
                  <div>
                    <p className="text-sm text-blood/80 font-semibold">Fortified Position</p>
                    <p className="text-xs text-parchment/40 mt-0.5">
                      Attackers suffer a defensive penalty. Siege assets or overwhelming force recommended.
                    </p>
                  </div>
                </div>
              )}
              {defTags.map((tag, i) => <TagCard key={i} tag={tag} />)}
            </CollapsibleSection>
          )}

          {/* Zone Benefits */}
          {zoneBenefitTags.length > 0 && (
            <CollapsibleSection title="Zone Benefits" defaultOpen>
              {zoneBenefitTags.map((tag, i) => <TagCard key={i} tag={tag} />)}
            </CollapsibleSection>
          )}

          {/* Relics */}
          {relicTags.length > 0 && (
            <CollapsibleSection title="Relics Discovered" defaultOpen>
              {relicTags.map((tag, i) => <TagCard key={i} tag={tag} />)}
            </CollapsibleSection>
          )}

          {/* Resources / NIP income */}
          {(nipTags.length > 0 || zoneNipTotal > 0) && (
            <CollapsibleSection title="Resources" defaultOpen>
              {nipTags.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-parchment/40 text-xs font-mono uppercase tracking-wide">
                    Sector Income
                  </p>
                  {nipTags.map((tag, i) => <TagCard key={i} tag={tag} />)}
                </div>
              )}
              {zoneNipTotal > 0 && (
                <div className="flex items-center gap-2 px-3 py-2 rounded border border-brass/20 bg-brass/5">
                  <span className="text-brass/70 text-xs font-mono">⊕</span>
                  <span className="text-parchment/60 text-xs">Zone NIP income (all held sectors)</span>
                  <span className="ml-auto text-brass font-mono font-semibold text-sm">
                    +{zoneNipTotal} / round
                  </span>
                </div>
              )}
            </CollapsibleSection>
          )}

          {/* Other / miscellaneous intel tags */}
          {otherTags.length > 0 && (
            <CollapsibleSection title="Sector Intel">
              {otherTags.map((tag, i) => <TagCard key={i} tag={tag} />)}
            </CollapsibleSection>
          )}

          {/* No-data state */}
          {hasNoFeatures && (
            <div className="px-4 py-6 text-center text-parchment/25 text-xs font-mono italic border border-brass/10 rounded-lg">
              No special features recorded for this sector.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const supabase   = useMemo(() => supabaseBrowser(), []);
  const [campaignId] = useState<string>(() => bootstrapCampaignId());

  const [mapId,         setMapId]         = useState<string | null>(null);
  const [role,          setRole]          = useState<string>("player");
  const [uid,           setUid]           = useState<string>("");
  const [authChecked,   setAuthChecked]   = useState(false);
  const [zones,         setZones]         = useState<MapZone[]>([]);
  const [mapZoneCount,  setMapZoneCount]  = useState<number | null>(null);
  const [sectors,       setSectors]       = useState<Sector[]>([]);
  const [myUnits,       setMyUnits]       = useState<Unit[]>([]);
  const [myMoves,       setMyMoves]       = useState<Move[]>([]);
  const [members,       setMembers]       = useState<Member[]>([]);
  const [roundNumber,   setRoundNumber]   = useState<number>(1);
  const [stage,         setStage]         = useState<string | null>(null);
  const [myNip,         setMyNip]         = useState<number>(0);
  const [hasDeepStrike, setHasDeepStrike] = useState(false);
  const [hasRecon,      setHasRecon]      = useState(false);
  const [fogEnabled,    setFogEnabled]    = useState<boolean>(true);
  const [mapLayout,     setMapLayout]     = useState<string>("ring");
  const [mapImageUrl,   setMapImageUrl]   = useState<string | null>(null);
  const [pageError,     setPageError]     = useState<string | null>(null);
  const [loading,       setLoading]       = useState(false);

  // Movement order state
  const [selectedUnit,  setSelectedUnit]  = useState<Unit | null>(null);
  const [toZone,        setToZone]        = useState<string>("");
  const [toSector,      setToSector]      = useState<string>("");
  const [submitting,    setSubmitting]    = useState(false);
  const [moveResult,    setMoveResult]    = useState<string | null>(null);

  // Clicked sector state — always active regardless of phase; drives the info
  // panel shown when a player clicks any sector on the SVG overlay.
  const [clickedZone,   setClickedZone]   = useState<string>("");
  const [clickedSector, setClickedSector] = useState<string>("");

  // Map calibration popup — fullscreen overlay with map left / sliders right
  const [mapPopupOpen,  setMapPopupOpen]  = useState(false);

  // Deploy unit state
  const [deployType,    setDeployType]    = useState<"scout" | "occupation">("scout");
  const [deployZone,    setDeployZone]    = useState<string>("");
  const [deploySector,  setDeploySector]  = useState<string>("");
  const [deploying,     setDeploying]     = useState(false);
  const [deployResult,  setDeployResult]  = useState<string | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true); setPageError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { window.location.href = "/"; return; }
      setUid(user.id); setAuthChecked(true);
      if (!campaignId) return;

      // Role
      const { data: mem } = await supabase
        .from("campaign_members").select("role")
        .eq("campaign_id", campaignId).eq("user_id", user.id).maybeSingle();
      setRole(mem?.role ?? "player");

      // Campaign
      const { data: c, error: ce } = await supabase
        .from("campaigns").select("map_id,round_number,rules_overrides")
        .eq("id", campaignId).single();
      if (ce) throw new Error(ce.message);
      setMapId((c as any)?.map_id ?? null);
      const rn = (c as any)?.round_number ?? 1;
      setRoundNumber(rn);
      const ro = ((c as any)?.rules_overrides ?? {}) as Record<string, any>;
      setFogEnabled((ro.fog as any)?.enabled !== false);
      // Normalise layout spelling — DB may store older variants.
      // "spoke" -> "spokes", "ship_line" -> "void_ship" (legacy alias)
      const normaliseLayout = (l: string): string => {
        if (l === "spoke")     return "spokes";
        if (l === "ship_line") return "void_ship";
        return l;
      };
      setMapLayout(normaliseLayout((ro.map_layout as string | undefined) ?? "ring"));

      // Round stage
      const { data: rnd } = await supabase
        .from("rounds").select("stage")
        .eq("campaign_id", campaignId).eq("round_number", rn).maybeSingle();
      setStage(rnd?.stage ?? null);

      // Map zones
      if ((c as any)?.map_id) {
        const { data: mapRow } = await supabase
          .from("maps").select("map_json,zone_count,layout,bg_image_path")
          .eq("id", (c as any).map_id).maybeSingle();
        const zoneList: MapZone[] = (mapRow?.map_json as any)?.zones ?? [];
        setZones(zoneList);
        setMapZoneCount((mapRow?.zone_count as number | null) ?? null);
        // Fall back to map table layout if rules_overrides doesn't set one
        if (!ro.map_layout && (mapRow as any)?.layout) {
          setMapLayout(normaliseLayout((mapRow as any).layout as string));
        }
        // Fetch signed URL for AI map image
        if ((mapRow as any)?.bg_image_path) {
          const { data: signed } = await supabase.storage
            .from("campaign-maps")
            .createSignedUrl((mapRow as any).bg_image_path, 3600);
          setMapImageUrl(signed?.signedUrl ?? null);
        } else {
          setMapImageUrl(null);
        }
      }

      // Sectors (includes tags)
      const { data: sd } = await supabase
        .from("sectors")
        .select("zone_key,sector_key,owner_user_id,revealed_public,fortified,tags")
        .eq("campaign_id", campaignId);
      setSectors(sd ?? []);

      // Members
      const { data: md } = await supabase
        .from("campaign_members").select("user_id,commander_name,faction_name")
        .eq("campaign_id", campaignId);
      setMembers(md ?? []);

      // My units
      const { data: ud } = await supabase
        .from("units").select("id,unit_type,zone_key,sector_key,status,round_deployed")
        .eq("campaign_id", campaignId).eq("user_id", user.id).eq("status", "active");
      const units = (ud ?? []) as Unit[];
      setMyUnits(units);

      // My moves
      const { data: mvd } = await supabase
        .from("moves")
        .select("id,unit_id,from_zone_key,from_sector_key,to_zone_key,to_sector_key,move_type,submitted_at")
        .eq("campaign_id", campaignId).eq("round_number", rn).eq("user_id", user.id);
      setMyMoves((mvd ?? []) as Move[]);

      // NIP + tokens
      const { data: ps } = await supabase
        .from("player_state").select("nip")
        .eq("campaign_id", campaignId).eq("user_id", user.id).maybeSingle();
      setMyNip(ps?.nip ?? 0);

      const { data: sp } = await supabase
        .from("round_spends").select("spend_type")
        .eq("campaign_id", campaignId).eq("round_number", rn).eq("user_id", user.id);
      const st = new Set((sp ?? []).map((s: any) => s.spend_type));
      setHasDeepStrike(st.has("deep_strike"));
      setHasRecon(st.has("recon"));

      // Seed deploy zone
      if (!deployZone && ud && ud.length > 0) {
        const owned = (sd ?? []).filter((s: any) => s.owner_user_id === user.id);
        if (owned.length > 0) setDeployZone((owned[0] as any).zone_key);
      }

    } catch (e: any) {
      setPageError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [campaignId, supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const effectiveZones = useMemo<MapZone[]>(() => {
    if (zones.length > 0) return zones;
    const seen = new Set<string>(), out: MapZone[] = [];
    for (const s of sectors) {
      if (!seen.has(s.zone_key)) { seen.add(s.zone_key); out.push({ key: s.zone_key, name: fmtKey(s.zone_key) }); }
    }
    for (const u of myUnits) {
      if (!seen.has(u.zone_key)) { seen.add(u.zone_key); out.push({ key: u.zone_key, name: fmtKey(u.zone_key) }); }
    }
    return out;
  }, [zones, sectors, myUnits]);

  // Full zone list including fog stubs for undiscovered zones
  const allZones = useMemo<MapZone[]>(() => {
    if (!mapZoneCount || effectiveZones.length >= mapZoneCount) return effectiveZones;
    const fogStubs = Array.from(
      { length: mapZoneCount - effectiveZones.length },
      (_, i) => ({ key: `_fog_${i}`, name: "Unknown" }),
    );
    return [...effectiveZones, ...fogStubs];
  }, [effectiveZones, mapZoneCount]);

  const adj = useMemo(() => buildAdjacency(allZones, mapLayout), [allZones, mapLayout]);

  // Ordered zone keys for CampaignMapOverlay (derived from effectiveZones which comes from map_json.zones)
  const zoneKeys = useMemo(() => effectiveZones.map((z) => z.key), [effectiveZones]);
  const zoneNames = useMemo(() => effectiveZones.map((z) => z.name), [effectiveZones]); 

  // Combined sector ID for CampaignMapOverlay ("zoneKey:sectorKey" format)
  // Movement target takes priority; falls back to last clicked sector for info panel.
  const selectedSectorId = toZone && toSector
    ? `${toZone}:${toSector}`
    : clickedZone && clickedSector
    ? `${clickedZone}:${clickedSector}`
    : null;

  const memberById = useMemo(() => {
    const m = new Map<string, Member>();
    members.forEach((mem) => m.set(mem.user_id, mem));
    return m;
  }, [members]);

  const mySectors = useMemo(() => sectors.filter((s) => s.owner_user_id === uid), [sectors, uid]);

  const inMovementPhase = stage === "movement";
  const inReconPhase    = stage === "recon";
  const canMove         = inMovementPhase || (inReconPhase && hasRecon);
  const inSpendPhase    = stage === "spend";
  // Overlay calibration is locked once the campaign has started (round_number > 0)
  const calibrationLocked = roundNumber > 0;

  // ── Actions ───────────────────────────────────────────────────────────────

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  const submitMove = async () => {
    if (!selectedUnit || !toZone || !toSector) return;
    setSubmitting(true); setMoveResult(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/submit-move`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ campaign_id: campaignId, unit_id: selectedUnit.id, to_zone_key: toZone, to_sector_key: toSector }),
        },
      );
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      let msg = `Order confirmed: ${selectedUnit.unit_type} → ${fmtKey(toZone)} / ${toSector.toUpperCase()}`;
      if (data.auto_transfer)   msg += " — territory captured";
      if (data.conflict_id)     msg += " — ⚔️ CONFLICT initiated";
      if (data.defensive_bonus) msg += " (defender bonus — zone unscouted)";
      setMoveResult(msg);
      setSelectedUnit(null); setToZone(""); setToSector("");
      await load();
    } catch (e: any) {
      setMoveResult(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const deployUnit = async () => {
    if (!deployZone || !deploySector) return;
    setDeploying(true); setDeployResult(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/deploy-unit`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ campaign_id: campaignId, unit_type: deployType, zone_key: deployZone, sector_key: deploySector }),
        },
      );
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      setDeployResult(`${fmtKey(deployType)} unit deployed. ${data.nip_remaining} NIP remaining.`);
      await load();
    } catch (e: any) {
      setDeployResult(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setDeploying(false);
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const sectorAt   = (zk: string, sk: string) => sectors.find((s) => s.zone_key === zk && s.sector_key === sk);
  const ownerLabel = (ownerId: string | null) => {
    if (!ownerId) return null;
    if (ownerId === uid) return { label: "You", mine: true };
    const m = memberById.get(ownerId);
    return { label: m?.commander_name ?? "Enemy", mine: false };
  };
  const unitMoveThisRound = (unitId: string) => myMoves.find((m) => m.unit_id === unitId) ?? null;

  const targetThreat = useMemo(() => {
    if (!toZone || !toSector) return null;
    const s = sectorAt(toZone, toSector);
    const o = ownerLabel(s?.owner_user_id ?? null);
    if (!o || o.mine) return null;
    return { owner: o, fortified: s?.fortified ?? false };
  }, [toZone, toSector, sectors, uid, memberById]); // eslint-disable-line react-hooks/exhaustive-deps

  // Intel shown for currently-targeted sector (only when my unit occupies it)
  const targetIntel = useMemo(() => {
    if (!toZone || !toSector) return null;
    if (!myUnits.some((u) => u.zone_key === toZone && u.sector_key === toSector)) return null;
    return sectorAt(toZone, toSector) ?? null;
  }, [toZone, toSector, myUnits, sectors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Info shown when a player clicks any sector on the overlay (always active).
  // Shows what the current player can see: own sectors show full intel,
  // enemy revealed sectors show owner + fortification, fogged sectors show nothing.
  const clickedSectorInfo = useMemo(() => {
    if (!clickedZone || !clickedSector) return null;
    const s = sectorAt(clickedZone, clickedSector);
    const myUnit = myUnits.find((u) => u.zone_key === clickedZone && u.sector_key === clickedSector);
    const isMine = s?.owner_user_id === uid;
    const isRevealed = s?.revealed_public || isMine || !!myUnit;
    const owner = ownerLabel(s?.owner_user_id ?? null);
    return { s, myUnit, isMine, isRevealed, owner };
  }, [clickedZone, clickedSector, sectors, myUnits, uid, memberById]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ────────────────────────────────────────────────────────────────

  if (!authChecked) {
    return (
      <Frame title="Tactical Hololith" currentPage="map" hideNewCampaign>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-brass/20 border-t-brass rounded-full animate-spin" />
        </div>
      </Frame>
    );
  }

  if (!campaignId) {
    return (
      <Frame title="Tactical Hololith" currentPage="map" hideNewCampaign>
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <p className="text-parchment/50">No campaign selected.</p>
          <a href="/" className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-brass text-sm">Return to Home</a>
        </div>
      </Frame>
    );
  }

  // True when the AI map image + SVG overlay should be used.
  // Controls whether to render a 2-column grid (map right, action cards left) vs stacked layout.
  // Covers all four implemented overlay layouts: ring, spokes, continent, void_ship.
  const isOverlayLayout = !loading &&
    (mapLayout === "ring" || mapLayout === "spokes" || mapLayout === "continent" || mapLayout === "void_ship") &&
    !!mapId && !!mapImageUrl;

  return (
    <Frame title="Tactical Hololith" campaignId={campaignId} role={role} currentPage="map">
      <div className="space-y-4">

        {pageError && (
          <Card title="Error"><p className="text-blood text-sm">{pageError}</p></Card>
        )}
        {loading && (
          <p className="text-parchment/50 animate-pulse text-sm px-1">Loading tactical data…</p>
        )}

        {/* ── Main layout: 2-col for overlay maps, stacked for others ── */}
        {/* Left / full-width col always has action cards.             */}
        {/* Right col has the SVG overlay map for ring/spokes layouts. */}
        <div className={isOverlayLayout
          ? "grid lg:grid-cols-[1fr_minmax(0,520px)] gap-6 items-start"
          : "space-y-4"
        }>

          {/* ── LEFT / single col ──────────────────────────────────────── */}
          <div className="space-y-4">

            {/* Non-overlay layouts: side-by-side Tactical Hololith + AI image */}
            {!isOverlayLayout && !loading && (
              <div className={`grid gap-4 items-start ${mapId ? "lg:grid-cols-2" : "grid-cols-1"}`}>

                {/* LEFT: Tactical Hololith */}
                <Card title={
                    allZones.length > 0 && mapZoneCount
                      ? `Tactical Hololith — ${effectiveZones.length} / ${mapZoneCount} Zones Surveyed`
                      : "Tactical Hololith"
                  }>
                    {/* Colour legend */}
                    <div className="flex flex-wrap gap-x-5 gap-y-1 mb-3 text-xs font-mono">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block w-3 h-3 rounded-sm border" style={{ background: "#5a3d08", borderColor: "#c9a84c" }} />
                        <span className="text-parchment/50">Unit present</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block w-3 h-3 rounded-sm border" style={{ background: "#221800", borderColor: "#7a5f22" }} />
                        <span className="text-parchment/50">Held (empty)</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block w-3 h-3 rounded-sm border" style={{ background: "#3a0a0a", borderColor: "#7a1515" }} />
                        <span className="text-parchment/50">Enemy</span>
                      </span>
                      {canMove && selectedUnit && (
                        <span className="flex items-center gap-1.5">
                          <span className="inline-block w-3 h-3 rounded-sm border" style={{ background: "#1b2b1b", borderColor: "#3a6b3a" }} />
                          <span className="text-green-400/70">Reachable — click to target</span>
                        </span>
                      )}
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block w-3 h-3 rounded-sm border" style={{ background: "#0a0a10", borderColor: "#181826" }} />
                        <span className="text-parchment/30">Fog / unknown</span>
                      </span>
                      <span className="ml-auto text-parchment/25 hidden sm:flex items-center gap-2">
                        <span style={{ color: "#f5c842" }}>●</span>unit
                        <span className="text-blood/50">⬡</span>fort
                      </span>
                    </div>

                    {/* SVG layout */}
                    <TacticalMap
                      zones={allZones}
                      layout={mapLayout}
                      adj={adj}
                      sectors={sectors}
                      uid={uid}
                      memberById={memberById}
                      myUnits={myUnits}
                      selectedUnit={selectedUnit}
                      toZone={toZone}
                      toSector={toSector}
                      fogEnabled={fogEnabled}
                      canMove={canMove}
                      hasDeepStrike={hasDeepStrike}
                      onSelectSector={(zone, sector) => { setToZone(zone); setToSector(sector); }}
                    />

                    {/* Sector intel for the targeted sector (occupation-gated) */}
                    {targetIntel && (
                      <SectorIntelPanel zoneKey={toZone} sectorKey={toSector} sector={targetIntel} />
                    )}

                    {/* Sector intel for all other occupied sectors */}
                    {myUnits
                      .filter((u) => !(u.zone_key === toZone && u.sector_key === toSector))
                      .map((u) => {
                        const s = sectorAt(u.zone_key, u.sector_key);
                        if (!s) return null;
                        return (
                          <SectorIntelPanel
                            key={u.id}
                            zoneKey={u.zone_key}
                            sectorKey={u.sector_key}
                            sector={s}
                          />
                        );
                      })}
                </Card>

                {/* RIGHT: AI Theatre Map (generated image) */}
                {mapId && (
                  <div className="min-w-0">
                    <MapImageDisplay mapId={mapId} campaignId={campaignId} isLead={role === "lead" || role === "admin"} />
                  </div>
                )}

              </div>
            )}

            {/* ── My Units ── */}
            {myUnits.length > 0 && (
              <Card title="My Units">
                <div className="space-y-2">
                  {myUnits.map((u) => {
                    const pending = unitMoveThisRound(u.id);
                    return (
                      <div key={u.id}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded border transition-colors ${
                          selectedUnit?.id === u.id
                            ? "bg-brass/15 border-brass/50"
                            : "bg-void border-parchment/15 hover:border-brass/30"
                        }`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-xs px-2 py-0.5 rounded border font-mono uppercase ${
                              u.unit_type === "scout"
                                ? "bg-blue-500/15 border-blue-400/40 text-blue-300"
                                : "bg-brass/15 border-brass/40 text-brass"
                            }`}>{u.unit_type}</span>
                            <span className="text-parchment/70 text-sm">{fmtKey(u.zone_key)} / {u.sector_key.toUpperCase()}</span>
                            <span className="text-parchment/30 text-xs font-mono">R{u.round_deployed}</span>
                          </div>
                          {pending && (
                            <p className="text-xs text-brass/70 mt-0.5 font-mono">
                              → {fmtKey(pending.to_zone_key)} / {pending.to_sector_key.toUpperCase()} ({pending.move_type})
                            </p>
                          )}
                        </div>
                        {canMove && !pending && (
                          <button
                            onClick={() => { setSelectedUnit(u); setToZone(u.zone_key); setToSector(u.sector_key); setMoveResult(null); }}
                            className="shrink-0 px-3 py-1 rounded text-xs border border-brass/40 hover:bg-brass/20 text-parchment/60 hover:text-parchment/90 transition-colors">
                            Select
                          </button>
                        )}
                        {canMove && pending && (
                          <button
                            onClick={() => { setSelectedUnit(u); setToZone(pending.to_zone_key); setToSector(pending.to_sector_key); setMoveResult(null); }}
                            className="shrink-0 px-3 py-1 rounded text-xs border border-parchment/20 hover:bg-parchment/10 text-parchment/40 transition-colors">
                            Edit
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Token row */}
                <div className="mt-3 pt-3 border-t border-parchment/10 flex gap-3 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded border font-mono ${hasDeepStrike ? "bg-brass/20 border-brass/50 text-brass" : "bg-void border-parchment/10 text-parchment/25"}`}>
                    {hasDeepStrike ? "✓ Deep Strike" : "No Deep Strike"}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded border font-mono ${hasRecon ? "bg-blue-500/15 border-blue-400/40 text-blue-300" : "bg-void border-parchment/10 text-parchment/25"}`}>
                    {hasRecon ? "✓ Recon Token" : "No Recon Token"}
                  </span>
                  {!fogEnabled && (
                    <span className="text-xs px-2 py-0.5 rounded border font-mono bg-parchment/10 border-parchment/30 text-parchment/50">Fog Off</span>
                  )}
                  <span className="text-xs px-2 py-0.5 rounded border border-parchment/10 text-parchment/35 font-mono ml-auto">{myNip} NIP</span>
                </div>
              </Card>
            )}

            {/* ── Movement Order ── */}
            {selectedUnit && canMove && (
              <Card title={`Movement Order — ${fmtKey(selectedUnit.unit_type)} Unit`}>
                <div className="space-y-4">
                  <div className="text-sm text-parchment/60">
                    <span>Moving from: <span className="text-parchment/85">{fmtKey(selectedUnit.zone_key)} / {selectedUnit.sector_key.toUpperCase()}</span></span>
                    {toZone && toSector
                      ? <span className="ml-3 text-brass/80">→ <span className="font-semibold">{fmtKey(toZone)} / {toSector.toUpperCase()}</span></span>
                      : <span className="block mt-1 text-parchment/35 text-xs">Click a highlighted sector on the map to set your destination.</span>
                    }
                    {hasDeepStrike && <span className="ml-2 text-brass text-xs font-mono">Deep Strike — any zone valid</span>}
                  </div>

                  {targetThreat && (
                    <div className="px-3 py-2 rounded border border-blood/30 bg-blood/10 text-sm text-blood/80">
                      ⚠️ <span className="font-semibold">{targetThreat.owner.label}</span> controls this sector.
                      {targetThreat.fortified && " Fortified."}
                      {selectedUnit.unit_type === "occupation"
                        ? " Triggers a conflict if defended, or captures if undefended."
                        : " Scouting gathers intel and may trigger a conflict."}
                    </div>
                  )}

                  {moveResult && (
                    <p className={`text-sm px-3 py-2 rounded border ${
                      moveResult.startsWith("Error") ? "border-blood/30 bg-blood/10 text-blood/80" : "border-brass/30 bg-brass/10 text-brass/80"
                    }`}>{moveResult}</p>
                  )}

                  <div className="flex gap-3">
                    <button
                      onClick={submitMove}
                      disabled={submitting || !toZone || !toSector}
                      className="flex-1 px-4 py-2.5 rounded bg-brass/25 border border-brass/50 hover:bg-brass/40 disabled:opacity-40 text-brass font-bold text-sm uppercase tracking-wider transition-colors">
                      {submitting ? "Submitting…" : "Confirm Order"}
                    </button>
                    <button
                      onClick={() => { setSelectedUnit(null); setToZone(""); setToSector(""); setMoveResult(null); }}
                      className="px-4 py-2.5 rounded bg-void border border-parchment/20 hover:border-parchment/40 text-parchment/50 text-sm transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              </Card>
            )}

            {/* ── No movement phase message ── */}
            {myUnits.length > 0 && !canMove && stage && (
              <Card title="Movement Orders">
                <p className="text-parchment/40 text-sm italic">
                  {stage === "spend"
                    ? "Movement orders open in the movement phase. Use this phase to purchase Deep Strike or Recon tokens."
                    : stage === "recon" && !hasRecon
                    ? "You need a Recon token to move during this phase. Purchase one during the next spend phase."
                    : `Movement is not available during the ${stage} phase.`}
                </p>
              </Card>
            )}

            {/* ── Deploy New Unit ── */}
            {inSpendPhase && mySectors.length > 0 && (
              <Card title="Deploy New Unit">
                <div className="space-y-4">
                  <p className="text-parchment/60 text-sm">
                    Deploy a new unit to one of your held sectors. Deducted from your NIP balance ({myNip} available).
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-parchment/40 uppercase tracking-widest block mb-1.5">Unit Type</label>
                      <div className="flex gap-2">
                        {(["scout", "occupation"] as const).map((ut) => (
                          <button key={ut} onClick={() => setDeployType(ut)}
                            className={`flex-1 px-3 py-2 rounded border text-sm font-semibold transition-colors ${
                              deployType === ut ? "bg-brass/20 border-brass/50 text-brass" : "bg-void border-parchment/20 text-parchment/50 hover:border-brass/30"
                            }`}>
                            {fmtKey(ut)}
                            <span className="block text-xs font-mono mt-0.5 opacity-70">{UNIT_NIP_COST[ut]} NIP</span>
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-parchment/35 mt-1.5">
                        {deployType === "scout"
                          ? "Explores territory, gains intel. Can move in recon phase."
                          : "Holds territory. Required to defend sectors you own."}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <label className="text-xs text-parchment/40 uppercase tracking-widest block mb-1.5">Zone</label>
                        <select className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm text-parchment/85"
                          value={deployZone} onChange={(e) => { setDeployZone(e.target.value); setDeploySector(""); }}>
                          <option value="">-- select --</option>
                          {Array.from(new Set(mySectors.map((s) => s.zone_key))).map((zk) => (
                            <option key={zk} value={zk}>{fmtKey(zk)}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-parchment/40 uppercase tracking-widest block mb-1.5">Sector</label>
                        <select className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm text-parchment/85"
                          value={deploySector} disabled={!deployZone} onChange={(e) => setDeploySector(e.target.value)}>
                          <option value="">-- select --</option>
                          {mySectors.filter((s) => s.zone_key === deployZone).map((s) => (
                            <option key={s.sector_key} value={s.sector_key}>{s.sector_key.toUpperCase()}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                  {deployResult && (
                    <p className={`text-sm px-3 py-2 rounded border ${
                      deployResult.startsWith("Error") ? "border-blood/30 bg-blood/10 text-blood/80" : "border-brass/30 bg-brass/10 text-brass/80"
                    }`}>{deployResult}</p>
                  )}
                  <button onClick={deployUnit}
                    disabled={deploying || !deployZone || !deploySector || (myNip < UNIT_NIP_COST[deployType]!)}
                    className="w-full px-4 py-2.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/35 disabled:opacity-40 text-parchment/80 font-semibold text-sm transition-colors">
                    {deploying ? "Deploying…" : `Deploy ${fmtKey(deployType)} — ${UNIT_NIP_COST[deployType]} NIP`}
                  </button>
                  {myNip < UNIT_NIP_COST[deployType]! && (
                    <p className="text-blood/60 text-xs">Insufficient NIP ({myNip} available, need {UNIT_NIP_COST[deployType]}).</p>
                  )}
                </div>
              </Card>
            )}

            {/* ── Pending Orders ── */}
            {myMoves.length > 0 && (
              <Card title={`Round ${roundNumber} Orders`}>
                <div className="space-y-1.5">
                  {myMoves.map((m) => {
                    const unit = myUnits.find((u) => u.id === m.unit_id);
                    return (
                      <div key={m.id} className="flex items-center gap-3 text-sm px-2 py-1.5 rounded bg-parchment/5 border border-parchment/10">
                        {unit && (
                          <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${
                            unit.unit_type === "scout" ? "bg-blue-500/15 border-blue-400/30 text-blue-300" : "bg-brass/15 border-brass/30 text-brass"
                          }`}>{unit.unit_type}</span>
                        )}
                        <span className="text-parchment/50 text-xs font-mono">{fmtKey(m.from_zone_key)}/{m.from_sector_key.toUpperCase()}</span>
                        <span className="text-parchment/25">→</span>
                        <span className="text-parchment/75 text-xs font-mono">{fmtKey(m.to_zone_key)}/{m.to_sector_key.toUpperCase()}</span>
                        <span className={`ml-auto text-xs font-mono px-1.5 py-0.5 rounded border ${
                          m.move_type === "deep_strike" ? "border-brass/40 text-brass/70"
                          : m.move_type === "recon"     ? "border-blue-400/30 text-blue-300/70"
                          :                               "border-parchment/15 text-parchment/30"
                        }`}>{m.move_type}</span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

          </div>{/* end LEFT col */}

          {/* ── RIGHT col: overlay map thumbnail + expand to popup ──── */}
          {isOverlayLayout && (
            <div className="space-y-3 lg:sticky lg:top-4">

              {/* Thumbnail inside a Card — clicking opens the calibration popup */}
              <Card title="Theatre Map">
                <div className="relative cursor-pointer rounded-lg overflow-hidden -mx-1"
                  onClick={() => setMapPopupOpen(true)}
                  title={role === "lead" && !calibrationLocked ? "Expand / Calibrate" : "Expand map"}
                >
                  <CampaignMapOverlay
                    mapUrl={mapImageUrl!}
                    layout={mapLayout as any}
                    zoneCount={mapZoneCount ?? effectiveZones.length}
                    zoneKeys={zoneKeys}
                    zoneNames={zoneNames}
                    sectors={sectors as any}
                    units={roundNumber > 0 ? (myUnits as any) : []}
                    currentUserId={uid || null}
                    selectedSectorId={selectedSectorId}
                    onSectorClick={(zone, sector) => {
                      setClickedZone(zone);
                      setClickedSector(sector);
                      if (canMove && selectedUnit) {
                        setToZone(zone);
                        setToSector(sector);
                      }
                    }}
                    showZoneLabels
                    isLead={role === "lead"}
                    campaignId={campaignId}
                    calibrationLocked={true}
                  />
                </div>
              </Card>

              {/* Sector intel panels — shown below thumbnail */}
              {targetIntel && (
                <SectorIntelPanel zoneKey={toZone} sectorKey={toSector} sector={targetIntel} />
              )}
              {myUnits
                .filter((u) => !(u.zone_key === toZone && u.sector_key === toSector))
                .map((u) => {
                  const s = sectorAt(u.zone_key, u.sector_key);
                  if (!s) return null;
                  return (
                    <SectorIntelPanel
                      key={u.id}
                      zoneKey={u.zone_key}
                      sectorKey={u.sector_key}
                      sector={s}
                    />
                  );
                })}

              {/* ── Sector click info panel ── */}
              {clickedSectorInfo && (
                <div className="rounded border border-brass/20 bg-void/80 p-4 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <p className="text-brass/60 text-xs uppercase tracking-widest font-mono">
                      ◈ {fmtKey(clickedZone)} / {clickedSector.toUpperCase()}
                    </p>
                    <button
                      onClick={() => { setClickedZone(""); setClickedSector(""); }}
                      className="text-parchment/25 hover:text-parchment/60 text-xs px-1 transition-colors">
                      ✕
                    </button>
                  </div>

                  {!clickedSectorInfo.isRevealed ? (
                    <p className="text-parchment/30 italic text-xs">
                      Unknown. Deploy a scout to gather intel on this sector.
                    </p>
                  ) : (
                    <>
                      {clickedSectorInfo.owner ? (
                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded border ${
                          clickedSectorInfo.isMine
                            ? "border-brass/30 bg-brass/10 text-brass/80"
                            : "border-blood/30 bg-blood/10 text-blood/80"
                        }`}>
                          <span className="font-semibold">
                            {clickedSectorInfo.isMine ? "Held by you" : `Held by ${clickedSectorInfo.owner.label}`}
                          </span>
                          {clickedSectorInfo.s?.fortified && (
                            <span className="ml-auto text-xs border border-blood/30 px-1.5 py-0.5 rounded font-mono">⬡ Fortified</span>
                          )}
                        </div>
                      ) : (
                        <p className="text-parchment/45 text-xs italic px-1">Uncontrolled sector.</p>
                      )}
                      {clickedSectorInfo.myUnit && (
                        <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded border ${
                          clickedSectorInfo.myUnit.unit_type === "scout"
                            ? "border-blue-400/30 bg-blue-500/10 text-blue-300"
                            : "border-brass/30 bg-brass/10 text-brass/80"
                        }`}>
                          <span className="uppercase font-mono">{clickedSectorInfo.myUnit.unit_type}</span>
                          <span className="text-parchment/40">unit present</span>
                          <span className="ml-auto font-mono text-parchment/30">R{clickedSectorInfo.myUnit.round_deployed}</span>
                        </div>
                      )}
                      {clickedSectorInfo.myUnit && clickedSectorInfo.s && (
                        <SectorIntelPanel
                          zoneKey={clickedZone}
                          sectorKey={clickedSector}
                          sector={clickedSectorInfo.s}
                        />
                      )}
                      {canMove && selectedUnit && (
                        <p className="text-green-400/60 text-xs italic px-1">
                          Click selects this sector as movement target.
                        </p>
                      )}
                      {canMove && !selectedUnit && (
                        <p className="text-parchment/30 text-xs italic px-1">
                          Select a unit in My Units to issue a movement order.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

        </div>{/* end main layout grid */}

      </div>

      {/* ── Fullscreen map calibration popup ──────────────────────────────── */}
      {/* Opens when the lead clicks the map thumbnail in the right column.    */}
      {/* Map left, calibration sliders right. Click backdrop or ✕ to close.  */}
      {mapPopupOpen && isOverlayLayout && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setMapPopupOpen(false); }}
        >
          {/* Use site-native card styling: iron background, brass borders, parchment text */}
          <div className="relative w-full max-w-[1400px] max-h-[94vh] flex flex-col bg-iron/95 backdrop-blur-[14px] border border-brass/30 rounded-2xl overflow-hidden shadow-reliquary">

            {/* Header bar — matches Card.tsx style */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-brass/20 shrink-0">
              <h2 className="font-gothic tracking-wide text-parchment">
                ◈ Theatre Map — {mapLayout.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
              </h2>
              <button
                onClick={() => setMapPopupOpen(false)}
                className="text-parchment/40 hover:text-parchment transition-colors text-lg px-2 py-0.5 rounded hover:bg-brass/10 border border-transparent hover:border-brass/30"
                aria-label="Close map popup"
              >
                ✕
              </button>
            </div>

            {/* Body — map left, sliders right. overflow-hidden keeps scrollbar away */}
            <div className="flex-1 overflow-hidden p-4">
              <CampaignMapOverlay
                mapUrl={mapImageUrl!}
                layout={mapLayout as any}
                zoneCount={mapZoneCount ?? effectiveZones.length}
                zoneKeys={zoneKeys}
                zoneNames={zoneNames}
                sectors={sectors as any}
                units={roundNumber > 0 ? (myUnits as any) : []}
                currentUserId={uid || null}
                selectedSectorId={selectedSectorId}
                onSectorClick={(zone, sector) => {
                  setClickedZone(zone);
                  setClickedSector(sector);
                  if (canMove && selectedUnit) {
                    setToZone(zone);
                    setToSector(sector);
                  }
                }}
                showZoneLabels
                isLead={role === "lead"}
                campaignId={campaignId}
                calibrationLocked={calibrationLocked}
                popupMode
                popupSidePanel={
                  <SectorInfoPopupPanel
                    zoneKey={clickedZone}
                    sectorKey={clickedSector}
                    sectors={sectors}
                    zones={effectiveZones}
                    myUnits={myUnits}
                    memberById={memberById}
                    uid={uid}
                  />
                }
              />
            </div>

          </div>
        </div>
      )}

    </Frame>
  );
}
