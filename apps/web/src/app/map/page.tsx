// apps/web/src/app/map/page.tsx
// Tactical Hololith -- campaign map viewer with movement order submission.
//
// changelog:
//   2026-03-07 -- Reads rules_overrides.fog.enabled from campaign. When fog is
//                 disabled all sectors are shown as visible regardless of
//                 revealed_public, and the "?" unknown label is replaced with
//                 the actual ownership info. Fog status shown in token row.
//   2026-03-05 -- Added movement orders panel: unit selection, destination
//                 picker with adjacency enforcement, deep strike and recon
//                 phase support. Added unit deployment (spend NIP).
//                 Added My Units card showing all active units + positions.
//                 Map image remains primary display via MapImageDisplay.
//                 Frame receives campaignId + role for correct nav.

"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";
import { MapImageDisplay } from "@/components/MapImageDisplay";

// ── Constants ─────────────────────────────────────────────────────────────────

const STAGE_ORDER = ["spend", "recon", "movement", "conflicts", "missions", "results", "publish"] as const;
const SECTOR_KEYS = ["a", "b", "c", "d"];

const UNIT_NIP_COST: Record<string, number> = {
  scout:      1,
  occupation: 2,
};

// ── Types ─────────────────────────────────────────────────────────────────────

type Sector = {
  zone_key:        string;
  sector_key:      string;
  owner_user_id:   string | null;
  revealed_public: boolean;
  fortified:       boolean;
};

type MapZone = {
  key:     string;
  name:    string;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getQueryParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get(name) ?? "";
}

function fmtKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Ring adjacency: each zone adjacent to next/prev in array + itself.
// Returns a Map<zone_key, Set<adjacent_zone_key>>.
// layout values:
//   "ring"                 -- Halo Ring: each zone connects to prev + next, wrapping
//   "spoke"                -- Spoke: zones[0] is centre hub, all outer connect to hub
//                             + to their immediate ring neighbours
//   "void_ship" / "line"   -- Linear line: each zone connects only to immediate
//                             neighbours, no wrap (end zones have 1 connection only)
//   "fractured_continents" -- Clusters of ~3 zones fully ring-connected internally,
//                             each cluster bridged to the next via one connection
function buildAdjacency(zones: MapZone[], layout: string = "ring"): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const n   = zones.length;

  // Initialise every zone with self-adjacency (staying in place is always valid)
  for (const z of zones) adj.set(z.key, new Set([z.key]));
  if (n <= 1) return adj;

  const addEdge = (a: string, b: string) => {
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  switch (layout) {

    case "spoke": {
      // zones[0] = central hub, connects to every outer zone.
      // Outer zones (1..n-1) also form a ring among themselves.
      const hub = zones[0].key;
      for (let i = 1; i < n; i++) {
        addEdge(hub, zones[i].key);               // hub <-> outer
        const prev = zones[i === 1 ? n - 1 : i - 1].key;
        addEdge(zones[i].key, prev);               // outer ring
      }
      break;
    }

    case "void_ship":
    case "line": {
      // Straight line: zone[i] only connects to zone[i-1] and zone[i+1].
      // No wrap — end zones have exactly one outbound connection.
      for (let i = 0; i < n - 1; i++) {
        addEdge(zones[i].key, zones[i + 1].key);
      }
      break;
    }

    case "fractured_continents": {
      // Divide zones into clusters of roughly 3. Within each cluster the zones
      // form a ring. The LAST zone of each cluster bridges to the FIRST zone of
      // the next cluster, creating strategic chokepoints between continents.
      const clusterSize = Math.max(2, Math.round(n / Math.ceil(n / 3)));
      const numClusters = Math.ceil(n / clusterSize);
      for (let c = 0; c < numClusters; c++) {
        const start = c * clusterSize;
        const end   = Math.min(start + clusterSize, n);
        const cluster = zones.slice(start, end);
        // Ring within cluster
        for (let i = 0; i < cluster.length; i++) {
          addEdge(cluster[i].key, cluster[(i + 1) % cluster.length].key);
        }
        // Bridge: last of this cluster -> first of next cluster
        if (c < numClusters - 1) {
          addEdge(cluster[cluster.length - 1].key, zones[end].key);
        }
      }
      break;
    }

    case "ring":
    default: {
      // Standard Halo Ring: each zone connects to prev and next, wrapping.
      for (let i = 0; i < n; i++) {
        addEdge(zones[i].key, zones[(i + 1) % n].key);
      }
      break;
    }
  }

  return adj;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // campaignId read directly from URL so it is populated before any useEffect
  const [campaignId] = useState<string>(() => getQueryParam("campaign"));

  const [mapId,        setMapId]        = useState<string | null>(null);
  const [role,         setRole]         = useState<string>("player");
  const [uid,          setUid]          = useState<string>("");
  const [zones,        setZones]        = useState<MapZone[]>([]);
  const [sectors,      setSectors]      = useState<Sector[]>([]);
  const [myUnits,      setMyUnits]      = useState<Unit[]>([]);
  const [myMoves,      setMyMoves]      = useState<Move[]>([]);
  const [members,      setMembers]      = useState<Member[]>([]);
  const [roundNumber,  setRoundNumber]  = useState<number>(1);
  const [stage,        setStage]        = useState<string | null>(null);
  const [myNip,        setMyNip]        = useState<number>(0);
  const [hasDeepStrike,setHasDeepStrike]= useState(false);
  const [hasRecon,     setHasRecon]     = useState(false);
  // Fog of war: read from rules_overrides.fog.enabled (default true)
  const [fogEnabled,   setFogEnabled]   = useState<boolean>(true);
  // Map layout: controls adjacency pattern (ring | spoke | void_ship | fractured_continents)
  const [mapLayout,    setMapLayout]    = useState<string>("ring");

  const [pageError,    setPageError]    = useState<string | null>(null);
  const [loading,      setLoading]      = useState(false);

  // -- Movement order state
  const [selectedUnit,    setSelectedUnit]    = useState<Unit | null>(null);
  const [toZone,          setToZone]          = useState<string>("");
  const [toSector,        setToSector]        = useState<string>("");
  const [submitting,      setSubmitting]      = useState(false);
  const [moveResult,      setMoveResult]      = useState<string | null>(null);

  // -- Deploy unit state
  const [deployType,      setDeployType]      = useState<"scout" | "occupation">("scout");
  const [deployZone,      setDeployZone]      = useState<string>("");
  const [deploySector,    setDeploySector]    = useState<string>("");
  const [deploying,       setDeploying]       = useState(false);
  const [deployResult,    setDeployResult]    = useState<string | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setPageError(null);
    try {
      const { data: userResp } = await supabase.auth.getUser();
      const userId = userResp.user?.id ?? "";
      setUid(userId);

      // Role
      if (userId) {
        const { data: mem } = await supabase
          .from("campaign_members").select("role")
          .eq("campaign_id", campaignId).eq("user_id", userId).maybeSingle();
        setRole(mem?.role ?? "player");
      }

      // Campaign -- includes rules_overrides so we can read fog setting
      const { data: c, error: ce } = await supabase
        .from("campaigns").select("map_id, round_number, rules_overrides")
        .eq("id", campaignId).single();
      if (ce) throw new Error(ce.message);
      setMapId((c as any)?.map_id ?? null);
      const rn = (c as any)?.round_number ?? 1;
      setRoundNumber(rn);

      // Fog of war rule -- defaults to true (fog on) when not configured
      const rulesOverrides = ((c as any)?.rules_overrides ?? {}) as Record<string, any>;
      const fogRule = rulesOverrides.fog as Record<string, any> | undefined;
      setFogEnabled(fogRule?.enabled !== false); // false only when explicitly disabled
      // Map layout rule -- defaults to "ring" (Halo Ring pattern)
      setMapLayout((rulesOverrides.map_layout as string | undefined) ?? "ring");

      // Current stage
      const { data: rnd } = await supabase
        .from("rounds").select("stage")
        .eq("campaign_id", campaignId).eq("round_number", rn).maybeSingle();
      setStage(rnd?.stage ?? null);

      // Map zones
      if ((c as any)?.map_id) {
        const { data: mapRow } = await supabase
          .from("maps").select("map_json")
          .eq("id", (c as any).map_id).maybeSingle();
        const zoneList: MapZone[] = (mapRow?.map_json as any)?.zones ?? [];
        setZones(zoneList);
        if (zoneList.length > 0 && !deployZone) setDeployZone(zoneList[0].key);
      }

      // Sectors (own + revealed)
      const { data: sectorData } = await supabase
        .from("sectors").select("zone_key,sector_key,owner_user_id,revealed_public,fortified")
        .eq("campaign_id", campaignId);
      setSectors(sectorData ?? []);

      // Members (for owner name display)
      const { data: memberData } = await supabase
        .from("campaign_members").select("user_id,commander_name,faction_name")
        .eq("campaign_id", campaignId);
      setMembers(memberData ?? []);

      // My units
      if (userId) {
        const { data: unitData } = await supabase
          .from("units").select("id,unit_type,zone_key,sector_key,status,round_deployed")
          .eq("campaign_id", campaignId).eq("user_id", userId).eq("status", "active");
        setMyUnits((unitData ?? []) as Unit[]);

        // My moves this round
        const { data: moveData } = await supabase
          .from("moves").select("id,unit_id,from_zone_key,from_sector_key,to_zone_key,to_sector_key,move_type,submitted_at")
          .eq("campaign_id", campaignId).eq("round_number", rn).eq("user_id", userId);
        setMyMoves((moveData ?? []) as Move[]);

        // My NIP + tokens
        const { data: ps } = await supabase
          .from("player_state").select("nip")
          .eq("campaign_id", campaignId).eq("user_id", userId).maybeSingle();
        setMyNip(ps?.nip ?? 0);

        const { data: spends } = await supabase
          .from("round_spends").select("spend_type")
          .eq("campaign_id", campaignId).eq("round_number", rn).eq("user_id", userId);
        const spendTypes = new Set((spends ?? []).map((s: any) => s.spend_type));
        setHasDeepStrike(spendTypes.has("deep_strike"));
        setHasRecon(spendTypes.has("recon"));
      }

    } catch (e: any) {
      setPageError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [campaignId, supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // ── Derived ───────────────────────────────────────────────────────────────

  // effectiveZones: use map_json zones when available; fall back to the unique
  // zone_keys present in the sectors table.  This ensures adjacency is always
  // computable even when map_json was never set or doesn't carry a zones array.
  const effectiveZones = useMemo<MapZone[]>(() => {
    if (zones.length > 0) return zones;
    // Build stub MapZone objects from sectors, preserving a stable order.
    const seen = new Set<string>();
    const stubs: MapZone[] = [];
    for (const s of sectors) {
      if (!seen.has(s.zone_key)) {
        seen.add(s.zone_key);
        stubs.push({ key: s.zone_key, name: fmtKey(s.zone_key) });
      }
    }
    return stubs;
  }, [zones, sectors]);

  const adj         = useMemo(
    () => buildAdjacency(effectiveZones, mapLayout),
    [effectiveZones, mapLayout]
  );

  const memberById  = useMemo(() => {
    const m = new Map<string, Member>();
    members.forEach((mem) => m.set(mem.user_id, mem));
    return m;
  }, [members]);

  const mySectors = useMemo(
    () => sectors.filter((s) => s.owner_user_id === uid),
    [sectors, uid]
  );

  // Available destination zones for selected unit
  const validZones = useMemo(() => {
    if (!selectedUnit) return new Set<string>();
    // Deep Strike bypasses adjacency -- all known zones are valid destinations
    if (hasDeepStrike) return new Set(effectiveZones.map((z) => z.key));
    return adj.get(selectedUnit.zone_key) ?? new Set<string>();
  }, [selectedUnit, hasDeepStrike, adj, effectiveZones]);

  const inMovementPhase = stage === "movement";
  const inReconPhase    = stage === "recon";
  const canMove         = inMovementPhase || (inReconPhase && hasRecon);
  const inSpendPhase    = stage === "spend";

  // Whether a sector is visible to this player.
  // When fog is disabled: all sectors are visible.
  // When fog is enabled: only sectors flagged revealed_public are visible
  // (the player's own sectors are always revealed server-side).
  const isSectorVisible = (s: Sector | undefined): boolean => {
    if (!s) return false;
    if (!fogEnabled) return true;
    return s.revealed_public;
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  const submitMove = async () => {
    if (!selectedUnit || !toZone || !toSector) return;
    setSubmitting(true);
    setMoveResult(null);
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
          body: JSON.stringify({
            campaign_id:   campaignId,
            unit_id:       selectedUnit.id,
            to_zone_key:   toZone,
            to_sector_key: toSector,
          }),
        }
      );
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);

      let msg = `Order submitted: ${selectedUnit.unit_type} moving to ${fmtKey(toZone)} / ${toSector.toUpperCase()}`;
      if (data.auto_transfer)   msg += " — territory captured (undefended)";
      if (data.conflict_id)     msg += " — ⚔️ CONFLICT initiated";
      if (data.defensive_bonus) msg += " (enemy has defensive bonus — sector unscouted)";

      setMoveResult(msg);
      setSelectedUnit(null);
      setToZone("");
      setToSector("");
      await load();
    } catch (e: any) {
      setMoveResult(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const deployUnit = async () => {
    if (!deployZone || !deploySector) return;
    setDeploying(true);
    setDeployResult(null);
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
          body: JSON.stringify({
            campaign_id: campaignId,
            unit_type:   deployType,
            zone_key:    deployZone,
            sector_key:  deploySector,
          }),
        }
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

  const sectorAt = (zk: string, sk: string) =>
    sectors.find((s) => s.zone_key === zk && s.sector_key === sk);

  const ownerLabel = (ownerId: string | null) => {
    if (!ownerId) return null;
    if (ownerId === uid) return { label: "You", mine: true };
    const m = memberById.get(ownerId);
    return { label: m?.commander_name ?? "Enemy", mine: false };
  };

  const unitMoveThisRound = (unitId: string) =>
    myMoves.find((m) => m.unit_id === unitId) ?? null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame
      title="Tactical Hololith"
      campaignId={campaignId}
      role={role}
      currentPage="map"
    >
      <div className="space-y-6">

        {pageError && (
          <Card title="Error">
            <p className="text-blood text-sm">{pageError}</p>
          </Card>
        )}

        {loading && (
          <p className="text-parchment/50 animate-pulse text-sm px-1">Loading tactical data…</p>
        )}

        {/* ── Map image ── */}
        {campaignId && mapId && !loading && (
          <MapImageDisplay mapId={mapId} campaignId={campaignId} isLead={role === "lead" || role === "admin"} />
        )}

        {campaignId && !mapId && !loading && !pageError && (
          <Card title="Map">
            <p className="text-parchment/50 text-sm italic">
              No map generated yet.{(role === "lead" || role === "admin") && " Create one from Lead Controls."}
            </p>
          </Card>
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
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded border font-mono uppercase ${
                          u.unit_type === "scout"
                            ? "bg-blue-500/15 border-blue-400/40 text-blue-300"
                            : "bg-brass/15 border-brass/40 text-brass"
                        }`}>{u.unit_type}</span>
                        <span className="text-parchment/70 text-sm">
                          {fmtKey(u.zone_key)} / {u.sector_key.toUpperCase()}
                        </span>
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
                        onClick={() => {
                          setSelectedUnit(u);
                          setToZone(u.zone_key);
                          setToSector(u.sector_key);
                          setMoveResult(null);
                        }}
                        className="shrink-0 px-3 py-1 rounded text-xs border border-brass/40 hover:bg-brass/20 text-parchment/60 hover:text-parchment/90 transition-colors">
                        Order
                      </button>
                    )}
                    {canMove && pending && (
                      <button
                        onClick={() => {
                          setSelectedUnit(u);
                          setToZone(pending.to_zone_key);
                          setToSector(pending.to_sector_key);
                          setMoveResult(null);
                        }}
                        className="shrink-0 px-3 py-1 rounded text-xs border border-parchment/20 hover:bg-parchment/10 text-parchment/40 transition-colors">
                        Edit
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Token + fog status row */}
            <div className="mt-3 pt-3 border-t border-parchment/10 flex gap-3 flex-wrap">
              <span className={`text-xs px-2 py-0.5 rounded border font-mono ${hasDeepStrike ? "bg-brass/20 border-brass/50 text-brass" : "bg-void border-parchment/10 text-parchment/25"}`}>
                {hasDeepStrike ? "✓ Deep Strike" : "No Deep Strike"}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded border font-mono ${hasRecon ? "bg-blue-500/15 border-blue-400/40 text-blue-300" : "bg-void border-parchment/10 text-parchment/25"}`}>
                {hasRecon ? "✓ Recon Token" : "No Recon Token"}
              </span>
              {/* Fog status -- only shown when fog is disabled to avoid confusion */}
              {!fogEnabled && (
                <span className="text-xs px-2 py-0.5 rounded border font-mono bg-parchment/10 border-parchment/30 text-parchment/50">
                  Fog Off
                </span>
              )}
              <span className="text-xs px-2 py-0.5 rounded border border-parchment/10 text-parchment/35 font-mono ml-auto">
                {myNip} NIP
              </span>
            </div>
          </Card>
        )}

        {/* ── Movement Order ── */}
        {selectedUnit && canMove && (
          <Card title={`Movement Order — ${fmtKey(selectedUnit.unit_type)} Unit`}>
            <div className="space-y-4">
              <div className="text-sm text-parchment/60">
                Current position: <span className="text-parchment/85">{fmtKey(selectedUnit.zone_key)} / {selectedUnit.sector_key.toUpperCase()}</span>
                {hasDeepStrike && <span className="ml-2 text-brass text-xs font-mono">Deep Strike active — any destination valid</span>}
                {!hasDeepStrike && (
                  <span className="ml-2 text-parchment/35 text-xs">
                    Adjacent zones: {Array.from(adj.get(selectedUnit.zone_key) ?? []).filter(z => z !== selectedUnit.zone_key).map(fmtKey).join(", ") || "same zone only"}
                  </span>
                )}
                {inReconPhase && selectedUnit.unit_type === "scout" && (
                  <span className="ml-2 text-blue-300 text-xs font-mono">Recon phase — scout move, intel will be gained</span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-parchment/40 uppercase tracking-widest block mb-1.5">Destination Zone</label>
                  <select
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm text-parchment/85"
                    value={toZone}
                    onChange={(e) => { setToZone(e.target.value); setToSector(""); }}>
                    <option value="">-- select zone --</option>
                    {effectiveZones.map((z) => {
                      const valid = validZones.has(z.key);
                      return (
                        <option key={z.key} value={z.key} disabled={!valid}>
                          {z.name}{valid ? "" : " (out of range)"}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-parchment/40 uppercase tracking-widest block mb-1.5">Destination Sector</label>
                  <select
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm text-parchment/85"
                    value={toSector}
                    disabled={!toZone}
                    onChange={(e) => setToSector(e.target.value)}>
                    <option value="">-- select sector --</option>
                    {toZone && SECTOR_KEYS.map((sk) => {
                      const s      = sectorAt(toZone, sk);
                      const owner  = ownerLabel(s?.owner_user_id ?? null);
                      const isOwn  = owner?.mine;
                      return (
                        <option key={sk} value={sk}>
                          {sk.toUpperCase()}
                          {isOwn ? " (yours)" : owner ? ` — ${owner.label}` : " (open)"}
                          {s?.fortified ? " [FORTIFIED]" : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              {/* Threat indicator */}
              {toZone && toSector && (() => {
                const s     = sectorAt(toZone, toSector);
                const owner = ownerLabel(s?.owner_user_id ?? null);
                if (!owner || owner.mine) return null;
                return (
                  <div className="px-3 py-2 rounded border border-blood/30 bg-blood/10 text-sm text-blood/80">
                    ⚠️ <span className="font-semibold">{owner.label}</span> controls this sector.
                    {selectedUnit.unit_type === "occupation"
                      ? " Moving here will trigger a conflict if they have a defending unit, or capture it if undefended."
                      : " Scouting here will gather intel and may trigger a conflict."}
                    {hasDeepStrike && !myMoves.some(m => m.to_zone_key === toZone && m.to_sector_key === toSector) &&
                      " Deep striking into an unscouted sector gives the defender a bonus."}
                  </div>
                );
              })()}

              {moveResult && (
                <p className={`text-sm px-3 py-2 rounded border ${
                  moveResult.startsWith("Error")
                    ? "border-blood/30 bg-blood/10 text-blood/80"
                    : "border-brass/30 bg-brass/10 text-brass/80"
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
                Deploy a new unit to one of your held sectors. Costs are deducted from your NIP balance ({myNip} available).
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-parchment/40 uppercase tracking-widest block mb-1.5">Unit Type</label>
                  <div className="flex gap-2">
                    {(["scout", "occupation"] as const).map((ut) => (
                      <button
                        key={ut}
                        onClick={() => setDeployType(ut)}
                        className={`flex-1 px-3 py-2 rounded border text-sm font-semibold transition-colors ${
                          deployType === ut
                            ? "bg-brass/20 border-brass/50 text-brass"
                            : "bg-void border-parchment/20 text-parchment/50 hover:border-brass/30"
                        }`}>
                        {fmtKey(ut)}
                        <span className="block text-xs font-mono mt-0.5 opacity-70">{UNIT_NIP_COST[ut]} NIP</span>
                      </button>
                    ))}
                  </div>
                  {deployType === "scout" && (
                    <p className="text-xs text-parchment/35 mt-1.5">Explores territory, gains intel. Can move in recon phase.</p>
                  )}
                  {deployType === "occupation" && (
                    <p className="text-xs text-parchment/35 mt-1.5">Holds territory. Required to defend sectors you own.</p>
                  )}
                </div>

                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-parchment/40 uppercase tracking-widest block mb-1.5">Deploy to Zone</label>
                    <select
                      className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm text-parchment/85"
                      value={deployZone}
                      onChange={(e) => { setDeployZone(e.target.value); setDeploySector(""); }}>
                      <option value="">-- select zone --</option>
                      {Array.from(new Set(mySectors.map(s => s.zone_key))).map((zk) => (
                        <option key={zk} value={zk}>{fmtKey(zk)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-parchment/40 uppercase tracking-widest block mb-1.5">Sector</label>
                    <select
                      className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm text-parchment/85"
                      value={deploySector}
                      disabled={!deployZone}
                      onChange={(e) => setDeploySector(e.target.value)}>
                      <option value="">-- select sector --</option>
                      {mySectors.filter(s => s.zone_key === deployZone).map((s) => (
                        <option key={s.sector_key} value={s.sector_key}>{s.sector_key.toUpperCase()}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {deployResult && (
                <p className={`text-sm px-3 py-2 rounded border ${
                  deployResult.startsWith("Error")
                    ? "border-blood/30 bg-blood/10 text-blood/80"
                    : "border-brass/30 bg-brass/10 text-brass/80"
                }`}>{deployResult}</p>
              )}

              <button
                onClick={deployUnit}
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

        {/* ── Pending Orders this Round ── */}
        {myMoves.length > 0 && (
          <Card title={`Round ${roundNumber} Orders`}>
            <div className="space-y-1.5">
              {myMoves.map((m) => {
                const unit = myUnits.find((u) => u.id === m.unit_id);
                return (
                  <div key={m.id} className="flex items-center gap-3 text-sm px-2 py-1.5 rounded bg-parchment/5 border border-parchment/10">
                    {unit && (
                      <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${
                        unit.unit_type === "scout"
                          ? "bg-blue-500/15 border-blue-400/30 text-blue-300"
                          : "bg-brass/15 border-brass/30 text-brass"
                      }`}>{unit.unit_type}</span>
                    )}
                    <span className="text-parchment/50 text-xs font-mono">
                      {fmtKey(m.from_zone_key)}/{m.from_sector_key.toUpperCase()}
                    </span>
                    <span className="text-parchment/25">→</span>
                    <span className="text-parchment/75 text-xs font-mono">
                      {fmtKey(m.to_zone_key)}/{m.to_sector_key.toUpperCase()}
                    </span>
                    <span className={`ml-auto text-xs font-mono px-1.5 py-0.5 rounded border ${
                      m.move_type === "deep_strike" ? "border-brass/40 text-brass/70" :
                      m.move_type === "recon"       ? "border-blue-400/30 text-blue-300/70" :
                                                       "border-parchment/15 text-parchment/30"
                    }`}>{m.move_type}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* ── Sector ownership grid ── */}
        {effectiveZones.length > 0 && sectors.length > 0 && (
          <div className="grid md:grid-cols-2 gap-6">
            {effectiveZones.map((z) => (
              <Card key={z.key} title={z.name}>
                <div className="grid grid-cols-4 gap-1.5">
                  {SECTOR_KEYS.map((sk) => {
                    const s       = sectorAt(z.key, sk);
                    const visible = isSectorVisible(s);
                    const owner   = ownerLabel(s?.owner_user_id ?? null);
                    const unitHere = myUnits.filter(
                      (u) => u.zone_key === z.key && u.sector_key === sk
                    );
                    return (
                      <div key={sk}
                        className={`rounded border bg-void/60 px-2 py-2 flex flex-col items-center gap-0.5 ${
                          owner?.mine ? "border-brass/40" : "border-brass/20"
                        }`}>
                        <span className="font-mono text-xs text-brass/80">{sk.toUpperCase()}</span>
                        {s?.fortified && visible && <span className="text-xs text-blood leading-none">FORT</span>}
                        <span className={`text-xs leading-tight text-center ${
                          !visible          ? "text-parchment/25 italic" :
                          owner?.mine       ? "text-brass/80 font-semibold" :
                          owner             ? "text-blood/70" :
                                             "text-parchment/50"
                        }`}>
                          {!visible ? "?" : owner ? owner.label : "Open"}
                        </span>
                        {unitHere.length > 0 && (
                          <div className="flex gap-0.5 mt-0.5 flex-wrap justify-center">
                            {unitHere.map((u) => (
                              <span key={u.id} className={`text-xs leading-none ${
                                u.unit_type === "scout" ? "text-blue-300" : "text-brass"
                              }`} title={u.unit_type}>
                                {u.unit_type === "scout" ? "◈" : "⬡"}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {fogEnabled && (
                  <p className="mt-2 text-xs text-parchment/30 italic">
                    Fog of war — unrevealed sectors shown as unknown.
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}

        {/* Fallback grid when map_json has no zones */}
        {zones.length === 0 && sectors.length > 0 && (() => {
          const uniqueZones = Array.from(new Set(sectors.map((s) => s.zone_key)));
          return (
            <div className="grid md:grid-cols-2 gap-6">
              {uniqueZones.map((zk) => (
                <Card key={zk} title={fmtKey(zk)}>
                  <div className="grid grid-cols-4 gap-1.5">
                    {SECTOR_KEYS.map((sk) => {
                      const s       = sectorAt(zk, sk);
                      const visible = isSectorVisible(s);
                      const owner   = ownerLabel(s?.owner_user_id ?? null);
                      return (
                        <div key={sk}
                          className="rounded border border-brass/20 bg-void/60 px-2 py-2 flex flex-col items-center gap-0.5">
                          <span className="font-mono text-xs text-brass/80">{sk.toUpperCase()}</span>
                          {s?.fortified && visible && <span className="text-xs text-blood leading-none">FORT</span>}
                          <span className={`text-xs ${
                            !visible     ? "text-parchment/25 italic" :
                            owner?.mine  ? "text-brass/80" :
                            owner        ? "text-blood/70" :
                                           "text-parchment/50"
                          }`}>
                            {!visible ? "?" : owner ? owner.label : "Open"}
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
