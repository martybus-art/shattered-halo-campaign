// apps/web/src/app/map/page.tsx
// Tactical Hololith — campaign map viewer.
// Campaign ID read from ?campaign= URL param. Role loaded for Frame nav.
// Shows MapImageDisplay with the generated map image + sector ownership grid below.
"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";
import { MapImageDisplay } from "@/components/MapImageDisplay";

// ── Types ─────────────────────────────────────────────────────────────────────

type Sector = {
  zone_key: string;
  sector_key: string;
  owner_user_id: string | null;
  revealed_public: boolean;
  fortified: boolean;
};

type MapZone = { key: string; name: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name);
}

const SECTOR_KEYS = ["A", "B", "C", "D"];

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [campaignId, setCampaignId] = useState<string>("");
  const [mapId, setMapId]           = useState<string | null>(null);
  const [role, setRole]             = useState<string>("player");
  const [zones, setZones]           = useState<MapZone[]>([]);
  const [sectors, setSectors]       = useState<Sector[]>([]);
  const [pageError, setPageError]   = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────

  const load = useCallback(async (cid: string) => {
    setLoading(true);
    setPageError(null);
    try {
      const { data: userResp } = await supabase.auth.getUser();
      const uid = userResp.user?.id;

      // Role (for Frame nav Lead Controls link)
      if (uid) {
        const { data: mem } = await supabase
          .from("campaign_members")
          .select("role")
          .eq("campaign_id", cid)
          .eq("user_id", uid)
          .maybeSingle();
        setRole(mem?.role ?? "player");
      }

      // Campaign row — get map_id
      const { data: c, error: ce } = await supabase
        .from("campaigns")
        .select("map_id")
        .eq("id", cid)
        .single();
      if (ce) throw new Error(ce.message);
      setMapId((c as any)?.map_id ?? null);

      // Map zones from map_json
      if ((c as any)?.map_id) {
        const { data: mapRow } = await supabase
          .from("maps")
          .select("map_json")
          .eq("id", (c as any).map_id)
          .maybeSingle();
        const zoneList: MapZone[] = (mapRow?.map_json as any)?.zones ?? [];
        setZones(zoneList);
      }

      // Sector ownership
      const { data: sectorData, error: se } = await supabase
        .from("sectors")
        .select("zone_key,sector_key,owner_user_id,revealed_public,fortified")
        .eq("campaign_id", cid);
      if (se) throw new Error(se.message);
      setSectors(sectorData ?? []);

    } catch (e: any) {
      setPageError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    const q = getQueryParam("campaign");
    if (q) setCampaignId(q);
  }, []);

  useEffect(() => {
    if (campaignId) load(campaignId);
  }, [campaignId, load]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const sectorAt = (zoneKey: string, sectorKey: string): Sector | undefined =>
    sectors.find(r => r.zone_key === zoneKey && r.sector_key === sectorKey);

  const isLead = role === "lead" || role === "admin";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame
      title="Tactical Hololith"
      campaignId={campaignId}
      role={role}
      currentPage="map"
    >
      <div className="space-y-6">

        {/* Error */}
        {pageError && (
          <Card title="Error">
            <p className="text-blood text-sm">{pageError}</p>
          </Card>
        )}

        {/* Loading state */}
        {loading && (
          <p className="text-parchment/50 animate-pulse text-sm px-1">Loading map data…</p>
        )}

        {/* ── Map image ── */}
        {campaignId && mapId && !loading && (
          <MapImageDisplay
            mapId={mapId}
            campaignId={campaignId}
            isLead={isLead}
          />
        )}

        {/* No map yet */}
        {campaignId && !mapId && !loading && !pageError && (
          <Card title="Map">
            <p className="text-parchment/50 text-sm italic">
              No map has been generated for this campaign yet.
              {isLead && " Create the map from Lead Controls."}
            </p>
          </Card>
        )}

        {/* ── Sector ownership grid ── */}
        {zones.length > 0 && sectors.length > 0 && (
          <div className="grid md:grid-cols-2 gap-6">
            {zones.map(z => (
              <Card key={z.key} title={z.name}>
                <div className="grid grid-cols-4 gap-1.5">
                  {SECTOR_KEYS.map(sk => {
                    const s = sectorAt(z.key, sk);
                    const revealed = !!s?.revealed_public;
                    return (
                      <div
                        key={sk}
                        className="rounded border border-brass/20 bg-void/60 px-2 py-2 flex flex-col items-center gap-0.5"
                      >
                        <span className="font-mono text-xs text-brass/80">{sk}</span>
                        {s?.fortified && (
                          <span className="text-xs text-blood leading-none">FORT</span>
                        )}
                        <span className={`text-xs leading-tight text-center ${revealed ? "text-parchment/75" : "text-parchment/30 italic"}`}>
                          {!revealed
                            ? "?"
                            : s?.owner_user_id
                              ? "Held"
                              : "Open"
                          }
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-parchment/40">
                  Fog-of-war: unrevealed sectors show as unknown.
                </p>
              </Card>
            ))}
          </div>
        )}

        {/* Sector grid — fallback when map_json has no zones but sectors exist */}
        {zones.length === 0 && sectors.length > 0 && (() => {
          const uniqueZones = Array.from(new Set(sectors.map(s => s.zone_key)));
          return (
            <div className="grid md:grid-cols-2 gap-6">
              {uniqueZones.map(zk => (
                <Card key={zk} title={zk.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}>
                  <div className="grid grid-cols-4 gap-1.5">
                    {SECTOR_KEYS.map(sk => {
                      const s = sectorAt(zk, sk);
                      const revealed = !!s?.revealed_public;
                      return (
                        <div
                          key={sk}
                          className="rounded border border-brass/20 bg-void/60 px-2 py-2 flex flex-col items-center gap-0.5"
                        >
                          <span className="font-mono text-xs text-brass/80">{sk}</span>
                          {s?.fortified && (
                            <span className="text-xs text-blood leading-none">FORT</span>
                          )}
                          <span className={`text-xs ${revealed ? "text-parchment/75" : "text-parchment/30 italic"}`}>
                            {!revealed ? "?" : s?.owner_user_id ? "Held" : "Open"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              ))}
            </div>
          );
        })()}

      </div>
    </Frame>
  );
}
