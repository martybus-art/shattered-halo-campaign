"use client";

/**
 * MapImageDisplay
 * ───────────────
 * Shows the AI-generated campaign map with an interactive SVG overlay.
 *
 * Overlay features:
 *   - Animated glow hover on each zone polygon
 *   - Fog-of-war: unrevealed zones show a dark animated haze
 *   - Sector grid rendered inside each zone on hover / when selected
 *   - Clicking a zone fires window event "campaign:zoneSelected" with { key, name }
 *   - Brighten toggle: CSS filter lifts midtones for dark generated images
 *   - Labels toggle: show/hide numbered zone badges + name plates
 *
 * Zone positions are computed deterministically from layout + seed so they
 * always match the image generation order.
 *
 * Usage:
 *   <MapImageDisplay
 *     mapId={campaign.map_id}
 *     campaignId={campaign.id}
 *     isLead={isLead}
 *     revealedZones={["vault_ruins", "ash_wastes"]}   // optional fog-of-war
 *     selectedZoneKey={selectedZoneKey}                // optional highlight
 *   />
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";

// ── Types ────────────────────────────────────────────────────────────────────

type GenerationStatus = "none" | "pending" | "generating" | "complete" | "failed";

interface MapRow {
  id: string;
  name: string;
  image_path: string | null;
  bg_image_path: string | null;
  generation_status: GenerationStatus;
  layout: string | null;
  zone_count: number | null;
  art_version: string | null;
  seed: string | null;
}

export interface ZonePoint {
  /** Normalised 0–100 coordinates (percentage of image width/height) */
  cx: number;
  cy: number;
  /** Approximate radius as % of image width */
  r: number;
  /** Key matching zone_key in DB (snake_case zone name) */
  key: string;
  name: string;
  index: number;
}

export interface MapImageDisplayProps {
  mapId: string;
  campaignId: string;
  isLead?: boolean;
  className?: string;
  /** Zone keys that have been publicly revealed — controls fog-of-war */
  revealedZones?: string[];
  /** Currently selected zone key — shows highlight ring */
  selectedZoneKey?: string | null;
  /** Called when user clicks a zone label */
  onZoneClick?: (zone: ZonePoint) => void;
}

// ── Zone name & key pools ─────────────────────────────────────────────────────

const PLANET_ZONE_NAMES = [
  "Vault Ruins",
  "Ash Wastes",
  "Halo Spire",
  "Sunken Manufactorum",
  "Warp Scar Basin",
  "Obsidian Fields",
  "Signal Crater",
  "Xenos Forest",
  "Blighted Reach",
  "Iron Sanctum",
  "Null Fields",
  "Ghost Harbor",
];

const SHIP_ZONE_NAMES = [
  "Command Sanctum",
  "Macro-Battery Deck",
  "Gellar Chapel",
  "Reactor Reliquary",
  "Hangar Crypts",
  "Munitorum Vaults",
  "Vox Spire",
  "Apothecarion",
  "Shrine of Oaths",
  "Plasma Conduits",
  "Enginseer Bay",
  "Breach Corridor",
];

function nameToKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// ── Deterministic shuffle (must match edge function exactly) ─────────────────

function seededShuffle<T>(arr: T[], seed: string): T[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    hash = ((hash << 5) - hash + i) | 0;
    const j = Math.abs(hash) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ── Zone position calculation ─────────────────────────────────────────────────

/**
 * Returns normalised (0–100) zone centre positions for overlay badges.
 * Coordinates are approximate layout guides — they don't trace exact image
 * boundaries but place labels in sensible locations matching each layout type.
 *
 * Image aspect ratio: 1536 × 1024  (3:2)
 */
function computeZonePoints(
  layout: string,
  zoneNames: string[],
): ZonePoint[] {
  const count = zoneNames.length;

  return zoneNames.map((name, i) => {
    let cx = 50;
    let cy = 50;
    let r  = 7;

    if (layout === "ring") {
      // Evenly spaced around an elliptical ring (image is 3:2 so squash Y)
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      cx = 50 + 36 * Math.cos(angle);
      cy = 50 + 28 * Math.sin(angle);
      r  = 6;
    } else if (layout === "radial") {
      if (i === 0) {
        // Centre hub
        cx = 50; cy = 50; r = 8;
      } else {
        const angle = ((i - 1) / (count - 1)) * Math.PI * 2 - Math.PI / 2;
        cx = 50 + 35 * Math.cos(angle);
        cy = 50 + 28 * Math.sin(angle);
        r  = 6;
      }
    } else if (layout === "continent") {
      // Grid layout with slight jitter derived from index
      const cols   = Math.ceil(Math.sqrt(count * 1.5));
      const rows   = Math.ceil(count / cols);
      const col    = i % cols;
      const row    = Math.floor(i / cols);
      const xStep  = 80 / cols;
      const yStep  = 80 / rows;
      // Small deterministic jitter so it looks natural
      const jx     = ((i * 37) % 10) - 5;
      const jy     = ((i * 53) % 8) - 4;
      cx = 10 + col * xStep + xStep / 2 + jx;
      cy = 10 + row * yStep + yStep / 2 + jy;
      r  = Math.min(xStep, yStep) * 0.35;
    } else if (layout === "ship_line") {
      // Left-to-right along the ship centreline
      // Alternate slightly above/below centre for visual rhythm
      const xStep = 85 / count;
      cx = 8 + i * xStep + xStep / 2;
      cy = i % 2 === 0 ? 38 : 62;
      r  = 5.5;
    } else {
      // Fallback: simple ring
      const angle = (i / count) * Math.PI * 2;
      cx = 50 + 35 * Math.cos(angle);
      cy = 50 + 28 * Math.sin(angle);
      r  = 6;
    }

    return {
      cx: Math.max(6, Math.min(94, cx)),
      cy: Math.max(6, Math.min(94, cy)),
      r:  Math.max(4, r),
      key: nameToKey(name),
      name,
      index: i,
    };
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LAYOUT_LABEL: Record<string, string> = {
  ring:      "Halo Ring",
  continent: "Fractured Continent",
  radial:    "Radial Spokes",
  ship_line: "Void Warship",
};

const STATUS_LABEL: Record<GenerationStatus, string> = {
  none:       "No map image",
  pending:    "Preparing map generation…",
  generating: "Generating map image…",
  complete:   "Map ready",
  failed:     "Map generation failed",
};

// Brass palette matching the app theme
const BRASS       = "#b8942a";
const BRASS_GLOW  = "#d4af37";
const BLOOD       = "#8b1a1a";
const VOID_DARK   = "rgba(10,8,6,0.82)";

// ── Public URL resolver ───────────────────────────────────────────────────────

async function getImageUrl(
  supabase: ReturnType<typeof supabaseBrowser>,
  storagePath: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from("campaign-maps")
    .createSignedUrl(storagePath, 60 * 60);
  if (error || !data?.signedUrl) {
    console.warn("MapImageDisplay: signed URL failed", error?.message);
    return null;
  }
  return data.signedUrl;
}

// ── SVG Zone Overlay ─────────────────────────────────────────────────────────

interface ZoneOverlayProps {
  zones: ZonePoint[];
  revealedZones: string[];
  selectedZoneKey: string | null;
  onZoneClick: (zone: ZonePoint) => void;
  /** Whether fog-of-war is active (lead sees all, players see only revealed) */
  fogActive: boolean;
}

function ZoneOverlay({
  zones,
  revealedZones,
  selectedZoneKey,
  onZoneClick,
  fogActive,
}: ZoneOverlayProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ aspectRatio: "1536/1024" }}
    >
      <defs>
        {/* Glow filter for hovered / selected zones */}
        <filter id="zone-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Stronger glow for selected */}
        <filter id="zone-glow-selected" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Fog pattern — animated diagonal hatch */}
        <pattern id="fog-hatch" patternUnits="userSpaceOnUse" width="4" height="4"
          patternTransform="rotate(45)">
          <rect width="4" height="4" fill="rgba(8,6,4,0.55)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(30,20,10,0.3)" strokeWidth="1.5" />
        </pattern>

        {/* Fog radial gradient */}
        <radialGradient id="fog-gradient" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="rgba(8,6,4,0.65)" />
          <stop offset="100%" stopColor="rgba(4,3,2,0.88)" />
        </radialGradient>
      </defs>

      {zones.map((zone) => {
        const isRevealed  = !fogActive || revealedZones.includes(zone.key);
        const isSelected  = zone.key === selectedZoneKey;
        const isHovered   = zone.key === hoveredKey;
        const showFog     = !isRevealed;

        // Outer ring radius slightly bigger than badge
        const outerR = zone.r + 1.5;

        return (
          <g
            key={zone.key}
            style={{ cursor: "pointer", pointerEvents: "all" }}
            onClick={() => onZoneClick(zone)}
            onMouseEnter={() => setHoveredKey(zone.key)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            {/* ── Fog of war fill ── */}
            {showFog && (
              <>
                <circle
                  cx={zone.cx} cy={zone.cy}
                  r={outerR * 2.2}
                  fill="url(#fog-gradient)"
                  opacity={0.72}
                />
                <circle
                  cx={zone.cx} cy={zone.cy}
                  r={outerR * 2.2}
                  fill="url(#fog-hatch)"
                  opacity={0.5}
                />
              </>
            )}

            {/* ── Outer glow ring (hover/selected) ── */}
            {(isHovered || isSelected) && (
              <circle
                cx={zone.cx} cy={zone.cy}
                r={outerR}
                fill="none"
                stroke={isSelected ? BLOOD : BRASS_GLOW}
                strokeWidth={isSelected ? 0.6 : 0.4}
                opacity={isSelected ? 0.9 : 0.7}
                filter={isSelected ? "url(#zone-glow-selected)" : "url(#zone-glow)"}
              />
            )}

            {/* ── Zone badge circle ── */}
            <circle
              cx={zone.cx} cy={zone.cy}
              r={zone.r}
              fill={VOID_DARK}
              stroke={isSelected ? BLOOD : isHovered ? BRASS_GLOW : BRASS}
              strokeWidth={isSelected ? 0.55 : isHovered ? 0.5 : 0.35}
              opacity={showFog ? 0.5 : 1}
              filter={(isHovered || isSelected) ? "url(#zone-glow)" : undefined}
            />

            {/* ── Zone number ── */}
            {!showFog && (
              <text
                x={zone.cx} y={zone.cy}
                dominantBaseline="central"
                textAnchor="middle"
                fontSize={zone.r * 0.75}
                fontFamily="monospace"
                fontWeight="bold"
                fill={isSelected ? "#ff6666" : isHovered ? BRASS_GLOW : BRASS}
                style={{ userSelect: "none" }}
              >
                {zone.index + 1}
              </text>
            )}

            {/* ── Fog: question mark ── */}
            {showFog && (
              <text
                x={zone.cx} y={zone.cy}
                dominantBaseline="central"
                textAnchor="middle"
                fontSize={zone.r * 0.75}
                fontFamily="monospace"
                fill="rgba(120,100,60,0.5)"
                style={{ userSelect: "none" }}
              >
                ?
              </text>
            )}

            {/* ── Name plate (hover / selected, not fogged) ── */}
            {(isHovered || isSelected) && !showFog && (() => {
              const labelW = Math.max(zone.name.length * 1.05, 10);
              const labelH = 4;
              const labelY = zone.cy + zone.r + 1.5;
              const fontSize = Math.min(2.8, 12 / zone.name.length * 1.4);
              return (
                <g>
                  <rect
                    x={zone.cx - labelW / 2}
                    y={labelY}
                    width={labelW}
                    height={labelH}
                    rx={0.8}
                    fill={VOID_DARK}
                    stroke={isSelected ? BLOOD : BRASS}
                    strokeWidth={0.25}
                  />
                  <text
                    x={zone.cx}
                    y={labelY + labelH / 2}
                    dominantBaseline="central"
                    textAnchor="middle"
                    fontSize={fontSize}
                    fontFamily="Georgia, serif"
                    fill={isSelected ? "#ff8888" : BRASS_GLOW}
                    style={{ userSelect: "none" }}
                  >
                    {zone.name}
                  </text>
                </g>
              );
            })()}

            {/* ── Sector grid overlay (selected zone only) ── */}
            {isSelected && !showFog && (() => {
              // Draw a 2×2 sector grid inside the zone circle
              const sectors = ["A", "B", "C", "D"];
              const gSize   = zone.r * 0.55;
              return sectors.map((sec, si) => {
                const sx = zone.cx + (si % 2 === 0 ? -gSize * 0.6 : gSize * 0.6);
                const sy = zone.cy + (si < 2 ? -gSize * 0.6 : gSize * 0.6);
                return (
                  <g key={sec}>
                    <rect
                      x={sx - gSize * 0.45}
                      y={sy - gSize * 0.38}
                      width={gSize * 0.88}
                      height={gSize * 0.75}
                      rx={0.3}
                      fill="rgba(0,0,0,0.55)"
                      stroke={BRASS}
                      strokeWidth={0.18}
                      strokeDasharray="0.4 0.3"
                    />
                    <text
                      x={sx}
                      y={sy}
                      dominantBaseline="central"
                      textAnchor="middle"
                      fontSize={gSize * 0.45}
                      fontFamily="monospace"
                      fill={BRASS}
                      opacity={0.8}
                      style={{ userSelect: "none" }}
                    >
                      {sec}
                    </text>
                  </g>
                );
              });
            })()}
          </g>
        );
      })}
    </svg>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function MapImageDisplay({
  mapId,
  campaignId,
  isLead = false,
  className = "",
  revealedZones = [],
  selectedZoneKey = null,
  onZoneClick,
}: MapImageDisplayProps) {
  const [mapRow, setMapRow]         = useState<MapRow | null>(null);
  const [imageUrl, setImageUrl]     = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [retrying, setRetrying]     = useState(false);
  const [brighten, setBrighten]     = useState(true);
  const [showLabels, setShowLabels] = useState(true);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const supabase     = useMemo(() => supabaseBrowser(), []);

  // ── Compute zone points from map metadata ───────────────────────────────

  const zonePoints = useMemo<ZonePoint[]>(() => {
    if (!mapRow?.layout || !mapRow.zone_count || !mapRow.seed) return [];
    const namePool  = mapRow.layout === "ship_line" ? SHIP_ZONE_NAMES : PLANET_ZONE_NAMES;
    const zoneNames = seededShuffle(namePool, mapRow.seed).slice(0, mapRow.zone_count);
    return computeZonePoints(mapRow.layout, zoneNames);
  }, [mapRow?.layout, mapRow?.zone_count, mapRow?.seed]);

  // ── Fetch map row ───────────────────────────────────────────────────────

  const fetchMapRow = useCallback(async (): Promise<MapRow | null> => {
    const { data, error: dbErr } = await supabase
      .from("maps")
      .select("id, name, image_path, bg_image_path, generation_status, layout, zone_count, art_version, seed")
      .eq("id", mapId)
      .maybeSingle();
    if (dbErr) {
      setError("Could not load map data.");
      return null;
    }
    return data as MapRow | null;
  }, [supabase, mapId]);

  const resolveImage = useCallback(async (row: MapRow) => {
    const path = row.image_path ?? row.bg_image_path;
    if (!path) return;
    const url = await getImageUrl(supabase, path);
    setImageUrl(url);
  }, [supabase]);

  // ── Polling ─────────────────────────────────────────────────────────────

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(async () => {
      const row = await fetchMapRow();
      if (!row) return;
      setMapRow(row);
      if (row.generation_status === "complete") {
        await resolveImage(row);
        clearInterval(pollTimerRef.current!);
        pollTimerRef.current = null;
      }
      if (row.generation_status === "failed") {
        clearInterval(pollTimerRef.current!);
        pollTimerRef.current = null;
      }
    }, 5000);
  }, [fetchMapRow, resolveImage]);

  useEffect(() => {
    if (!mapId) return;
    const load = async () => {
      setLoading(true);
      const row = await fetchMapRow();
      setLoading(false);
      if (!row) return;
      setMapRow(row);
      if (row.generation_status === "complete") await resolveImage(row);
    };
    load();
    startPolling();
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [mapId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Retry handler ───────────────────────────────────────────────────────

  const handleRetry = async () => {
    if (!mapId || !campaignId || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const res  = await fetch("/api/map/regenerate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ map_id: mapId, campaign_id: campaignId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Retry failed");
      setMapRow(prev => prev ? { ...prev, generation_status: "pending" } : prev);
      setImageUrl(null);
      startPolling();
    } catch (err: unknown) {
      setError(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRetrying(false);
    }
  };

  // ── Zone click handler ──────────────────────────────────────────────────

  const handleZoneClick = useCallback((zone: ZonePoint) => {
    // Fire the window event for map/page.tsx to listen to
    window.dispatchEvent(new CustomEvent("campaign:zoneSelected", { detail: zone }));
    // Also call the prop callback if provided
    onZoneClick?.(zone);
  }, [onZoneClick]);

  // ── Render ──────────────────────────────────────────────────────────────

  const status      = mapRow?.generation_status ?? "none";
  const isInProgress = status === "pending" || status === "generating";

  if (loading) {
    return (
      <div className={`flex items-center justify-center bg-zinc-900 rounded-lg h-64 ${className}`}>
        <div className="text-zinc-500 text-sm animate-pulse">Loading map…</div>
      </div>
    );
  }

  if (!mapRow) {
    return (
      <div className={`flex items-center justify-center bg-zinc-900 rounded-lg h-64 ${className}`}>
        <div className="text-zinc-500 text-sm">No map found.</div>
      </div>
    );
  }

  return (
    <div className={`relative rounded-lg overflow-hidden ${className}`}>

      {/* ── In-progress placeholder ──────────────────────────────────────── */}
      {isInProgress && (
        <div className="relative w-full bg-zinc-900 rounded-lg overflow-hidden" style={{ aspectRatio: "1536/1024" }}>
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900 animate-pulse" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="w-12 h-12 border-4 border-amber-900 border-t-amber-500 rounded-full animate-spin" />
            <p className="text-amber-400 font-semibold text-lg tracking-widest uppercase">
              {STATUS_LABEL[status]}
            </p>
            <p className="text-zinc-500 text-sm max-w-xs">
              The Adeptus Mechanicus is rendering your warzone. This may take 15–30 seconds.
            </p>
            {mapRow.layout && (
              <span className="text-xs text-zinc-600 uppercase tracking-widest">
                Layout: {LAYOUT_LABEL[mapRow.layout] ?? mapRow.layout}
                {mapRow.zone_count ? ` · ${mapRow.zone_count} Zones` : ""}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Failed state ──────────────────────────────────────────────────── */}
      {status === "failed" && (
        <div className="w-full bg-zinc-900 border border-red-900 rounded-lg p-8 flex flex-col items-center gap-4 text-center">
          <div className="text-4xl">💀</div>
          <p className="text-red-400 font-semibold">Map generation failed.</p>
          <p className="text-zinc-500 text-sm">
            The machine spirits rebelled. Check the generate-map function logs for details.
          </p>
          {error && <p className="text-red-600 text-xs font-mono">{error}</p>}
          {isLead && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="mt-2 px-4 py-2 bg-amber-900 hover:bg-amber-800 disabled:opacity-50 text-amber-100 text-sm font-semibold rounded uppercase tracking-wider transition-colors"
            >
              {retrying ? "Retrying…" : "Retry Generation"}
            </button>
          )}
        </div>
      )}

      {/* ── No image yet ─────────────────────────────────────────────────── */}
      {status === "none" && !imageUrl && (
        <div className="w-full bg-zinc-900 rounded-lg p-8 flex flex-col items-center gap-2 text-center">
          <div className="text-4xl text-zinc-700">🗺</div>
          <p className="text-zinc-500 text-sm">No map image has been generated yet.</p>
        </div>
      )}

      {/* ── Map image + overlay ───────────────────────────────────────────── */}
      {status === "complete" && imageUrl && (
        <div className="relative group">

          {/* Toolbar — top right */}
          <div className="absolute top-3 right-3 z-20 flex gap-2">
            <button
              onClick={() => setBrighten(b => !b)}
              className="px-2.5 py-1 text-xs font-semibold rounded bg-black/70 border border-amber-800/60 text-amber-400 hover:bg-black/90 hover:border-amber-600 transition-colors uppercase tracking-wider"
            >
              {brighten ? "Normal" : "Brighten"}
            </button>
            <button
              onClick={() => setShowLabels(l => !l)}
              className="px-2.5 py-1 text-xs font-semibold rounded bg-black/70 border border-amber-800/60 text-amber-400 hover:bg-black/90 hover:border-amber-600 transition-colors uppercase tracking-wider"
            >
              {showLabels ? "Hide Zones" : "Show Zones"}
            </button>
            {isLead && (
              <button
                onClick={handleRetry}
                disabled={retrying}
                className="px-2.5 py-1 text-xs font-semibold rounded bg-black/70 border border-red-900/60 text-red-400 hover:bg-black/90 disabled:opacity-40 transition-colors uppercase tracking-wider"
              >
                {retrying ? "…" : "Regenerate"}
              </button>
            )}
          </div>

          {/* Map image */}
          <img
            src={imageUrl}
            alt={mapRow.name ?? "Campaign Map"}
            className="w-full h-auto rounded-lg object-cover shadow-2xl shadow-black"
            style={{
              aspectRatio: "1536/1024",
              // Brighten filter: lifts midtones, slightly boosts contrast and saturation
              // Compensates for grimdark images that generate too dark to read
              filter: brighten
                ? "brightness(1.22) contrast(1.06) saturate(1.05)"
                : "none",
              transition: "filter 0.3s ease",
            }}
          />

          {/* SVG zone overlay */}
          {showLabels && zonePoints.length > 0 && (
            <ZoneOverlay
              zones={zonePoints}
              revealedZones={revealedZones}
              selectedZoneKey={selectedZoneKey}
              onZoneClick={handleZoneClick}
              fogActive={revealedZones.length > 0}
            />
          )}

          {/* Bottom info bar */}
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-4 rounded-b-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <p className="text-amber-300 font-semibold text-sm uppercase tracking-widest">
              {mapRow.name}
            </p>
            {mapRow.layout && (
              <p className="text-zinc-400 text-xs">
                {LAYOUT_LABEL[mapRow.layout] ?? mapRow.layout}
                {mapRow.zone_count ? ` · ${mapRow.zone_count} Zones` : ""}
                {mapRow.art_version ? ` · ${mapRow.art_version}` : ""}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
