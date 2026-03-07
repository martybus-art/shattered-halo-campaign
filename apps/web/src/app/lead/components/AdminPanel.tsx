"use client";
// apps/web/src/app/lead/components/AdminPanel.tsx
// Admin controls panel for lead/admin roles.
//
// changelog:
//   2026-03-07 -- Initial creation. Collapsible admin panel with 5 sections:
//                 Player Resources, Adjust NIP/NCP, Sector Ownership Override,
//                 Instability Trigger, Audit Log. Uses supabaseBrowser() and
//                 grimdark theme matching lead/page.tsx. Requires edge functions:
//                 admin-adjust-resources, admin-override-sector, admin-trigger-instability
//                 and migration 008_admin_adjustments.sql.

import React, { useState, useEffect, useCallback } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PlayerRow = {
  user_id: string;
  commander_name: string | null;
  faction_name: string | null;
  nip: number;
  ncp: number;
  sector_count: number;
};

type SectorRow = {
  zone_key: string;
  sector_key: string;
  owner_user_id: string | null;
};

type AuditRow = {
  id: string;
  created_at: string;
  adjustment_type: "nip" | "ncp" | "sector_owner" | "instability";
  player_id: string | null;
  delta: number | null;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
};

type Section = "resources" | "adjust" | "sector" | "instability" | "audit" | null;

interface AdminPanelProps {
  campaignId: string;
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spin() {
  return (
    <span className="inline-block w-3 h-3 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
  );
}

// ---------------------------------------------------------------------------
// AdminPanel
// ---------------------------------------------------------------------------

export default function AdminPanel({ campaignId }: AdminPanelProps) {
  const supabase = React.useMemo(() => supabaseBrowser(), []);

  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>(null);

  // -- Shared data
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [sectors, setSectors] = useState<SectorRow[]>([]);
  const [campaignInstability, setCampaignInstability] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);

  // -- Adjust NIP/NCP fields
  const [adjPlayer, setAdjPlayer] = useState("");
  const [adjField, setAdjField] = useState<"nip" | "ncp">("nip");
  const [adjDelta, setAdjDelta] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const [adjBusy, setAdjBusy] = useState(false);

  // -- Sector override fields
  const [secZone, setSecZone] = useState("");
  const [secSector, setSecSector] = useState("");
  const [secOwner, setSecOwner] = useState("");
  const [secReason, setSecReason] = useState("");
  const [secBusy, setSecBusy] = useState(false);

  // -- Instability fields
  const [instDelta, setInstDelta] = useState("");
  const [instTrigger, setInstTrigger] = useState(false);
  const [instReason, setInstReason] = useState("");
  const [instBusy, setInstBusy] = useState(false);

  // -- Audit
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // ---------------------------------------------------------------------------
  // Load data
  // ---------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    try {
      // Campaign instability
      const { data: camp } = await supabase
        .from("campaigns")
        .select("instability")
        .eq("id", campaignId)
        .single();
      setCampaignInstability(camp?.instability ?? 0);

      // Members with player_state joined for NIP/NCP
      const { data: memberRows } = await supabase
        .from("campaign_members")
        .select("user_id, commander_name, faction_name")
        .eq("campaign_id", campaignId);

      const { data: stateRows } = await supabase
        .from("player_state")
        .select("user_id, nip, ncp")
        .eq("campaign_id", campaignId);

      // Sector counts per player
      const { data: sectorRows } = await supabase
        .from("sectors")
        .select("zone_key, sector_key, owner_user_id")
        .eq("campaign_id", campaignId);

      setSectors((sectorRows ?? []) as SectorRow[]);

      const stateMap = new Map(
        (stateRows ?? []).map((s) => [s.user_id, s])
      );
      const sectorCountMap = new Map<string, number>();
      for (const s of sectorRows ?? []) {
        if (s.owner_user_id) {
          sectorCountMap.set(
            s.owner_user_id,
            (sectorCountMap.get(s.owner_user_id) ?? 0) + 1
          );
        }
      }

      const rows: PlayerRow[] = (memberRows ?? []).map((m) => {
        const st = stateMap.get(m.user_id);
        return {
          user_id: m.user_id,
          commander_name: m.commander_name,
          faction_name: m.faction_name,
          nip: st?.nip ?? 0,
          ncp: st?.ncp ?? 0,
          sector_count: sectorCountMap.get(m.user_id) ?? 0,
        };
      });
      setPlayers(rows);
    } finally {
      setLoading(false);
    }
  }, [campaignId, supabase]);

  useEffect(() => {
    if (open) loadData();
  }, [open, loadData]);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    const { data } = await supabase
      .from("admin_adjustments")
      .select("id, created_at, adjustment_type, player_id, delta, old_value, new_value, reason")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })
      .limit(20);
    setAudit((data ?? []) as AuditRow[]);
    setAuditLoading(false);
  }, [campaignId, supabase]);

  useEffect(() => {
    if (section === "audit") loadAudit();
  }, [section, loadAudit]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const getToken = async () => {
    const { data: sess } = await supabase.auth.getSession();
    return sess.session?.access_token ?? null;
  };

  const callEdge = async (fn: string, body: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) throw new Error("Session expired. Please refresh.");
    const { data, error } = await supabase.functions.invoke(fn, {
      body,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) throw new Error(error.message);
    if (!data?.ok) throw new Error(data?.error ?? "Unknown error");
    return data;
  };

  const flash = (msg: string, tone: "ok" | "err") => {
    setStatus({ msg, tone });
    setTimeout(() => setStatus(null), 4000);
  };

  const toggleSection = (s: Section) =>
    setSection((prev) => (prev === s ? null : s));

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const zones = Array.from(new Set(sectors.map((s) => s.zone_key))).sort();
  const sectorsInZone = secZone
    ? sectors.filter((s) => s.zone_key === secZone).map((s) => s.sector_key)
    : [];

  const playerLabel = (uid: string) => {
    const p = players.find((x) => x.user_id === uid);
    return p?.commander_name ?? p?.faction_name ?? uid.slice(0, 8);
  };

  const auditTypeColour = (t: string) => {
    if (t === "nip") return "text-yellow-400";
    if (t === "ncp") return "text-green-400";
    if (t === "sector_owner") return "text-blue-400";
    if (t === "instability") return "text-blood";
    return "text-parchment/50";
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleAdjust = async () => {
    if (!adjPlayer || !adjDelta || !adjReason.trim()) {
      flash("Fill in player, delta, and reason.", "err");
      return;
    }
    const deltaNum = parseInt(adjDelta, 10);
    if (isNaN(deltaNum)) {
      flash("Delta must be a whole number (positive or negative).", "err");
      return;
    }
    setAdjBusy(true);
    try {
      const result = await callEdge("admin-adjust-resources", {
        campaignId,
        playerId: adjPlayer,
        field: adjField,
        delta: deltaNum,
        reason: adjReason.trim(),
      });
      flash(
        `${adjField.toUpperCase()} adjusted: ${result.oldValue} → ${result.newValue} (${deltaNum >= 0 ? "+" : ""}${deltaNum})`,
        "ok"
      );
      setAdjDelta("");
      setAdjReason("");
      await loadData();
    } catch (e: any) {
      flash(`Error: ${e.message}`, "err");
    } finally {
      setAdjBusy(false);
    }
  };

  const handleSectorOverride = async () => {
    if (!secZone || !secSector || !secReason.trim()) {
      flash("Fill in zone, sector, and reason.", "err");
      return;
    }
    setSecBusy(true);
    try {
      const result = await callEdge("admin-override-sector", {
        campaignId,
        zoneKey: secZone,
        sectorKey: secSector,
        newOwnerUserId: secOwner || null,
        reason: secReason.trim(),
      });
      const oldLabel = result.oldOwner ? playerLabel(result.oldOwner) : "Neutral";
      const newLabel = result.newOwner ? playerLabel(result.newOwner) : "Neutral";
      flash(`${secZone}/${secSector}: ${oldLabel} → ${newLabel}`, "ok");
      setSecZone("");
      setSecSector("");
      setSecOwner("");
      setSecReason("");
      await loadData();
    } catch (e: any) {
      flash(`Error: ${e.message}`, "err");
    } finally {
      setSecBusy(false);
    }
  };

  const handleInstability = async () => {
    const deltaNum = parseInt(instDelta, 10);
    if (isNaN(deltaNum) || !instReason.trim()) {
      flash("Fill in delta and reason.", "err");
      return;
    }
    setInstBusy(true);
    try {
      const result = await callEdge("admin-trigger-instability", {
        campaignId,
        delta: deltaNum,
        triggerEvent: instTrigger,
        reason: instReason.trim(),
      });
      flash(
        `Instability: ${result.oldInstability} → ${result.newInstability}${instTrigger ? " (event fired)" : ""}`,
        "ok"
      );
      setInstDelta("");
      setInstReason("");
      setInstTrigger(false);
      await loadData();
    } catch (e: any) {
      flash(`Error: ${e.message}`, "err");
    } finally {
      setInstBusy(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Sub-components
  // ---------------------------------------------------------------------------

  const SectionHeader = ({
    id,
    label,
    badge,
  }: {
    id: Section;
    label: string;
    badge?: string;
  }) => (
    <button
      type="button"
      onClick={() => toggleSection(id)}
      className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-brass/5 transition-colors rounded"
    >
      <span className="text-xs font-mono uppercase tracking-widest text-parchment/70">
        {label}
      </span>
      <span className="flex items-center gap-2">
        {badge && (
          <span className="text-xs font-mono text-brass/60">{badge}</span>
        )}
        <span className="text-parchment/30 text-xs">
          {section === id ? "▲" : "▼"}
        </span>
      </span>
    </button>
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="mt-6">
      {/* Master toggle */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center justify-between gap-3 px-5 py-3 rounded border transition-colors ${
          open
            ? "bg-blood/10 border-blood/40 text-blood"
            : "bg-void border-brass/20 text-brass/60 hover:border-brass/40 hover:text-brass/80"
        }`}
      >
        <span className="text-xs font-mono uppercase tracking-widest">
          ⚙ Admin Controls
        </span>
        <span className="text-xs font-mono">{open ? "▲ Collapse" : "▼ Expand"}</span>
      </button>

      {/* Panel body */}
      {open && (
        <div className="mt-2 rounded border border-blood/20 bg-void/80 divide-y divide-blood/10">

          {/* Status flash */}
          {status && (
            <div
              className={`px-5 py-3 text-xs font-mono ${
                status.tone === "ok" ? "text-green-400" : "text-blood"
              }`}
            >
              {status.msg}
            </div>
          )}

          {/* ── 1. Player Resources ───────────────────────────────── */}
          <div>
            <SectionHeader id="resources" label="Player Resources" badge={`${players.length} players`} />
            {section === "resources" && (
              <div className="px-4 pb-4">
                {loading ? (
                  <div className="flex items-center gap-2 py-4 text-parchment/40 text-xs">
                    <Spin /> Loading...
                  </div>
                ) : (
                  <>
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-xs text-parchment/40 font-mono">
                        Instability: <span className="text-blood font-bold">{campaignInstability}/10</span>
                      </span>
                      <button
                        type="button"
                        onClick={loadData}
                        className="text-xs text-brass/50 hover:text-brass/80 font-mono uppercase tracking-widest transition-colors"
                      >
                        Refresh
                      </button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs font-mono">
                        <thead>
                          <tr className="border-b border-brass/10">
                            <th className="text-left pb-2 text-parchment/40 font-normal">Commander</th>
                            <th className="text-left pb-2 text-parchment/40 font-normal">Faction</th>
                            <th className="text-right pb-2 text-yellow-400/70 font-normal">NIP</th>
                            <th className="text-right pb-2 text-green-400/70 font-normal">NCP</th>
                            <th className="text-right pb-2 text-blue-400/70 font-normal">Sectors</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-brass/5">
                          {players.map((p) => (
                            <tr key={p.user_id}>
                              <td className="py-1.5 text-parchment/80">
                                {p.commander_name ?? <span className="text-parchment/30 italic">—</span>}
                              </td>
                              <td className="py-1.5 text-parchment/50">
                                {p.faction_name ?? <span className="text-parchment/25 italic">—</span>}
                              </td>
                              <td className="py-1.5 text-right text-yellow-400 font-bold">{p.nip}</td>
                              <td className="py-1.5 text-right text-green-400 font-bold">{p.ncp}</td>
                              <td className="py-1.5 text-right text-blue-400">{p.sector_count}</td>
                            </tr>
                          ))}
                          {players.length === 0 && (
                            <tr>
                              <td colSpan={5} className="py-3 text-parchment/30 italic">
                                No players found.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── 2. Adjust NIP / NCP ───────────────────────────────── */}
          <div>
            <SectionHeader id="adjust" label="Adjust NIP / NCP" />
            {section === "adjust" && (
              <div className="px-4 pb-4 space-y-3">
                <p className="text-xs text-parchment/35">
                  Manually add or subtract resources for any player. Use negative delta to deduct.
                </p>

                {/* Player */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Player
                  </label>
                  <select
                    value={adjPlayer}
                    onChange={(e) => setAdjPlayer(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm"
                  >
                    <option value="">— Select player —</option>
                    {players.map((p) => (
                      <option key={p.user_id} value={p.user_id}>
                        {p.commander_name ?? p.faction_name ?? p.user_id.slice(0, 8)}
                        {" "}({p.nip} NIP / {p.ncp} NCP)
                      </option>
                    ))}
                  </select>
                </div>

                {/* Field */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Currency
                  </label>
                  <div className="flex gap-2">
                    {(["nip", "ncp"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setAdjField(f)}
                        className={`flex-1 py-2 rounded border text-xs font-mono uppercase tracking-widest transition-colors ${
                          adjField === f
                            ? f === "nip"
                              ? "bg-yellow-400/20 border-yellow-400/60 text-yellow-400"
                              : "bg-green-400/20 border-green-400/60 text-green-400"
                            : "bg-void border-brass/20 text-parchment/40 hover:border-brass/40"
                        }`}
                      >
                        {f.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Delta */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Delta (e.g. +3 or -2)
                  </label>
                  <input
                    type="number"
                    value={adjDelta}
                    onChange={(e) => setAdjDelta(e.target.value)}
                    placeholder="e.g. 3 or -2"
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm font-mono"
                  />
                </div>

                {/* Reason */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Reason (required)
                  </label>
                  <input
                    type="text"
                    value={adjReason}
                    onChange={(e) => setAdjReason(e.target.value)}
                    placeholder="e.g. Scenario bonus, correction"
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleAdjust}
                  disabled={adjBusy}
                  className="w-full px-4 py-2.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                >
                  {adjBusy ? <><Spin /> Applying...</> : "Apply Adjustment"}
                </button>
              </div>
            )}
          </div>

          {/* ── 3. Sector Ownership Override ──────────────────────── */}
          <div>
            <SectionHeader id="sector" label="Sector Ownership Override" />
            {section === "sector" && (
              <div className="px-4 pb-4 space-y-3">
                <p className="text-xs text-parchment/35">
                  Reassign sector ownership to correct errors or apply scenario rules.
                  Leave owner blank to set neutral.
                </p>

                {/* Zone */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Zone
                  </label>
                  <select
                    value={secZone}
                    onChange={(e) => { setSecZone(e.target.value); setSecSector(""); }}
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm"
                  >
                    <option value="">— Select zone —</option>
                    {zones.map((z) => (
                      <option key={z} value={z}>{z}</option>
                    ))}
                  </select>
                </div>

                {/* Sector */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Sector
                  </label>
                  <select
                    value={secSector}
                    onChange={(e) => setSecSector(e.target.value)}
                    disabled={!secZone}
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm disabled:opacity-40"
                  >
                    <option value="">— Select sector —</option>
                    {sectorsInZone.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                {/* New owner */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    New Owner (blank = neutral)
                  </label>
                  <select
                    value={secOwner}
                    onChange={(e) => setSecOwner(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm"
                  >
                    <option value="">— Neutral / No owner —</option>
                    {players.map((p) => (
                      <option key={p.user_id} value={p.user_id}>
                        {p.commander_name ?? p.faction_name ?? p.user_id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Reason */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Reason (required)
                  </label>
                  <input
                    type="text"
                    value={secReason}
                    onChange={(e) => setSecReason(e.target.value)}
                    placeholder="e.g. Scenario correction, rule dispute"
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleSectorOverride}
                  disabled={secBusy}
                  className="w-full px-4 py-2.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                >
                  {secBusy ? <><Spin /> Applying...</> : "Override Sector"}
                </button>
              </div>
            )}
          </div>

          {/* ── 4. Instability Trigger ────────────────────────────── */}
          <div>
            <SectionHeader
              id="instability"
              label="Instability Trigger"
              badge={`Current: ${campaignInstability}/10`}
            />
            {section === "instability" && (
              <div className="px-4 pb-4 space-y-3">
                <p className="text-xs text-parchment/35">
                  Manually adjust the Halo Instability counter. Optionally fire the d10 event table
                  at the new value (same as Apply Instability in the main controls, but with a manual delta).
                </p>

                {/* Delta */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Delta (positive or negative)
                  </label>
                  <input
                    type="number"
                    value={instDelta}
                    onChange={(e) => setInstDelta(e.target.value)}
                    placeholder="e.g. 2 or -1"
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm font-mono"
                  />
                </div>

                {/* Trigger event checkbox */}
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={instTrigger}
                    onChange={(e) => setInstTrigger(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-parchment/70">
                    Also fire instability event at new value
                    <span className="block text-xs text-parchment/35 mt-0.5">
                      Calls apply-instability edge function to roll and post the d10 event bulletin.
                    </span>
                  </span>
                </label>

                {/* Reason */}
                <div>
                  <label className="block text-xs text-parchment/40 mb-1 font-mono uppercase tracking-widest">
                    Reason (required)
                  </label>
                  <input
                    type="text"
                    value={instReason}
                    onChange={(e) => setInstReason(e.target.value)}
                    placeholder="e.g. Narrative event, GM ruling"
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleInstability}
                  disabled={instBusy}
                  className="w-full px-4 py-2.5 rounded bg-blood/15 border border-blood/40 hover:bg-blood/25 text-blood disabled:opacity-40 text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                >
                  {instBusy ? <><Spin /> Applying...</> : "Apply Instability Change"}
                </button>
              </div>
            )}
          </div>

          {/* ── 5. Audit Log ──────────────────────────────────────── */}
          <div>
            <SectionHeader id="audit" label="Audit Log" badge="last 20" />
            {section === "audit" && (
              <div className="px-4 pb-4">
                {auditLoading ? (
                  <div className="flex items-center gap-2 py-4 text-parchment/40 text-xs">
                    <Spin /> Loading...
                  </div>
                ) : audit.length === 0 ? (
                  <p className="text-xs text-parchment/30 italic py-3">No admin adjustments recorded yet.</p>
                ) : (
                  <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                    {audit.map((a) => (
                      <div
                        key={a.id}
                        className="px-3 py-2 rounded bg-black/20 border border-brass/10 text-xs font-mono"
                      >
                        <div className="flex items-center justify-between gap-2 mb-0.5">
                          <span className={`uppercase tracking-widest font-bold ${auditTypeColour(a.adjustment_type)}`}>
                            {a.adjustment_type}
                          </span>
                          <span className="text-parchment/25">
                            {new Date(a.created_at).toLocaleDateString("en-AU", {
                              day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                            })}
                          </span>
                        </div>
                        {a.player_id && (
                          <p className="text-parchment/60">
                            Player: {playerLabel(a.player_id)}
                          </p>
                        )}
                        {a.old_value !== null && a.new_value !== null && (
                          <p className="text-parchment/50">
                            {a.old_value} → {a.new_value}
                            {a.delta !== null && (
                              <span className={a.delta >= 0 ? "text-green-400" : "text-blood"}>
                                {" "}({a.delta >= 0 ? "+" : ""}{a.delta})
                              </span>
                            )}
                          </p>
                        )}
                        {a.reason && (
                          <p className="text-parchment/40 italic mt-0.5">{a.reason}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={loadAudit}
                  className="mt-2 text-xs text-brass/50 hover:text-brass/80 font-mono uppercase tracking-widest transition-colors"
                >
                  Refresh Log
                </button>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
