"use client";

/**
 * MapImageDisplay
 * ───────────────
 * Shows the AI-generated campaign map image for a given map row.
 *
 * States:
 *   none/pending/generating → animated placeholder with status text
 *   complete                → renders the image from Supabase Storage
 *   failed                  → shows error state with retry button (lead only)
 *
 * Usage in map/page.tsx:
 *   <MapImageDisplay mapId={campaign.map_id} campaignId={campaign.id} isLead={isLead} />
 *
 * Polling:
 *   Polls every 5 seconds while status is pending or generating.
 *   Stops polling once status is complete or failed.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
}

interface MapImageDisplayProps {
  /** UUID of the maps row (campaigns.map_id) */
  mapId: string;
  /** UUID of the campaign — used to construct storage path if needed */
  campaignId: string;
  /** Whether the current user is the campaign lead (enables retry button) */
  isLead?: boolean;
  /** Optional extra CSS classes on the wrapper */
  className?: string;
}

// ── Public URL resolver ───────────────────────────────────────────────────────

/**
 * Resolves a storage path from the campaign-maps bucket to a public URL.
 * The bucket is currently private, so we generate a signed URL.
 *
 * NOTE: If you make the campaign-maps bucket public in Supabase,
 * you can switch to getPublicUrl instead (no expiry needed).
 */
async function getImageUrl(supabase: ReturnType<typeof supabaseBrowser>, storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from("campaign-maps")
    .createSignedUrl(storagePath, 60 * 60); // 1-hour signed URL

  if (error || !data?.signedUrl) {
    console.warn("MapImageDisplay: failed to create signed URL", error?.message);
    return null;
  }
  return data.signedUrl;
}

// ── Status display helpers ────────────────────────────────────────────────────

const STATUS_LABEL: Record<GenerationStatus, string> = {
  none:       "No map image",
  pending:    "Preparing map generation…",
  generating: "Generating map image…",
  complete:   "Map ready",
  failed:     "Map generation failed",
};

const LAYOUT_LABEL: Record<string, string> = {
  ring:      "Halo Ring",
  continent: "Fractured Continent",
  radial:    "Radial Spokes",
  ship_line: "Void Warship",
};

// ── Component ─────────────────────────────────────────────────────────────────

export function MapImageDisplay({
  mapId,
  campaignId,
  isLead = false,
  className = "",
}: MapImageDisplayProps) {
  const [mapRow, setMapRow]     = useState<MapRow | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const supabase     = useMemo(() => supabaseBrowser(), []);

  // ── Fetch map row ───────────────────────────────────────────────────────

  const fetchMapRow = async (): Promise<MapRow | null> => {
    const { data, error: dbErr } = await supabase
      .from("maps")
      .select("id, name, image_path, bg_image_path, generation_status, layout, zone_count, art_version")
      .eq("id", mapId)
      .maybeSingle();

    if (dbErr) {
      console.error("MapImageDisplay: DB fetch error", dbErr.message);
      setError("Could not load map data.");
      return null;
    }
    return data as MapRow | null;
  };

  // ── Resolve image URL when status is complete ───────────────────────────

  const resolveImage = async (row: MapRow) => {
    const path = row.image_path ?? row.bg_image_path;
    if (!path) return;
    const url = await getImageUrl(supabase, path);
    setImageUrl(url);
  };

  // ── Initial load + polling ──────────────────────────────────────────────

  useEffect(() => {
    if (!mapId) return;

    const load = async () => {
      setLoading(true);
      const row = await fetchMapRow();
      setLoading(false);

      if (!row) return;
      setMapRow(row);

      if (row.generation_status === "complete") {
        await resolveImage(row);
      }
    };

    load();

    // Poll while status is still in-progress
    pollTimerRef.current = setInterval(async () => {
      const row = await fetchMapRow();
      if (!row) return;
      setMapRow(row);

      if (row.generation_status === "complete") {
        await resolveImage(row);
        // Stop polling
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }

      if (row.generation_status === "failed") {
        // Stop polling on failure
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    }, 5000); // poll every 5 seconds

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId]);

  // ── Retry handler (lead only) ───────────────────────────────────────────

  const handleRetry = async () => {
    if (!mapId || !campaignId || retrying) return;
    setRetrying(true);
    setError(null);

    try {
      const res = await fetch("/api/map/regenerate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ map_id: mapId, campaign_id: campaignId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Retry failed");

      // Reset state and start polling again
      setMapRow(prev => prev ? { ...prev, generation_status: "pending" } : prev);
      setImageUrl(null);

      pollTimerRef.current = setInterval(async () => {
        const row = await fetchMapRow();
        if (!row) return;
        setMapRow(row);
        if (row.generation_status === "complete") {
          await resolveImage(row);
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        }
        if (row.generation_status === "failed") {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        }
      }, 5000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Retry failed: ${msg}`);
    } finally {
      setRetrying(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  const status = mapRow?.generation_status ?? "none";
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
          {/* Animated background pattern */}
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900 animate-pulse" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            {/* Spinner */}
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

      {/* ── No image yet (status: none) ───────────────────────────────────── */}
      {status === "none" && !imageUrl && (
        <div className="w-full bg-zinc-900 rounded-lg p-8 flex flex-col items-center gap-2 text-center">
          <div className="text-4xl text-zinc-700">🗺</div>
          <p className="text-zinc-500 text-sm">No map image has been generated yet.</p>
        </div>
      )}

      {/* ── Map image ─────────────────────────────────────────────────────── */}
      {status === "complete" && imageUrl && (
        <div className="relative group">
          <img
            src={imageUrl}
            alt={mapRow.name ?? "Campaign Map"}
            className="w-full h-auto rounded-lg object-cover shadow-2xl shadow-black"
            style={{ aspectRatio: "1536/1024" }}
          />
          {/* Hover overlay with map info */}
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-4 rounded-b-lg opacity-0 group-hover:opacity-100 transition-opacity">
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
          {/* Lead: regenerate button */}
          {isLead && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="absolute top-3 right-3 px-3 py-1 bg-black/70 hover:bg-black/90 disabled:opacity-50 text-amber-400 text-xs font-semibold rounded uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity"
            >
              {retrying ? "…" : "Regenerate"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
