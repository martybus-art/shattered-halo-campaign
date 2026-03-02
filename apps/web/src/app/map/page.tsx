"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";
import { MapImageDisplay } from "@/components/MapImageDisplay";
import type { ZonePoint } from "@/components/MapImageDisplay";

// ── Types ─────────────────────────────────────────────────────────────────────

type CampaignMeta = {
  id: string;
  name: string;
  map_id: string | null;
  round_number: number;
};

type Sector = {
  zone_key: string;
  sector_key: string;
  owner_user_id: string | null;
  revealed_public: boolean;
  fortified: boolean;
};

type Member = {
  user_id: string;
  role?: string;
  faction_name: string | null;
  commander_name: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getQueryParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(key);
}

const SECTOR_STATUS: Record<string, { label: string; colour: string }> = {
  unclaimed: { label: "Unclaimed",  colour: "text-parchment/50" },
  occupied:  { label: "Occupied",   colour: "text-brass" },
  fortified: { label: "Fortified",  colour: "text-amber-400" },
  unknown:   { label: "Unknown",    colour: "text-parchment/30" },
};

function sectorStatus(
  s: Sector | undefined,
  members: Member[],
): { label: string; colour: string; owner?: string } {
  if (!s || !s.revealed_public) return SECTOR_STATUS.unknown;
  if (s.fortified)              return SECTOR_STATUS.fortified;
  if (s.owner_user_id) {
    const m = members.find(m => m.user_id === s.owner_user_id);
    return {
      ...SECTOR_STATUS.occupied,
      owner: m?.faction_name ?? m?.commander_name ?? s.owner_user_id.slice(0, 8),
    };
  }
  return SECTOR_STATUS.unclaimed;
}

function toDisplayName(zoneKey: string): string {
  return zoneKey.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [campaignId, setCampaignId]   = useState<string>("");
  const [campaign, setCampaign]       = useState<CampaignMeta | null>(null);
  const [members, setMembers]         = useState<Member[]>([]);
  const [sectors, setSectors]         = useState<Sector[]>([]);
  const [isLead, setIsLead]           = useState(false);
  const [revealedZones, setRevealedZones] = useState<string[]>([]);

  const [selectedZone, setSelectedZone] = useState<ZonePoint | null>(null);

  const [loadingCampaign, setLoadingCampaign] = useState(true);
  const [loadingSectors, setLoadingSectors]   = useState(false);
  const [pageError, setPageError]             = useState<string | null>(null);

  // ── Read campaign from URL ────────────────────────────────────────────────

  useEffect(() => {
    const id = getQueryParam("campaign");
    if (id) setCampaignId(id);
  }, []);

  // ── Load campaign meta, role, members ────────────────────────────────────

  useEffect(() => {
    if (!campaignId) return;
    const load = async () => {
      setLoadingCampaign(true);
      setPageError(null);

      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id ?? null;

      const { data: camp, error: campErr } = await supabase
        .from("campaigns")
        .select("id, name, map_id, round_number")
        .eq("id", campaignId)
        .maybeSingle();

      if (campErr || !camp) {
        setPageError(campErr?.message ?? "Campaign not found.");
        setLoadingCampaign(false);
        return;
      }
      setCampaign(camp as CampaignMeta);

      const { data: memberRows } = await supabase
        .from("campaign_members")
        .select("user_id, role, faction_name, commander_name")
        .eq("campaign_id", campaignId);

      const allMembers = (memberRows ?? []) as Member[];
      setMembers(allMembers);

      if (userId) {
        const me = allMembers.find(m => m.user_id === userId);
        setIsLead((me as any)?.role === "lead");
      }

      setLoadingCampaign(false);
    };
    load();
  }, [campaignId, supabase]);

  // ── Load sectors ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!campaignId) return;
    const loadSectors = async () => {
      setLoadingSectors(true);
      const { data, error } = await supabase
        .from("sectors")
        .select("zone_key, sector_key, owner_user_id, revealed_public, fortified")
        .eq("campaign_id", campaignId);
      if (!error && data) {
        setSectors(data as Sector[]);
        const revealed = [
          ...new Set((data as Sector[]).filter(s => s.revealed_public).map(s => s.zone_key)),
        ];
        setRevealedZones(revealed);
      }
      setLoadingSectors(false);
    };
    loadSectors();
  }, [campaignId, supabase]);

  // ── Listen for zone click events from MapImageDisplay SVG overlay ─────────

  useEffect(() => {
    const handler = (e: Event) => {
      const zone = (e as CustomEvent<ZonePoint>).detail;
      setSelectedZone(prev => prev?.key === zone.key ? null : zone);
    };
    window.addEventListener("campaign:zoneSelected", handler);
    return () => window.removeEventListener("campaign:zoneSelected", handler);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const dashboardHref = campaignId ? `/dashboard?campaign=${campaignId}` : "/dashboard";

  if (!campaignId) {
    return (
      <Frame title="Tactical Hololith" right={<a className="underline" href="/dashboard">Dashboard</a>}>
        <Card title="No Campaign">
          <p className="text-parchment/60 text-sm">
            No campaign ID in the URL. Navigate here from your dashboard.
          </p>
        </Card>
      </Frame>
    );
  }

  const uniqueZoneKeys = [...new Set(sectors.map(s => s.zone_key))].sort();

  return (
    <Frame
      title="Tactical Hololith"
      right={<a className="underline" href={dashboardHref}>Dashboard</a>}
    >
      <div className="space-y-6">

        {/* ── Campaign Map card (image lives inside here) ── */}
        <Card title={loadingCampaign ? "Campaign Map" : `Campaign Map — ${campaign?.name ?? ""}`}>

          {loadingCampaign && (
            <div className="flex items-center justify-center h-32 text-parchment/40 text-sm animate-pulse">
              Loading campaign data…
            </div>
          )}

          {pageError && (
            <div className="text-blood text-sm p-4 border border-blood/30 rounded bg-blood/10">
              {pageError}
            </div>
          )}

          {!loadingCampaign && !pageError && campaign?.map_id && (
            <MapImageDisplay
              mapId={campaign.map_id}
              campaignId={campaign.id}
              isLead={isLead}
              revealedZones={revealedZones}
              selectedZoneKey={selectedZone?.key ?? null}
              className="mt-2"
            />
          )}

          {!loadingCampaign && !pageError && !campaign?.map_id && (
            <div className="flex items-center justify-center h-32 text-parchment/40 text-sm">
              No map has been generated for this campaign yet.
            </div>
          )}

          {!loadingCampaign && !pageError && (
            <p className="mt-3 text-xs text-parchment/40 italic text-center">
              Click a numbered zone badge to view sector details.
              {revealedZones.length === 0 && " Fog of war is active — move into zones to reveal them."}
            </p>
          )}
        </Card>

        {/* ── Selected zone panel (appears when a zone badge is clicked) ── */}
        {selectedZone && (
          <Card title={`Zone — ${selectedZone.name}`}>
            <div className="space-y-4">

              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-parchment/50 uppercase tracking-widest mb-0.5">
                    Zone {selectedZone.index + 1}
                  </p>
                  <h3 className="text-brass font-semibold text-lg leading-tight">
                    {selectedZone.name}
                  </h3>
                </div>
                <button
                  onClick={() => setSelectedZone(null)}
                  className="text-parchment/40 hover:text-parchment/70 text-sm transition-colors pt-1"
                >
                  ✕ Close
                </button>
              </div>

              {/* Sector grid for selected zone */}
              {loadingSectors ? (
                <p className="text-parchment/40 text-sm animate-pulse">Loading sectors…</p>
              ) : (() => {
                const zoneSectors = sectors.filter(s => s.zone_key === selectedZone.key);
                const sectorKeys  = zoneSectors.length > 0
                  ? [...new Set(zoneSectors.map(s => s.sector_key))].sort()
                  : ["A1", "A2", "B1", "B2"]; // fallback if sectors not seeded yet

                return (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {sectorKeys.map(sk => {
                      const s      = zoneSectors.find(r => r.sector_key === sk);
                      const status = sectorStatus(s, members);
                      const known  = s?.revealed_public ?? false;
                      return (
                        <div
                          key={sk}
                          className={`rounded border px-3 py-2 transition-colors ${
                            known
                              ? "border-brass/30 bg-void hover:border-brass/50"
                              : "border-parchment/10 bg-void/50"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-mono text-xs text-brass font-bold">{sk}</span>
                            {s?.fortified && (
                              <span className="text-xs text-amber-400">⚑</span>
                            )}
                          </div>
                          <div className={`text-xs ${status.colour}`}>{status.label}</div>
                          {status.owner && (
                            <div className="text-xs text-parchment/50 mt-0.5 truncate">
                              {status.owner}
                            </div>
                          )}
                          {!known && (
                            <div className="text-xs text-parchment/25 italic mt-0.5">
                              Fog of war
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {isLead && (
                <p className="text-xs text-parchment/35 border-t border-brass/15 pt-2 italic">
                  As campaign lead you see all sectors. Players only see revealed zones.
                </p>
              )}
            </div>
          </Card>
        )}

        {/* ── Zone status summary (replaces old static zone cards) ── */}
        {!loadingCampaign && uniqueZoneKeys.length > 0 && (
          <Card title="Zone Status Summary">
            <div className="space-y-1">
              {uniqueZoneKeys.map(zk => {
                const zoneSectors   = sectors.filter(s => s.zone_key === zk);
                const revealed      = zoneSectors.filter(s => s.revealed_public).length;
                const occupied      = zoneSectors.filter(s => s.revealed_public && s.owner_user_id).length;
                const isRevealed    = revealedZones.includes(zk);
                const displayName   = toDisplayName(zk);
                const isSelected    = selectedZone?.key === zk;

                return (
                  <button
                    key={zk}
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("campaign:zoneSelected", {
                          detail: {
                            key:   zk,
                            name:  displayName,
                            cx:    50,
                            cy:    50,
                            r:     6,
                            index: uniqueZoneKeys.indexOf(zk),
                          } satisfies ZonePoint,
                        }),
                      )
                    }
                    className={`w-full flex items-center justify-between px-3 py-2 rounded border transition-colors text-left ${
                      isSelected
                        ? "border-brass/50 bg-brass/10"
                        : "border-brass/15 hover:border-brass/35 bg-void hover:bg-brass/5"
                    }`}
                  >
                    <span className={`text-sm font-medium ${isRevealed ? "text-parchment/80" : "text-parchment/35"}`}>
                      {isRevealed ? displayName : `??? ${displayName}`}
                    </span>
                    <span className="text-xs text-parchment/45">
                      {isRevealed
                        ? `${revealed} revealed · ${occupied} occupied`
                        : "Unrevealed"}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-parchment/40 italic">
              Fog of war: only publicly revealed sectors show occupation status.
            </p>
          </Card>
        )}

      </div>
    </Frame>
  );
}
