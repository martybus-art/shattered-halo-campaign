// apps/web/src/app/lead/page.tsx
// Lead Controls — campaign management for lead/admin roles.
// Stage order: spend -> recon -> movement -> missions -> results -> publish
// Instability uses a two-phase roll/confirm to prevent accidental double-application.
//
// changelog:
//   2026-03-16 -- FEATURE: Movement Orders Console (shown during movement/recon stage).
//                 Lists every player, their active units, and whether each unit has
//                 a move submitted this round. Traffic-light dot per player:
//                   Red   = no orders submitted for any unit.
//                   Amber = some units ordered, some not.
//                   Green = all active units have orders.
//                   Grey  = player has no active units.
//                 Full move detail on expand: from/to/move_type per unit.
//                 Overall readiness badge + advisory warning on Advance Stage button.
//   2026-03-16 -- FEATURE: Engagement Readiness Console (shown during conflicts /
//                 missions / results stages). Per-conflict sub-indicators:
//                   Mission dot: Red=unassigned, Green=assigned.
//                   Result dot:  Red=none, Amber=one side reported, Green=confirmed.
//                 Overall badge drives the advisory on Advance Stage.

"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// ---- Types ------------------------------------------------------------------

type Campaign = {
  id: string;
  name: string;
  phase: number;
  round_number: number;
  instability: number;
  map_id: string | null;
};

type Round = { stage: string };
type MapZone = { key: string; name: string };

type InstabilityRoll = {
  d10: number;
  threshold_band: number;
  current_instability: number;
  new_instability: number;
  event_name: string;
  public_text: string;
  effect: { type: string; amount?: number; instruction?: string };
  auto_effects: string[];
  needs_zone_selection: boolean;
  needs_zone_destroy: boolean;
  destroy_count: number;
};

// Movement console
type UnitRow = {
  id: string;
  unit_type: string;
  zone_key: string;
  sector_key: string;
};

type MoveRow = {
  unit_id: string;
  from_zone_key: string;
  from_sector_key: string;
  to_zone_key: string;
  to_sector_key: string;
  move_type: string;
};

type PlayerMoveStatus = {
  user_id: string;
  commander_name: string | null;
  faction_name: string | null;
  role: string;
  units: UnitRow[];
  moves: MoveRow[];
};

// Engagement console
type ConflictStatus = {
  id: string;
  zone_key: string;
  sector_key: string;
  player_a: string;
  player_b: string;
  mission_id: string | null;
  mission_status: string;
  mission_name: string | null;
  conflict_status: string;
  result_confirmed: boolean;
  result_reported_by: string | null;
  winner_user_id: string | null;
  twist_tags: string[];
};

// ---- Helpers ----------------------------------------------------------------

function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name);
}

function fmtKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type DotColor = "red" | "amber" | "green" | "grey";

function StatusDot({ color, size = "md" }: { color: DotColor; size?: "sm" | "md" }) {
  const sz = size === "sm" ? "w-2 h-2" : "w-3 h-3";
  const cl =
    color === "green" ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.7)]"
    : color === "amber" ? "bg-yellow-400 shadow-[0_0_6px_rgba(234,179,8,0.7)]"
    : color === "red"   ? "bg-blood shadow-[0_0_6px_rgba(153,27,27,0.7)]"
    :                     "bg-parchment/20";
  return <span className={`inline-block rounded-full shrink-0 ${sz} ${cl}`} />;
}

// ---- Component --------------------------------------------------------------

export default function LeadControls() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [campaignId, setCampaignId] = useState<string>("");
  const [campaign, setCampaign]     = useState<Campaign | null>(null);
  const [round, setRound]           = useState<Round | null>(null);
  const [role, setRole]             = useState<string>("player");
  const [mapZones, setMapZones]     = useState<MapZone[]>([]);

  // Movement console
  const [playerMoveStatuses, setPlayerMoveStatuses] = useState<PlayerMoveStatus[]>([]);
  const [expandedPlayers, setExpandedPlayers]       = useState<Set<string>>(new Set());

  // Engagement console
  const [conflictStatuses, setConflictStatuses]   = useState<ConflictStatus[]>([]);
  const [expandedConflicts, setExpandedConflicts] = useState<Set<string>>(new Set());

  // Late player allocation
  const [lateUserId, setLateUserId]   = useState<string>("");
  const [startStatus, setStartStatus] = useState<string>("");

  // Generic action status
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

  // Instability two-phase
  const [instRoll, setInstRoll]                   = useState<InstabilityRoll | null>(null);
  const [instRolling, setInstRolling]             = useState(false);
  const [instConfirming, setInstConfirming]       = useState(false);
  const [instSelectedZone, setInstSelectedZone]   = useState<string>("");
  const [instSelectedZones, setInstSelectedZones] = useState<string[]>([]);
  const [instStatus, setInstStatus]               = useState<string>("");

  // ---- Load -----------------------------------------------------------------

  const load = useCallback(async (cid: string) => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return;

    const { data: mem } = await supabase
      .from("campaign_members").select("role")
      .eq("campaign_id", cid).eq("user_id", uid).single();
    setRole(mem?.role ?? "player");

    const { data: c, error: cErr } = await supabase
      .from("campaigns")
      .select("id,name,phase,round_number,instability,map_id")
      .eq("id", cid).single();

    if (cErr || !c) {
      setActionStatus(s => ({ ...s, load: cErr?.message ?? "Campaign not found" }));
      setCampaign(null); setRound(null); return;
    }
    setCampaign(c as Campaign);

    const { data: r } = await supabase
      .from("rounds").select("stage")
      .eq("campaign_id", cid).eq("round_number", c.round_number).maybeSingle();
    setRound(r);
    const currentStage = r?.stage ?? null;

    // Map zones for instability selector
    if ((c as any).map_id) {
      const { data: mapRow } = await supabase
        .from("maps").select("map_json").eq("id", (c as any).map_id).maybeSingle();
      setMapZones((mapRow?.map_json as any)?.zones ?? []);
    }

    // ---- Movement console data (always loaded for all stages) ---------------
    const { data: allMembers } = await supabase
      .from("campaign_members").select("user_id,commander_name,faction_name,role")
      .eq("campaign_id", cid);

    const { data: allUnits } = await supabase
      .from("units").select("id,unit_type,zone_key,sector_key,user_id")
      .eq("campaign_id", cid).eq("status", "active");

    const { data: allMoves } = await supabase
      .from("moves")
      .select("unit_id,user_id,from_zone_key,from_sector_key,to_zone_key,to_sector_key,move_type")
      .eq("campaign_id", cid).eq("round_number", c.round_number);

    setPlayerMoveStatuses(
      (allMembers ?? []).map((m: any) => ({
        user_id:        m.user_id,
        commander_name: m.commander_name,
        faction_name:   m.faction_name,
        role:           m.role,
        units:          (allUnits  ?? []).filter((u: any) => u.user_id === m.user_id),
        moves:          (allMoves  ?? []).filter((mv: any) => mv.user_id === m.user_id),
      }))
    );

    // ---- Engagement console data (missions/results stages) --------
    const engagementStages = ["missions", "results"];
    if (engagementStages.includes(currentStage ?? "")) {
      const { data: conflicts } = await supabase
        .from("conflicts")
        .select("id,zone_key,sector_key,player_a,player_b,mission_id,mission_status,status,twist_tags")
        .eq("campaign_id", cid).eq("round_number", c.round_number);

      const cIds = (conflicts ?? []).map((x: any) => x.id);

      const { data: battleResults } = cIds.length
        ? await supabase.from("battle_results")
            .select("conflict_id,confirmed,reported_by,winner_user_id").in("conflict_id", cIds)
        : { data: [] };

      const mIds = (conflicts ?? []).filter((x: any) => x.mission_id).map((x: any) => x.mission_id);
      const { data: missionRows } = mIds.length
        ? await supabase.from("missions").select("id,name").in("id", mIds)
        : { data: [] };

      const missionName = new Map((missionRows ?? []).map((m: any) => [m.id, m.name]));
      const resultByC   = new Map((battleResults ?? []).map((br: any) => [br.conflict_id, br]));

      setConflictStatuses(
        (conflicts ?? []).map((c: any) => {
          const res = resultByC.get(c.id) ?? null;
          return {
            id:                 c.id,
            zone_key:           c.zone_key,
            sector_key:         c.sector_key,
            player_a:           c.player_a,
            player_b:           c.player_b,
            mission_id:         c.mission_id,
            mission_status:     c.mission_status,
            mission_name:       c.mission_id ? (missionName.get(c.mission_id) ?? null) : null,
            conflict_status:    c.status,
            result_confirmed:   res?.confirmed ?? false,
            result_reported_by: res?.reported_by ?? null,
            winner_user_id:     res?.winner_user_id ?? null,
            twist_tags:         c.twist_tags ?? [],
          };
        })
      );
    } else {
      setConflictStatuses([]);
    }
  }, [supabase]);

  useEffect(() => { const q = getQueryParam("campaign"); if (q) setCampaignId(q); }, []);
  useEffect(() => { if (campaignId) load(campaignId); }, [campaignId, load]);

  // ---- Auth helper ----------------------------------------------------------
  const getToken = async (): Promise<string | null> => {
    const { data: sess } = await supabase.auth.getSession();
    return sess.session?.access_token ?? null;
  };

  // ---- Generic edge function caller -----------------------------------------
  const callFn = async (fn: string, key: string, extraBody?: Record<string, unknown>) => {
    setActionStatus(s => ({ ...s, [key]: "Working..." }));
    const token = await getToken();
    if (!token) { setActionStatus(s => ({ ...s, [key]: "Session expired." })); return; }

    const { data, error } = await supabase.functions.invoke(fn, {
      body: { campaign_id: campaignId, ...extraBody },
      headers: { Authorization: `Bearer ${token}` },
    });

    if (error) { setActionStatus(s => ({ ...s, [key]: `Error: ${error.message}` })); return; }
    if (!data?.ok) { setActionStatus(s => ({ ...s, [key]: `Failed: ${data?.error ?? "Unknown"}` })); return; }

    const detail = data.stage
      ? `Stage -> ${data.stage}${data.conflicts_created ? ` (${data.conflicts_created} conflict(s) detected)` : ""}`
      : "Done.";
    setActionStatus(s => ({ ...s, [key]: detail }));
    await load(campaignId);
  };

  // ---- Start campaign -------------------------------------------------------
  const startCampaign = async () => {
    setStartStatus("Starting...");
    const token = await getToken();
    if (!token) { setStartStatus("Session expired."); return; }
    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "initial" },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) { setStartStatus(`Error: ${error.message}`); return; }
    setStartStatus(`Started. ${data?.allocated ?? 0} player(s) allocated.`);
    await load(campaignId);
  };

  const allocateLatePlayer = async () => {
    if (!lateUserId.trim()) { setStartStatus("Enter the late player's user_id."); return; }
    setStartStatus("Allocating...");
    const token = await getToken();
    if (!token) { setStartStatus("Session expired."); return; }
    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "late", late_user_id: lateUserId.trim() },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) { setStartStatus(`Error: ${error.message}`); return; }
    setStartStatus(`Allocated. ${data?.allocated ?? 0} player(s) updated.`);
    await load(campaignId);
  };

  // ---- Instability roll/confirm ---------------------------------------------
  const rollInstability = async () => {
    setInstRolling(true); setInstRoll(null); setInstStatus("");
    setInstSelectedZone(""); setInstSelectedZones([]);
    const token = await getToken();
    if (!token) { setInstStatus("Session expired."); setInstRolling(false); return; }
    const { data, error } = await supabase.functions.invoke("apply-instability", {
      body: { campaign_id: campaignId, mode: "roll" },
      headers: { Authorization: `Bearer ${token}` },
    });
    setInstRolling(false);
    if (error) { setInstStatus(`Error: ${error.message}`); return; }
    if (!data?.ok) { setInstStatus(`Failed: ${data?.error ?? "Unknown"}`); return; }
    setInstRoll(data as InstabilityRoll);
  };

  const confirmInstability = async () => {
    if (!instRoll) return;
    setInstConfirming(true); setInstStatus("");
    const token = await getToken();
    if (!token) { setInstStatus("Session expired."); setInstConfirming(false); return; }
    const { data, error } = await supabase.functions.invoke("apply-instability", {
      body: {
        campaign_id: campaignId, mode: "confirm",
        d10_result: instRoll.d10, expected_instability: instRoll.current_instability,
        selected_zone: instSelectedZone, selected_zones: instSelectedZones,
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    setInstConfirming(false);
    if (error) { setInstStatus(`Error: ${error.message}`); return; }
    if (!data?.ok) { setInstStatus(`Failed: ${data?.error ?? "Unknown"}`); return; }
    setInstStatus(
      `Applied. Instability now ${data.instability}/10.` +
      (data.phase_changed ? ` Phase -> ${data.new_phase}.` : "")
    );
    setInstRoll(null);
    await load(campaignId);
  };

  const toggleZone = (key: string) =>
    setInstSelectedZones(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

  // ---- Expand toggles -------------------------------------------------------
  const togglePlayer   = (id: string) => setExpandedPlayers(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleConflict = (id: string) => setExpandedConflicts(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ---- Derived state --------------------------------------------------------
  const allowed    = role === "lead" || role === "admin";
  const stageLabel = round?.stage ?? "unknown";

  const instNeedsZone    = instRoll?.needs_zone_selection ?? false;
  const instNeedsMulti   = instRoll?.needs_zone_destroy ?? false;
  const instDestroyCount = instRoll?.destroy_count ?? 1;
  const instCanConfirm   =
    instRoll && !instConfirming &&
    (!instNeedsZone  || instSelectedZone.length > 0) &&
    (!instNeedsMulti || instSelectedZones.length >= instDestroyCount);

  const instBandLabel = instRoll
    ? instRoll.threshold_band === 8 ? "Tier III (8+)" : instRoll.threshold_band === 4 ? "Tier II (4-7)" : "Tier I (0-3)"
    : "";

  // Player dot colour
  const playerDotColor = (p: PlayerMoveStatus): DotColor => {
    if (p.units.length === 0) return "grey";
    if (p.moves.length === 0) return "red";
    if (p.moves.length < p.units.length) return "amber";
    return "green";
  };

  const playersWithUnits  = playerMoveStatuses.filter(p => p.units.length > 0);
  const playersFullyMoved = playersWithUnits.filter(p => p.moves.length >= p.units.length);
  const movementReady     = playersWithUnits.length > 0 && playersFullyMoved.length === playersWithUnits.length;

  // Conflict dots
  const missionDotColor = (c: ConflictStatus): DotColor => c.mission_status === "assigned" ? "green" : "red";
  const resultDotColor  = (c: ConflictStatus): DotColor =>
    c.result_confirmed ? "green" : c.result_reported_by ? "amber" : "red";

  const allMissionsAssigned = conflictStatuses.length > 0 && conflictStatuses.every(c => c.mission_status === "assigned");
  const allResultsConfirmed = conflictStatuses.length > 0 && conflictStatuses.every(c => c.result_confirmed);
  const engagementReady     = allMissionsAssigned && allResultsConfirmed;

  // Member name lookup (built from playerMoveStatuses which has all members)
  const memberNameMap = useMemo(() => {
    const m = new Map<string, string>();
    playerMoveStatuses.forEach(p =>
      m.set(p.user_id, p.commander_name ?? p.faction_name ?? p.user_id.slice(0, 8) + "...")
    );
    return m;
  }, [playerMoveStatuses]);

  const STAGES = ["spend","recon","movement","missions","results","publish"];

  // ---- Render ---------------------------------------------------------------
  return (
    <Frame title="Lead Controls" campaignId={campaignId} role={role} currentPage="lead">
      <div className="space-y-6">

        {/* Campaign Status */}
        <Card title="Campaign Status">
          {campaign ? (
            <div className="text-sm text-parchment/80 space-y-1">
              <div><span className="text-brass">Name:</span> {campaign.name}</div>
              <div>
                <span className="text-brass">Phase:</span> {campaign.phase}&nbsp;&nbsp;
                <span className="text-brass">Round:</span> {campaign.round_number}&nbsp;&nbsp;
                <span className="text-brass">Stage:</span>{" "}
                <span className="font-mono text-brass/80 uppercase tracking-wider text-xs">{stageLabel}</span>
              </div>
              <div>
                <span className="text-brass">Instability:</span>{" "}
                <span className={campaign.instability >= 8 ? "text-blood font-semibold" : campaign.instability >= 4 ? "text-yellow-500/80" : "text-parchment/80"}>
                  {campaign.instability}/10
                </span>
              </div>
              <div><span className="text-brass">Role:</span> {role}</div>
              {!allowed && <p className="mt-2 text-blood/80 text-xs">Not authorised for lead controls.</p>}
            </div>
          ) : (
            <p className="text-parchment/50 text-sm">{campaignId ? "Loading..." : "No campaign ID in URL."}</p>
          )}
          {actionStatus.load && <p className="mt-2 text-blood/70 text-xs">{actionStatus.load}</p>}
        </Card>

        {campaign && (
          <div className="space-y-6">

            {/* ============================================================
                MOVEMENT ORDERS CONSOLE
                Visible: movement + recon stages
            ============================================================ */}
            {(stageLabel === "movement" || stageLabel === "recon") && (
              <Card title="Movement Orders Console">
                <div className="space-y-1">

                  {/* Header */}
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-parchment/40 uppercase tracking-widest font-mono">
                      Round {campaign.round_number} / {stageLabel}
                    </p>
                    <span className={`text-xs font-mono px-2 py-0.5 rounded border ${
                      movementReady
                        ? "border-green-500/40 bg-green-500/10 text-green-400"
                        : playersFullyMoved.length > 0
                        ? "border-yellow-400/40 bg-yellow-400/10 text-yellow-400"
                        : "border-blood/40 bg-blood/10 text-blood/80"
                    }`}>
                      {movementReady ? `All ${playersWithUnits.length} ready` : `${playersFullyMoved.length} / ${playersWithUnits.length} ready`}
                    </span>
                  </div>

                  {playerMoveStatuses.length === 0 && (
                    <p className="text-parchment/30 text-sm italic px-1">No players found.</p>
                  )}

                  {playerMoveStatuses.map((p) => {
                    const dotColor   = playerDotColor(p);
                    const isExpanded = expandedPlayers.has(p.user_id);
                    const label      = p.commander_name ?? p.faction_name ?? p.user_id.slice(0, 8) + "...";
                    return (
                      <div key={p.user_id} className="rounded-lg border border-brass/15 bg-iron/60 overflow-hidden">
                        <button
                          onClick={() => togglePlayer(p.user_id)}
                          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-brass/5 transition-colors text-left"
                        >
                          <StatusDot color={dotColor} />
                          <span className="flex-1 text-sm text-parchment/85 font-semibold">{label}</span>
                          {p.role === "lead" && (
                            <span className="text-xs font-mono text-brass/40 border border-brass/20 px-1.5 py-0.5 rounded">lead</span>
                          )}
                          <span className={`text-xs font-mono ml-1 ${
                            dotColor === "green" ? "text-green-400" : dotColor === "amber" ? "text-yellow-400" : dotColor === "grey" ? "text-parchment/25" : "text-blood/70"
                          }`}>
                            {p.units.length === 0 ? "no units" : `${p.moves.length}/${p.units.length} order${p.units.length !== 1 ? "s" : ""}`}
                          </span>
                          <span className="text-parchment/25 text-xs ml-2">{isExpanded ? "v" : ">"}</span>
                        </button>

                        {isExpanded && (
                          <div className="border-t border-brass/10 px-4 py-3 space-y-2 bg-void/40">
                            {p.units.length === 0 ? (
                              <p className="text-parchment/30 text-xs italic">No active units.</p>
                            ) : p.units.map((u) => {
                              const mv = p.moves.find(m => m.unit_id === u.id);
                              return (
                                <div key={u.id} className="flex items-center gap-3 text-xs">
                                  <StatusDot color={mv ? "green" : "red"} size="sm" />
                                  <span className={`px-1.5 py-0.5 rounded border font-mono uppercase ${
                                    u.unit_type === "scout" ? "bg-blue-500/15 border-blue-400/30 text-blue-300" : "bg-brass/15 border-brass/30 text-brass"
                                  }`}>{u.unit_type}</span>
                                  <span className="text-parchment/50">{fmtKey(u.zone_key)} / {u.sector_key.toUpperCase()}</span>
                                  {mv ? (
                                    <>
                                      <span className="text-parchment/25">-&gt;</span>
                                      <span className="text-parchment/80 font-semibold">{fmtKey(mv.to_zone_key)} / {mv.to_sector_key.toUpperCase()}</span>
                                      <span className={`ml-auto px-1.5 py-0.5 rounded border font-mono ${
                                        mv.move_type === "deep_strike" ? "border-brass/40 text-brass/70"
                                        : mv.move_type === "recon" ? "border-blue-400/30 text-blue-300/70"
                                        : "border-parchment/15 text-parchment/30"
                                      }`}>{mv.move_type}</span>
                                    </>
                                  ) : (
                                    <span className="ml-auto text-blood/50 italic">no order</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Legend */}
                  <div className="flex flex-wrap gap-x-5 gap-y-1 pt-3 border-t border-brass/10 mt-2 text-xs text-parchment/40">
                    {(["green","amber","red","grey"] as DotColor[]).map(c => (
                      <span key={c} className="flex items-center gap-1.5">
                        <StatusDot color={c} size="sm" />
                        {c === "green" ? "All orders in" : c === "amber" ? "Partial" : c === "red" ? "No orders" : "No units"}
                      </span>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {/* ============================================================
                ENGAGEMENT READINESS CONSOLE
                Visible: missions / results stages
            ============================================================ */}
            {["missions","results"].includes(stageLabel) && (
              <Card title="Engagement Readiness Console">
                <div className="space-y-1">

                  {/* Header */}
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-parchment/40 uppercase tracking-widest font-mono">
                      Round {campaign.round_number} / {stageLabel}
                    </p>
                    <span className={`text-xs font-mono px-2 py-0.5 rounded border ${
                      engagementReady ? "border-green-500/40 bg-green-500/10 text-green-400"
                      : allResultsConfirmed ? "border-green-500/40 bg-green-500/10 text-green-400"
                      : conflictStatuses.some(c => c.result_reported_by) ? "border-yellow-400/40 bg-yellow-400/10 text-yellow-400"
                      : "border-blood/40 bg-blood/10 text-blood/80"
                    }`}>
                      {conflictStatuses.length === 0 ? "No conflicts"
                      : engagementReady ? "All resolved"
                      : `${conflictStatuses.filter(c => c.result_confirmed).length}/${conflictStatuses.length} resolved`}
                    </span>
                  </div>

                  {conflictStatuses.length === 0 && (
                    <p className="text-parchment/30 text-sm italic px-1">No conflicts this round. Safe to advance.</p>
                  )}

                  {conflictStatuses.map((c) => {
                    const isExpanded  = expandedConflicts.has(c.id);
                    const overallDot: DotColor = c.result_confirmed ? "green" : c.result_reported_by ? "amber" : "red";
                    const pAName = memberNameMap.get(c.player_a) ?? c.player_a.slice(0, 8);
                    const pBName = memberNameMap.get(c.player_b) ?? c.player_b.slice(0, 8);

                    return (
                      <div key={c.id} className="rounded-lg border border-brass/15 bg-iron/60 overflow-hidden">
                        <button
                          onClick={() => toggleConflict(c.id)}
                          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-brass/5 transition-colors text-left"
                        >
                          <StatusDot color={overallDot} />
                          <span className="flex-1 text-sm text-parchment/85 font-semibold">
                            {fmtKey(c.zone_key)} / {c.sector_key.toUpperCase()}
                          </span>
                          <span className="text-xs text-parchment/40 font-mono">{pAName} vs {pBName}</span>
                          <span className="text-parchment/25 text-xs ml-2">{isExpanded ? "v" : ">"}</span>
                        </button>

                        {isExpanded && (
                          <div className="border-t border-brass/10 px-4 py-3 space-y-2.5 bg-void/40">
                            {/* Mission */}
                            <div className="flex items-center gap-3 text-xs">
                              <StatusDot color={missionDotColor(c)} size="sm" />
                              <span className="text-parchment/50 w-16 shrink-0">Mission</span>
                              {c.mission_status === "assigned"
                                ? <span className="text-green-400 font-semibold">{c.mission_name ?? "Assigned"}</span>
                                : <span className="text-blood/70 italic">Not yet assigned</span>}
                              {c.twist_tags.length > 0 && (
                                <span className="ml-auto flex gap-1">
                                  {c.twist_tags.map(t => (
                                    <span key={t} className="px-1.5 py-0.5 rounded bg-blood/10 border border-blood/20 text-blood/60 font-mono text-xs">{t}</span>
                                  ))}
                                </span>
                              )}
                            </div>
                            {/* Result */}
                            <div className="flex items-center gap-3 text-xs">
                              <StatusDot color={resultDotColor(c)} size="sm" />
                              <span className="text-parchment/50 w-16 shrink-0">Result</span>
                              {c.result_confirmed
                                ? <span className="text-green-400 font-semibold">
                                    {c.winner_user_id ? `${memberNameMap.get(c.winner_user_id) ?? "Winner"} victorious` : "Draw"}
                                  </span>
                                : c.result_reported_by
                                ? <span className="text-yellow-400">
                                    Reported by {memberNameMap.get(c.result_reported_by) ?? "player"} - awaiting opponent
                                  </span>
                                : <span className="text-blood/70 italic">No result submitted</span>}
                            </div>
                            {/* Players footer */}
                            <div className="text-xs text-parchment/30 border-t border-brass/10 pt-2 flex gap-4">
                              <span><span className="text-parchment/45">Attacker:</span> {pAName}</span>
                              <span><span className="text-parchment/45">Defender:</span> {pBName}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Legend */}
                  <div className="flex flex-wrap gap-x-5 gap-y-1 pt-3 border-t border-brass/10 mt-2 text-xs text-parchment/40">
                    {(["green","amber","red"] as DotColor[]).map(c => (
                      <span key={c} className="flex items-center gap-1.5">
                        <StatusDot color={c} size="sm" />
                        {c === "green" ? "Fully resolved" : c === "amber" ? "Awaiting confirmation" : "No result yet"}
                      </span>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {/* ---- Action grid ---------------------------------------------- */}
            <div className="grid md:grid-cols-2 gap-6">

              {/* Start Campaign */}
              <Card title="Start Campaign">
                <p className="text-parchment/70 text-sm leading-relaxed">
                  Allocates secret starting locations for all current members. Run once when ready to begin.
                </p>
                <button disabled={!allowed} onClick={startCampaign}
                  className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm disabled:opacity-40 transition-colors">
                  Start Campaign
                </button>
                {startStatus && (
                  <p className={`mt-2 text-xs ${startStatus.startsWith("Error") ? "text-blood/70" : "text-brass/70"}`}>{startStatus}</p>
                )}
              </Card>

              {/* Late Player Allocation */}
              <Card title="Late Player Allocation">
                <p className="text-parchment/70 text-sm leading-relaxed">
                  Reassigns one sector from the dominant player to a late joiner. Paste the late player's{" "}
                  <span className="font-mono text-brass/80">user_id</span> UUID.
                </p>
                <input
                  className="mt-3 w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm focus:outline-none focus:border-brass/60"
                  value={lateUserId} onChange={(e) => setLateUserId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" disabled={!allowed}
                />
                <button disabled={!allowed || !lateUserId.trim()} onClick={allocateLatePlayer}
                  className="mt-2 w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-sm disabled:opacity-40 transition-colors">
                  Allocate Late Player
                </button>
              </Card>

              {/* Advance Stage */}
              <Card title="Advance Stage">
                <p className="text-parchment/70 text-sm leading-relaxed">
                  Moves through:{" "}
                  <span className="text-brass font-mono text-xs">spend -&gt; recon -&gt; movement -&gt; missions -&gt; results -&gt; publish</span>.
                  Advancing from <span className="text-brass">movement</span> auto-detects conflicts.
                </p>
                <p className="mt-1 text-xs text-parchment/50">
                  Current:{" "}
                  <span className="uppercase tracking-wider font-mono text-brass/70">{stageLabel}</span>
                  {" "}-&gt;{" "}
                  <span className="uppercase tracking-wider font-mono text-parchment/50">
                    {stageLabel === "publish" ? "next round / spend"
                      : STAGES[STAGES.indexOf(stageLabel) + 1] ?? "?"}
                  </span>
                </p>

                {/* Advisory warnings */}
                {stageLabel === "movement" && !movementReady && playersWithUnits.length > 0 && (
                  <p className="mt-2 text-xs text-yellow-400/80 border border-yellow-400/20 bg-yellow-400/5 rounded px-2 py-1.5">
                    {playersWithUnits.length - playersFullyMoved.length} player(s) have not submitted all orders.
                    You can still advance - their units will hold position.
                  </p>
                )}
                {stageLabel === "results" && conflictStatuses.length > 0 && !allResultsConfirmed && (
                  <p className="mt-2 text-xs text-yellow-400/80 border border-yellow-400/20 bg-yellow-400/5 rounded px-2 py-1.5">
                    {conflictStatuses.filter(c => !c.result_confirmed).length} conflict(s) not fully resolved.
                    Advancing will leave them unresolved this round.
                  </p>
                )}
                {stageLabel === "missions" && !allMissionsAssigned && conflictStatuses.length > 0 && (
                  <p className="mt-2 text-xs text-yellow-400/80 border border-yellow-400/20 bg-yellow-400/5 rounded px-2 py-1.5">
                    {conflictStatuses.filter(c => c.mission_status !== "assigned").length} conflict(s) have no mission assigned yet.
                    Use "Assign Missions" before advancing.
                  </p>
                )}

                <button disabled={!allowed} onClick={() => callFn("advance-round", "advance")}
                  className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm disabled:opacity-40 transition-colors">
                  Advance Stage
                </button>
                {actionStatus.advance && (
                  <p className={`mt-2 text-xs ${actionStatus.advance.startsWith("Error") || actionStatus.advance.startsWith("Failed") ? "text-blood/70" : "text-brass/70"}`}>
                    {actionStatus.advance}
                  </p>
                )}
              </Card>

              {/* Assign Missions */}
              <Card title="Assign Missions">
                <p className="text-parchment/70 text-sm leading-relaxed">
                  Assigns missions to all conflicts in the current round, respecting NIP preference
                  votes submitted by players during the Spend phase.
                </p>
                <button disabled={!allowed} onClick={() => callFn("assign-missions", "missions")}
                  className="mt-3 w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-sm disabled:opacity-40 transition-colors">
                  Assign Missions
                </button>
                {actionStatus.missions && (
                  <p className={`mt-2 text-xs ${actionStatus.missions.startsWith("Error") || actionStatus.missions.startsWith("Failed") ? "text-blood/70" : "text-brass/70"}`}>
                    {actionStatus.missions}
                  </p>
                )}
              </Card>

              {/* Apply Instability */}
              <Card title="Apply Instability">
                <div className="space-y-3">
                  <p className="text-parchment/70 text-sm leading-relaxed">
                    Roll a d10 against the current instability band, preview the event, then confirm to apply.
                    Some events require a zone designation before confirming.
                  </p>

                  {!instRoll && (
                    <>
                      <button disabled={!allowed || instRolling} onClick={rollInstability}
                        className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm font-semibold disabled:opacity-40 transition-colors">
                        {instRolling
                          ? <span className="flex items-center justify-center gap-2"><span className="w-3.5 h-3.5 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />Rolling...</span>
                          : "Roll Instability d10"}
                      </button>
                      {instStatus && <p className={`text-xs ${instStatus.startsWith("Error") ? "text-blood/70" : "text-brass/70"}`}>{instStatus}</p>}
                    </>
                  )}

                  {instRoll && (
                    <div className="rounded border border-brass/30 bg-black/20 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-brass text-xs uppercase tracking-widest font-semibold">{instBandLabel} / Roll: {instRoll.d10}</p>
                          <p className="text-parchment/90 font-semibold mt-0.5">{instRoll.event_name}</p>
                        </div>
                        <span className={`text-2xl font-mono font-bold ${instRoll.new_instability >= 8 ? "text-blood" : instRoll.new_instability >= 4 ? "text-yellow-500/80" : "text-brass/70"}`}>
                          {instRoll.new_instability}/10
                        </span>
                      </div>

                      <p className="text-xs text-parchment/65 italic leading-relaxed border-l-2 border-brass/20 pl-3">{instRoll.public_text}</p>

                      {instRoll.auto_effects.length > 0 && (
                        <div>
                          <p className="text-xs text-brass/70 uppercase tracking-wider mb-1">Auto-applied effects</p>
                          <ul className="space-y-0.5">
                            {instRoll.auto_effects.map((e, i) => (
                              <li key={i} className="text-xs text-parchment/70 flex gap-2"><span className="text-brass/50">*</span>{e}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {instNeedsZone && !instNeedsMulti && (
                        <div>
                          <p className="text-xs text-blood/80 uppercase tracking-wider mb-1.5 font-semibold">Designate affected zone (required)</p>
                          {mapZones.length > 0 ? (
                            <select className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm focus:outline-none focus:border-brass/60"
                              value={instSelectedZone} onChange={(e) => setInstSelectedZone(e.target.value)}>
                              <option value="">-- Select zone --</option>
                              {mapZones.map(z => <option key={z.key} value={z.key}>{z.name}</option>)}
                            </select>
                          ) : (
                            <input className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm"
                              placeholder="Enter zone key" value={instSelectedZone} onChange={(e) => setInstSelectedZone(e.target.value)} />
                          )}
                        </div>
                      )}

                      {instNeedsMulti && (
                        <div>
                          <p className="text-xs text-blood/80 uppercase tracking-wider mb-1.5 font-semibold">
                            Select {instDestroyCount} zone(s) to destroy ({instSelectedZones.length}/{instDestroyCount})
                          </p>
                          <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                            {mapZones.length > 0 ? mapZones.map(z => {
                              const sel = instSelectedZones.includes(z.key);
                              return (
                                <button key={z.key} onClick={() => toggleZone(z.key)}
                                  className={`px-2 py-1.5 rounded border text-xs text-left transition-colors ${sel ? "border-blood bg-blood/20 text-blood" : "border-brass/25 bg-void hover:border-brass/40 text-parchment/60"}`}>
                                  {z.name}
                                </button>
                              );
                            }) : <p className="text-xs text-parchment/40 col-span-2">No zones loaded.</p>}
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2 pt-1">
                        <button onClick={() => { setInstRoll(null); setInstStatus(""); }}
                          className="flex-1 px-3 py-2 rounded border border-brass/25 text-xs text-parchment/60 hover:text-parchment/90 hover:border-brass/40 transition-colors">
                          Re-roll
                        </button>
                        <button onClick={confirmInstability} disabled={!instCanConfirm}
                          className="flex-1 px-3 py-2 rounded bg-blood/20 border border-blood/50 hover:bg-blood/30 text-xs font-semibold text-blood disabled:opacity-40 transition-colors">
                          {instConfirming
                            ? <span className="flex items-center justify-center gap-1.5"><span className="w-3 h-3 border-2 border-blood/30 border-t-blood rounded-full animate-spin" />Applying...</span>
                            : "Confirm & Apply"}
                        </button>
                      </div>

                      {instStatus && <p className={`text-xs ${instStatus.startsWith("Error") ? "text-blood/70" : "text-brass/70"}`}>{instStatus}</p>}
                    </div>
                  )}
                </div>
              </Card>

            </div>
          </div>
        )}
      </div>
    </Frame>
  );
}
