// apps/web/src/app/lead/page.tsx
// Lead Controls — campaign management for lead/admin roles.
// Stage order: spend → recon → movement → conflicts → missions → results → publish
// Instability uses a two-phase roll/confirm modal at results stage.
// changelog:
//   2026-03-03 — moved Start Campaign, Advance Stage, Assign Missions, Apply Instability
//                into Campaign Status Card; replaced Late Player Allocation with
//                Player Invite (email-based via send-invite edge fn); added
//                Delete Campaign with two-step confirm inside Campaign Status Card.
//   2026-03-03 — Advance Stage hidden until campaign started (round > 0);
//                Assign Missions visible always but gated to missions stage;
//                Apply Instability hidden until results stage, shown as modal overlay
//                that posts narrative to War Bulletin (posts table) on confirm;
//                Skip button on instability modal; Late Player Allocation card removed.
"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name);
}

const STAGES = ["spend", "recon", "movement", "conflicts", "missions", "results", "publish"];

// ── Component ─────────────────────────────────────────────────────────────────

export default function LeadControls() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [campaignId, setCampaignId] = useState<string>("");
  const [campaign, setCampaign]     = useState<Campaign | null>(null);
  const [round, setRound]           = useState<Round | null>(null);
  const [role, setRole]             = useState<string>("player");
  const [mapZones, setMapZones]     = useState<MapZone[]>([]);

  // Player invite
  const [inviteEmail, setInviteEmail]   = useState<string>("");
  const [inviteStatus, setInviteStatus] = useState<string>("");

  // Delete campaign
  const [deleteConfirm, setDeleteConfirm] = useState<boolean>(false);
  const [deleteStatus, setDeleteStatus]   = useState<string>("");

  // Start campaign
  const [startStatus, setStartStatus] = useState<string>("");

  // Generic action status
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

  // Instability modal state
  const [instModalOpen, setInstModalOpen]         = useState(false);
  const [instRoll, setInstRoll]                   = useState<InstabilityRoll | null>(null);
  const [instRolling, setInstRolling]             = useState(false);
  const [instConfirming, setInstConfirming]       = useState(false);
  const [instSelectedZone, setInstSelectedZone]   = useState<string>("");
  const [instSelectedZones, setInstSelectedZones] = useState<string[]>([]);
  const [instStatus, setInstStatus]               = useState<string>("");

  // ── Load ──────────────────────────────────────────────────────────────────

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
      .eq("id", cid)
      .single();

    if (cErr || !c) {
      setActionStatus(s => ({ ...s, load: cErr?.message ?? "Campaign not found" }));
      setCampaign(null);
      setRound(null);
      return;
    }

    setCampaign(c as Campaign);

    const { data: r } = await supabase
      .from("rounds").select("stage")
      .eq("campaign_id", cid).eq("round_number", c.round_number)
      .maybeSingle();
    setRound(r);

    if ((c as any).map_id) {
      const { data: mapRow } = await supabase
        .from("maps").select("map_json")
        .eq("id", (c as any).map_id)
        .maybeSingle();
      const zones: MapZone[] = (mapRow?.map_json as any)?.zones ?? [];
      setMapZones(zones);
    }
  }, [supabase]);

  useEffect(() => {
    const q = getQueryParam("campaign");
    if (q) setCampaignId(q);
  }, []);

  useEffect(() => {
    if (campaignId) load(campaignId);
  }, [campaignId, load]);

  // ── Auth helper ───────────────────────────────────────────────────────────

  const getToken = async (): Promise<string | null> => {
    const { data: sess } = await supabase.auth.getSession();
    return sess.session?.access_token ?? null;
  };

  // ── Generic function caller ───────────────────────────────────────────────

  const callFn = async (
    fn: string,
    key: string,
    extraBody?: Record<string, unknown>
  ) => {
    setActionStatus(s => ({ ...s, [key]: "Working..." }));
    const token = await getToken();
    if (!token) { setActionStatus(s => ({ ...s, [key]: "Session expired - refresh." })); return; }

    const { data, error } = await supabase.functions.invoke(fn, {
      body: { campaign_id: campaignId, ...extraBody },
      headers: { Authorization: `Bearer ${token}` },
    });

    if (error) {
      setActionStatus(s => ({ ...s, [key]: `Error: ${error.message}` }));
      return;
    }
    if (!data?.ok) {
      setActionStatus(s => ({ ...s, [key]: `Failed: ${data?.error ?? "Unknown error"}` }));
      return;
    }

    const detail = data.stage
      ? `Stage to ${data.stage}${data.conflicts_created ? ` (${data.conflicts_created} conflict(s) detected)` : ""}`
      : "Done.";
    setActionStatus(s => ({ ...s, [key]: `OK ${detail}` }));
    await load(campaignId);
  };

  // ── Start campaign ────────────────────────────────────────────────────────

  const startCampaign = async () => {
    setStartStatus("Starting...");
    const token = await getToken();
    if (!token) { setStartStatus("Session expired - refresh."); return; }

    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "initial" },
      headers: { Authorization: `Bearer ${token}` },
    });

    if (error) { setStartStatus(`Error: ${error.message}`); return; }
    setStartStatus(`Started. ${data?.allocated ?? 0} player(s) allocated.`);
    await load(campaignId);
  };

  // ── Player invite ─────────────────────────────────────────────────────────

  const sendInvite = async () => {
    if (!inviteEmail.trim()) { setInviteStatus("Enter an email address."); return; }
    setInviteStatus("Sending...");
    const token = await getToken();
    if (!token) { setInviteStatus("Session expired - refresh."); return; }

    const { data, error } = await supabase.functions.invoke("send-invite", {
      body: { campaign_id: campaignId, email: inviteEmail.trim().toLowerCase() },
      headers: { Authorization: `Bearer ${token}` },
    });

    if (error) { setInviteStatus(`Error: ${error.message}`); return; }
    if (!data?.ok) { setInviteStatus(`Failed: ${data?.error ?? "Unknown error"}`); return; }

    setInviteStatus(`Invite sent to ${inviteEmail.trim()}.`);
    setInviteEmail("");
  };

  // ── Delete campaign ───────────────────────────────────────────────────────

  const deleteCampaign = async () => {
    setDeleteStatus("Deleting...");
    const { error } = await supabase
      .from("campaigns")
      .delete()
      .eq("id", campaignId);

    if (error) {
      setDeleteStatus(`Error: ${error.message}`);
      setDeleteConfirm(false);
      return;
    }

    setDeleteStatus("Campaign deleted.");
    setCampaign(null);
    setRound(null);
    setDeleteConfirm(false);
    setTimeout(() => { window.location.href = "/dashboard"; }, 1500);
  };

  // ── Instability modal helpers ─────────────────────────────────────────────

  const openInstModal = () => {
    setInstModalOpen(true);
    setInstRoll(null);
    setInstStatus("");
    setInstSelectedZone("");
    setInstSelectedZones([]);
  };

  const closeInstModal = () => {
    setInstModalOpen(false);
    setInstRoll(null);
    setInstStatus("");
    setInstSelectedZone("");
    setInstSelectedZones([]);
  };

  // ── Instability Phase 1: Roll ─────────────────────────────────────────────

  const rollInstability = async () => {
    setInstRolling(true);
    setInstRoll(null);
    setInstStatus("");
    setInstSelectedZone("");
    setInstSelectedZones([]);
    const token = await getToken();
    if (!token) { setInstStatus("Session expired - refresh."); setInstRolling(false); return; }

    const { data, error } = await supabase.functions.invoke("apply-instability", {
      body: { campaign_id: campaignId, mode: "roll" },
      headers: { Authorization: `Bearer ${token}` },
    });

    setInstRolling(false);
    if (error) { setInstStatus(`Error: ${error.message}`); return; }
    if (!data?.ok) { setInstStatus(`Failed: ${data?.error ?? "Unknown"}`); return; }
    setInstRoll(data as InstabilityRoll);
  };

  // ── Instability Phase 2: Confirm + post to War Bulletin ──────────────────

  const confirmInstability = async () => {
    if (!instRoll || !campaign) return;
    setInstConfirming(true);
    setInstStatus("");
    const token = await getToken();
    if (!token) { setInstStatus("Session expired - refresh."); setInstConfirming(false); return; }

    const { data, error } = await supabase.functions.invoke("apply-instability", {
      body: {
        campaign_id:          campaignId,
        mode:                 "confirm",
        d10_result:           instRoll.d10,
        expected_instability: instRoll.current_instability,
        selected_zone:        instSelectedZone,
        selected_zones:       instSelectedZones,
      },
      headers: { Authorization: `Bearer ${token}` },
    });

    setInstConfirming(false);
    if (error) { setInstStatus(`Error: ${error.message}`); return; }
    if (!data?.ok) { setInstStatus(`Failed: ${data?.error ?? "Unknown"}`); return; }

    // Post instability narrative to War Bulletin
    await supabase.from("posts").insert({
      campaign_id:  campaignId,
      round_number: campaign.round_number,
      title:        `Instability Event - Round ${campaign.round_number}: ${instRoll.event_name}`,
      body:         instRoll.public_text,
      tags:         ["instability", "event"],
      visibility:   "public",
    });

    setInstStatus(
      `Applied. Instability now ${data.instability}/10.` +
      (data.phase_changed ? ` Phase advanced to ${data.new_phase}.` : "") +
      " Narrative posted to War Bulletin."
    );

    await load(campaignId);
    setTimeout(() => closeInstModal(), 2000);
  };

  const toggleZone = (key: string) => {
    setInstSelectedZones(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const allowed         = role === "lead" || role === "admin";
  const campaignStarted = (campaign?.round_number ?? 0) > 0;
  const stageLabel      = round?.stage ?? "unknown";
  const isResultsStage  = stageLabel === "results";
  const isMissionsStage = stageLabel === "missions";

  const nextStageLabel = stageLabel === "publish"
    ? "next round / spend"
    : STAGES[STAGES.indexOf(stageLabel) + 1] ?? "?";

  const instNeedsZone    = instRoll?.needs_zone_selection ?? false;
  const instNeedsMulti   = instRoll?.needs_zone_destroy ?? false;
  const instDestroyCount = instRoll?.destroy_count ?? 1;

  const instCanConfirm =
    instRoll &&
    !instConfirming &&
    (!instNeedsZone  || instSelectedZone.length > 0) &&
    (!instNeedsMulti || instSelectedZones.length >= instDestroyCount);

  const instBandLabel =
    instRoll
      ? instRoll.threshold_band === 8 ? "Tier III (8+)"
        : instRoll.threshold_band === 4 ? "Tier II (4-7)"
        : "Tier I (0-3)"
      : "";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame
      title="Lead Controls"
      campaignId={campaignId}
      role={role}
      currentPage="lead"
    >
      <div className="space-y-6">

        {/* ── Campaign Status Card ── */}
        <Card title="Campaign Status">
          {campaign ? (
            <div className="space-y-4">

              {/* Status display */}
              <div className="text-sm text-parchment/80 space-y-1">
                <div><span className="text-brass">Name:</span> {campaign.name}</div>
                <div>
                  <span className="text-brass">Phase:</span> {campaign.phase}
                  &nbsp;&nbsp;
                  <span className="text-brass">Round:</span> {campaign.round_number}
                  &nbsp;&nbsp;
                  <span className="text-brass">Stage:</span>{" "}
                  <span className="font-mono text-brass/80 uppercase tracking-wider text-xs">{stageLabel}</span>
                </div>
                <div>
                  <span className="text-brass">Instability:</span>{" "}
                  <span className={
                    campaign.instability >= 8 ? "text-blood font-semibold" :
                    campaign.instability >= 4 ? "text-yellow-500/80" :
                    "text-parchment/80"
                  }>
                    {campaign.instability}/10
                  </span>
                </div>
                <div><span className="text-brass">Role:</span> {role}</div>
                {!allowed && (
                  <p className="mt-2 text-blood/80 text-xs">
                    You are not authorised for lead controls in this campaign.
                  </p>
                )}
              </div>

              {allowed && (
                <>
                  <div className="border-t border-brass/20 pt-4 space-y-4">
                    <p className="text-xs text-parchment/40 uppercase tracking-wider">Actions</p>

                    {/* Start Campaign — always visible */}
                    <div>
                      <p className="text-parchment/60 text-xs leading-relaxed mb-2">
                        Allocates secret starting locations for all current members. Run once when ready to begin.
                      </p>
                      <button
                        onClick={startCampaign}
                        className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm transition-colors"
                      >
                        Start Campaign
                      </button>
                      {startStatus && (
                        <p className={`mt-1 text-xs ${startStatus.startsWith("Error") ? "text-blood/70" : "text-brass/70"}`}>
                          {startStatus}
                        </p>
                      )}
                    </div>

                    {/* Advance Stage — hidden until campaign has started */}
                    {campaignStarted && (
                      <div>
                        <p className="text-parchment/60 text-xs leading-relaxed mb-1">
                          Current:{" "}
                          <span className="font-mono text-brass/70 uppercase">{stageLabel}</span>
                          {" "}-&gt;{" "}
                          <span className="font-mono text-parchment/40 uppercase">{nextStageLabel}</span>
                        </p>
                        <button
                          onClick={() => callFn("advance-round", "advance")}
                          className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm transition-colors"
                        >
                          Advance Stage
                        </button>
                        {actionStatus.advance && (
                          <p className={`mt-1 text-xs ${actionStatus.advance.startsWith("Error") || actionStatus.advance.startsWith("Failed") ? "text-blood/70" : "text-brass/70"}`}>
                            {actionStatus.advance}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Assign Missions — always visible, button disabled until missions stage */}
                    <div>
                      <p className="text-parchment/60 text-xs leading-relaxed mb-2">
                        Assigns missions to all conflicts, respecting NIP preference votes.
                        {!isMissionsStage && campaignStarted && (
                          <span className="block mt-0.5 text-parchment/35 italic">
                            Available during the Missions stage
                            {stageLabel !== "unknown" ? ` (current: ${stageLabel})` : ""}.
                          </span>
                        )}
                      </p>
                      <button
                        disabled={!isMissionsStage}
                        onClick={() => callFn("assign-missions", "missions")}
                        className="w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-sm disabled:opacity-40 transition-colors"
                      >
                        Assign Missions
                      </button>
                      {actionStatus.missions && (
                        <p className={`mt-1 text-xs ${actionStatus.missions.startsWith("Error") || actionStatus.missions.startsWith("Failed") ? "text-blood/70" : "text-brass/70"}`}>
                          {actionStatus.missions}
                        </p>
                      )}
                    </div>

                    {/* Apply Instability — only shown during results stage */}
                    {isResultsStage && campaignStarted && (
                      <div className="rounded border border-blood/30 bg-blood/5 p-3 space-y-2">
                        <p className="text-blood text-xs font-semibold">
                          Results Phase — apply instability before advancing.
                        </p>
                        <p className="text-parchment/50 text-xs">
                          The event narrative will be posted to the War Bulletin automatically on confirm.
                        </p>
                        <button
                          onClick={openInstModal}
                          className="w-full px-4 py-2 rounded bg-blood/20 border border-blood/50 hover:bg-blood/30 text-sm font-semibold text-blood transition-colors"
                        >
                          Roll &amp; Apply Instability
                        </button>
                      </div>
                    )}

                  </div>

                  {/* Danger zone */}
                  <div className="border-t border-blood/20 pt-4">
                    <p className="text-xs text-parchment/40 uppercase tracking-wider mb-3">Danger Zone</p>
                    {!deleteConfirm ? (
                      <button
                        onClick={() => { setDeleteConfirm(true); setDeleteStatus(""); }}
                        className="w-full px-4 py-2 rounded border border-blood/40 bg-blood/10 hover:bg-blood/20 text-sm text-blood/80 hover:text-blood transition-colors"
                      >
                        Delete Campaign
                      </button>
                    ) : (
                      <div className="rounded border border-blood/40 bg-blood/10 p-3 space-y-2">
                        <p className="text-xs text-blood font-semibold">
                          This will permanently delete &ldquo;{campaign.name}&rdquo; and all associated data. This cannot be undone.
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setDeleteConfirm(false); setDeleteStatus(""); }}
                            className="flex-1 px-3 py-2 rounded border border-brass/25 text-xs text-parchment/60 hover:text-parchment/90 hover:border-brass/40 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={deleteCampaign}
                            className="flex-1 px-3 py-2 rounded bg-blood/30 border border-blood/60 hover:bg-blood/50 text-xs font-semibold text-blood transition-colors"
                          >
                            Confirm Delete
                          </button>
                        </div>
                        {deleteStatus && (
                          <p className={`text-xs ${deleteStatus.startsWith("Error") ? "text-blood/70" : "text-brass/70"}`}>
                            {deleteStatus}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="text-parchment/50 text-sm">
              {campaignId ? "Loading..." : "No campaign ID in URL."}
            </p>
          )}
          {actionStatus.load && (
            <p className="mt-2 text-blood/70 text-xs">{actionStatus.load}</p>
          )}
        </Card>

        {/* ── Invite Players card ── */}
        {campaign && allowed && (
          <Card title="Invite Players">
            <p className="text-parchment/70 text-sm leading-relaxed">
              Send an email invite to a player. They will be added to this campaign automatically
              the next time they log in. Players who join after the campaign has started will
              receive catch-up bonuses automatically.
            </p>
            <input
              type="email"
              className="mt-3 w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm focus:outline-none focus:border-brass/60"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendInvite(); }}
              placeholder="player@example.com"
              disabled={!allowed}
            />
            <button
              disabled={!allowed || !inviteEmail.trim()}
              onClick={sendInvite}
              className="mt-2 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm disabled:opacity-40 transition-colors"
            >
              Send Invite
            </button>
            {inviteStatus && (
              <p className={`mt-2 text-xs ${inviteStatus.startsWith("Error") ? "text-blood/70" : "text-brass/70"}`}>
                {inviteStatus}
              </p>
            )}
          </Card>
        )}

      </div>

      {/* ── Instability Modal Overlay ───────────────────────────────────────── */}
      {instModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-lg mx-4 rounded-xl border border-brass/40 bg-[#0d0d0d] shadow-2xl flex flex-col max-h-[90vh]">

            {/* Modal header */}
            <div className="px-6 py-4 border-b border-brass/20 flex items-center justify-between flex-shrink-0">
              <div>
                <h2 className="text-parchment font-semibold text-lg">Apply Instability</h2>
                <p className="text-xs text-parchment/40 mt-0.5">
                  Round {campaign?.round_number} &nbsp;·&nbsp; Current: {campaign?.instability}/10
                </p>
              </div>
              <button
                onClick={closeInstModal}
                className="text-parchment/30 hover:text-parchment/70 text-xl leading-none transition-colors px-1"
                aria-label="Close"
              >
                x
              </button>
            </div>

            {/* Modal body */}
            <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">

              {/* Phase 1 — Roll */}
              {!instRoll && (
                <>
                  <p className="text-parchment/60 text-sm leading-relaxed">
                    Roll a d10 against the current instability band to determine this round&rsquo;s event.
                    Review the result and narrative, then confirm to apply and post to the War Bulletin —
                    or skip if no event should be applied this round.
                  </p>
                  <button
                    disabled={instRolling}
                    onClick={rollInstability}
                    className="w-full px-4 py-3 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm font-semibold disabled:opacity-40 transition-colors"
                  >
                    {instRolling ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                        Rolling...
                      </span>
                    ) : "Roll Instability d10"}
                  </button>
                  {instStatus && (
                    <p className={`text-xs ${instStatus.startsWith("Error") || instStatus.startsWith("Failed") ? "text-blood/70" : "text-brass/70"}`}>
                      {instStatus}
                    </p>
                  )}
                </>
              )}

              {/* Phase 2 — Preview */}
              {instRoll && (
                <div className="space-y-4">

                  {/* Result header */}
                  <div className="rounded border border-brass/30 bg-black/30 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-brass text-xs uppercase tracking-widest font-semibold">
                          {instBandLabel} &nbsp;·&nbsp; Roll: {instRoll.d10}
                        </p>
                        <p className="text-parchment/90 font-semibold text-base mt-0.5">{instRoll.event_name}</p>
                      </div>
                      <span className={`text-3xl font-mono font-bold flex-shrink-0 ${
                        instRoll.new_instability >= 8 ? "text-blood" :
                        instRoll.new_instability >= 4 ? "text-yellow-500/80" :
                        "text-brass/70"
                      }`}>
                        {instRoll.new_instability}/10
                      </span>
                    </div>

                    {/* Narrative — posts to War Bulletin on confirm */}
                    <div className="space-y-1">
                      <p className="text-xs text-parchment/40 uppercase tracking-wider">
                        War Bulletin narrative
                      </p>
                      <p className="text-sm text-parchment/75 italic leading-relaxed border-l-2 border-brass/25 pl-3">
                        {instRoll.public_text}
                      </p>
                    </div>

                    {/* Auto effects */}
                    {instRoll.auto_effects.length > 0 && (
                      <div>
                        <p className="text-xs text-brass/60 uppercase tracking-wider mb-1.5">Auto-applied effects</p>
                        <ul className="space-y-0.5">
                          {instRoll.auto_effects.map((e, i) => (
                            <li key={i} className="text-xs text-parchment/65 flex gap-2">
                              <span className="text-brass/40">*</span> {e}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Zone selector — single */}
                  {instNeedsZone && !instNeedsMulti && (
                    <div>
                      <p className="text-xs text-blood/80 uppercase tracking-wider mb-1.5 font-semibold">
                        Designate affected zone (required)
                      </p>
                      {mapZones.length > 0 ? (
                        <select
                          className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm focus:outline-none focus:border-brass/60"
                          value={instSelectedZone}
                          onChange={(e) => setInstSelectedZone(e.target.value)}
                        >
                          <option value="">Select zone</option>
                          {mapZones.map(z => (
                            <option key={z.key} value={z.key}>{z.name}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm"
                          placeholder="Enter zone key (map_json not loaded)"
                          value={instSelectedZone}
                          onChange={(e) => setInstSelectedZone(e.target.value)}
                        />
                      )}
                    </div>
                  )}

                  {/* Zone selector — multi destroy */}
                  {instNeedsMulti && (
                    <div>
                      <p className="text-xs text-blood/80 uppercase tracking-wider mb-1.5 font-semibold">
                        Select {instDestroyCount} zone(s) to destroy ({instSelectedZones.length}/{instDestroyCount} selected)
                      </p>
                      <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto">
                        {mapZones.length > 0 ? mapZones.map(z => {
                          const sel = instSelectedZones.includes(z.key);
                          return (
                            <button
                              key={z.key}
                              onClick={() => toggleZone(z.key)}
                              className={`px-2 py-1.5 rounded border text-xs text-left transition-colors ${
                                sel
                                  ? "border-blood bg-blood/20 text-blood"
                                  : "border-brass/25 bg-void hover:border-brass/40 text-parchment/60"
                              }`}
                            >
                              {z.name}
                            </button>
                          );
                        }) : (
                          <p className="text-xs text-parchment/40 col-span-2">
                            No zones loaded.
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Status after confirm attempt */}
                  {instStatus && (
                    <p className={`text-xs ${instStatus.startsWith("Error") || instStatus.startsWith("Failed") ? "text-blood/70" : "text-brass/70"}`}>
                      {instStatus}
                    </p>
                  )}

                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="px-6 py-4 border-t border-brass/20 flex gap-3 flex-shrink-0">

              {/* Left: Re-roll or Skip (before rolling) */}
              {!instRoll ? (
                <button
                  onClick={closeInstModal}
                  className="flex-1 px-3 py-2 rounded border border-parchment/20 text-sm text-parchment/50 hover:text-parchment/70 hover:border-parchment/30 transition-colors"
                >
                  Skip Event
                </button>
              ) : (
                <button
                  onClick={() => { setInstRoll(null); setInstStatus(""); }}
                  className="px-3 py-2 rounded border border-brass/25 text-sm text-parchment/60 hover:text-parchment/90 hover:border-brass/40 transition-colors"
                >
                  Re-roll
                </button>
              )}

              {/* Middle: Skip after rolling */}
              {instRoll && (
                <button
                  onClick={closeInstModal}
                  disabled={instConfirming}
                  className="px-3 py-2 rounded border border-parchment/20 text-sm text-parchment/40 hover:text-parchment/60 hover:border-parchment/30 disabled:opacity-40 transition-colors"
                >
                  Skip
                </button>
              )}

              {/* Right: Confirm */}
              {instRoll && (
                <button
                  onClick={confirmInstability}
                  disabled={!instCanConfirm}
                  className="flex-1 px-3 py-2 rounded bg-blood/20 border border-blood/50 hover:bg-blood/30 text-sm font-semibold text-blood disabled:opacity-40 transition-colors"
                >
                  {instConfirming ? (
                    <span className="flex items-center justify-center gap-1.5">
                      <span className="w-3.5 h-3.5 border-2 border-blood/30 border-t-blood rounded-full animate-spin" />
                      Applying...
                    </span>
                  ) : "Confirm & Post to Bulletin"}
                </button>
              )}

            </div>

          </div>
        </div>
      )}

    </Frame>
  );
}