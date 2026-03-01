"use client";
import React, { useEffect, useMemo, useState } from "react";
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
  invite_message: string | null;
  map_id: string | null;
  rules_overrides: Record<string, unknown> | null;
};

type Round  = { stage: string };

type Member = {
  user_id: string;
  role: string;
  faction_name: string | null;
  faction_key: string | null;
  commander_name: string | null;
  faction_locked: boolean;
};

type MapZone = { key: string; name: string; sectors: { key: string }[] };
type MapJson = { zone_cols?: number; zones?: MapZone[] };

interface EffectJson {
  type: string;
  amount?: number;
  nip?: number;
  ncp?: number;
  count?: number;
  cost?: number;
  rule?: string;
  instruction?: string;
}

interface RollResult {
  d10: number;
  threshold_band: number;
  new_instability: number;
  current_instability: number;
  event_name: string;
  public_text: string;
  effect: EffectJson;
  auto_effects: string[];
  needs_zone_selection: boolean;
  needs_zone_destroy: boolean;
  destroy_count: number;
}

// Stage order must match advance-round edge function
const STAGE_ORDER = ["spend", "movement", "recon", "conflicts", "missions", "results", "publish"];

function getQueryCampaign(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("campaign");
}

function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LeadControls() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [campaignId, setCampaignId] = useState<string>("");
  const [campaign, setCampaign]     = useState<Campaign | null>(null);
  const [round, setRound]           = useState<Round | null>(null);
  const [role, setRole]             = useState<string>("player");
  const [members, setMembers]       = useState<Member[]>([]);
  const [mapJson, setMapJson]       = useState<MapJson | null>(null);

  // Invite
  const [inviteEmails, setInviteEmails]   = useState<string>("");
  const [isLateInvite, setIsLateInvite]   = useState<boolean>(false);
  const [inviteStatus, setInviteStatus]   = useState<string>("");
  const [sendingInvite, setSendingInvite] = useState<boolean>(false);

  // Archive / Delete / Chronicle
  const [deleteConfirm, setDeleteConfirm]             = useState(false);
  const [deleting, setDeleting]                       = useState(false);
  const [archiving, setArchiving]                     = useState(false);
  const [generatingChronicle, setGeneratingChronicle] = useState(false);
  const [chronicle, setChronicle]                     = useState<string | null>(null);
  const [showChronicle, setShowChronicle]             = useState(false);

  // Eliminated players
  const [playerStates, setPlayerStates]       = useState<{ user_id: string; status: string }[]>([]);
  const [reinstating, setReinstating]         = useState<string | null>(null);
  const [reinstateStatus, setReinstateStatus] = useState<Record<string, string>>({});

  // Advance / Assign
  const [advanceStatus, setAdvanceStatus] = useState<string>("");
  const [advancing, setAdvancing]         = useState(false);
  const [assignStatus, setAssignStatus]   = useState<string>("");
  const [assigning, setAssigning]         = useState(false);

  // Start campaign
  const [startStatus, setStartStatus] = useState<string>("");

  // Active conflicts count (gate assign missions)
  const [activeConflictCount, setActiveConflictCount] = useState(0);

  // Force conflict (testing only)
  const [showForceConflict, setShowForceConflict] = useState(false);
  const [forcePlayerA, setForcePlayerA]           = useState("");
  const [forcePlayerB, setForcePlayerB]           = useState("");
  const [forceZone, setForceZone]                 = useState("");
  const [forceSector, setForceSector]             = useState("");
  const [forceStatus, setForceStatus]             = useState("");
  const [forceRunning, setForceRunning]           = useState(false);

  // Instability — roll / confirm
  const [rollResult, setRollResult]                         = useState<RollResult | null>(null);
  const [instabilityRolling, setInstabilityRolling]         = useState(false);
  const [instabilityConfirming, setInstabilityConfirming]   = useState(false);
  const [instabilityStatus, setInstabilityStatus]           = useState<string>("");
  const [selectedDestroyZones, setSelectedDestroyZones]     = useState<string[]>([]);
  const [selectedZone, setSelectedZone]                     = useState<string>("");

  // ── Derived ───────────────────────────────────────────────────────────────────

  const campaignStarted = round !== null;
  const allowed         = role === "lead" || role === "admin";
  const currentStage    = round?.stage ?? null;

  const playerCount = members.filter((m) => m.role === "player").length;
  const leadCount   = members.filter((m) => m.role === "lead").length;
  const lockedCount = members.filter((m) => m.faction_locked).length;

  const showAssignMissions =
    allowed && currentStage === "missions" && activeConflictCount > 0;

  const destroyedZones =
    (campaign?.rules_overrides?.destroyed_zones as string[] | undefined) ?? [];
  const availableZones =
    (mapJson?.zones ?? []).filter((z) => !destroyedZones.includes(z.key));

  const instabilityConfirmDisabled =
    instabilityConfirming ||
    (rollResult?.needs_zone_destroy &&
      selectedDestroyZones.length < (rollResult?.destroy_count ?? 1)) ||
    (rollResult?.needs_zone_selection && !selectedZone);

  // ── Load ──────────────────────────────────────────────────────────────────────

  const load = async (cid: string) => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return;

    const { data: mem } = await supabase
      .from("campaign_members").select("role")
      .eq("campaign_id", cid).eq("user_id", uid).single();
    setRole(mem?.role ?? "player");

    const { data: c, error: cErr } = await supabase
      .from("campaigns")
      .select("id,name,phase,round_number,instability,invite_message,map_id,rules_overrides")
      .eq("id", cid).single();
    if (cErr || !c) { setCampaign(null); setRound(null); return; }
    setCampaign(c as Campaign);

    const { data: r } = await supabase
      .from("rounds").select("stage")
      .eq("campaign_id", cid).eq("round_number", c.round_number).maybeSingle();
    setRound(r ?? null);

    const [membersRes, psRes, conflictsRes] = await Promise.all([
      supabase.from("campaign_members")
        .select("user_id,role,faction_name,faction_key,commander_name,faction_locked")
        .eq("campaign_id", cid).order("role"),
      supabase.from("player_state")
        .select("user_id,status").eq("campaign_id", cid),
      supabase.from("conflicts")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", cid)
        .eq("round_number", c.round_number)
        .neq("status", "resolved"),
    ]);
    setMembers((membersRes.data ?? []) as Member[]);
    setPlayerStates((psRes.data ?? []) as { user_id: string; status: string }[]);
    setActiveConflictCount(conflictsRes.count ?? 0);

    // Map (needed for zone selection in instability events)
    if ((c as any).map_id) {
      const { data: mapRow } = await supabase
        .from("maps").select("map_json")
        .eq("id", (c as any).map_id).maybeSingle();
      if (mapRow?.map_json) setMapJson(mapRow.map_json as MapJson);
    }
  };

  useEffect(() => {
    const q = getQueryCampaign();
    if (q) setCampaignId(q);
  }, []);

  useEffect(() => {
    if (campaignId) load(campaignId);
  }, [campaignId]);

  useEffect(() => {
    if (campaignStarted) setIsLateInvite(true);
  }, [campaignStarted]);

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const getToken = async (): Promise<string | null> => {
    const { data: sess } = await supabase.auth.getSession();
    return sess.session?.access_token ?? null;
  };

  const callFnStatus = async (
    fn: string,
    setStatus: (s: string) => void,
    setRunning: (b: boolean) => void,
    extraBody?: Record<string, unknown>
  ) => {
    const token = await getToken();
    if (!token) { setStatus("Session expired — refresh."); return; }
    setRunning(true);
    setStatus("");
    try {
      const { data, error } = await supabase.functions.invoke(fn, {
        body: { campaign_id: campaignId, ...extraBody },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Failed");
      if (fn === "advance-round") {
        const label = (data.stage as string).charAt(0).toUpperCase() + (data.stage as string).slice(1);
        const conflictsNote = data.conflicts_created
          ? ` ${data.conflicts_created} conflict(s) detected.`
          : "";
        setStatus(`Advanced to: ${label}.${conflictsNote}`);
      } else if (fn === "assign-missions") {
        setStatus(`Missions assigned: ${data.assigned ?? 0} conflict(s) updated.`);
      } else {
        setStatus("Done.");
      }
      await load(campaignId);
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setRunning(false);
    }
  };

  // ── Actions ───────────────────────────────────────────────────────────────────

  const startCampaign = async () => {
    if (campaignStarted) return;
    setStartStatus("Starting campaign…");
    const token = await getToken();
    if (!token) { setStartStatus("Session expired — refresh."); return; }
    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "initial" },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) { setStartStatus(`Error: ${error.message}`); return; }
    setStartStatus(`Started — ${data?.allocated ?? 0} locations allocated.`);
    await load(campaignId);
  };

  const rollInstability = async () => {
    setInstabilityRolling(true);
    setInstabilityStatus("");
    setRollResult(null);
    setSelectedDestroyZones([]);
    setSelectedZone("");
    const token = await getToken();
    if (!token) { setInstabilityStatus("Session expired."); setInstabilityRolling(false); return; }
    try {
      const { data, error } = await supabase.functions.invoke("apply-instability", {
        body: { campaign_id: campaignId, mode: "roll" },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Roll failed");
      setRollResult(data as RollResult);
    } catch (e: any) {
      setInstabilityStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setInstabilityRolling(false);
    }
  };

  const confirmInstability = async () => {
    if (!rollResult) return;
    setInstabilityConfirming(true);
    setInstabilityStatus("");
    const token = await getToken();
    if (!token) { setInstabilityStatus("Session expired."); setInstabilityConfirming(false); return; }
    try {
      const { data, error } = await supabase.functions.invoke("apply-instability", {
        body: {
          campaign_id:          campaignId,
          mode:                 "confirm",
          d10_result:           rollResult.d10,
          expected_instability: rollResult.current_instability,
          selected_zones:       selectedDestroyZones,
          selected_zone:        selectedZone,
        },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Confirm failed");
      const phaseNote = data.phase_changed ? ` Phase advanced to ${data.new_phase}.` : "";
      setInstabilityStatus(
        `Applied: ${data.event_name}. Instability now ${data.instability}/10.${phaseNote} Posted to bulletin.`
      );
      setRollResult(null);
      setSelectedDestroyZones([]);
      setSelectedZone("");
      await load(campaignId);
    } catch (e: any) {
      setInstabilityStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setInstabilityConfirming(false);
    }
  };

  const forceConflict = async () => {
    if (!forcePlayerA || !forcePlayerB || !forceZone || !forceSector) return;
    setForceRunning(true);
    setForceStatus("");
    const token = await getToken();
    if (!token) { setForceStatus("Session expired."); setForceRunning(false); return; }
    try {
      const { data: camp } = await supabase
        .from("campaigns").select("round_number").eq("id", campaignId).single();
      const { error } = await supabase.from("conflicts").insert({
        campaign_id:    campaignId,
        round_number:   camp?.round_number ?? 1,
        zone_key:       forceZone,
        sector_key:     forceSector,
        player_a:       forcePlayerA,
        player_b:       forcePlayerB,
        mission_status: "unassigned",
        status:         "scheduled",
        twist_tags:     [],
      });
      if (error) throw error;
      setForceStatus("Conflict created.");
      setShowForceConflict(false);
      setForcePlayerA(""); setForcePlayerB(""); setForceZone(""); setForceSector("");
      await load(campaignId);
    } catch (e: any) {
      setForceStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setForceRunning(false);
    }
  };

  const reinstatePlayer = async (userId: string) => {
    if (!campaignId) return;
    setReinstating(userId);
    setReinstateStatus((prev) => ({ ...prev, [userId]: "" }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Session expired — refresh.");
      const { data, error } = await supabase.functions.invoke("start-campaign", {
        body: { campaign_id: campaignId, mode: "late", late_user_id: userId },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Reinstatement failed");
      await supabase.from("player_state")
        .update({ status: "normal" })
        .eq("campaign_id", campaignId).eq("user_id", userId);
      setReinstateStatus((prev) => ({ ...prev, [userId]: "Reinstated — new sector allocated." }));
      await load(campaignId);
    } catch (e: any) {
      setReinstateStatus((prev) => ({ ...prev, [userId]: "Error: " + (e?.message ?? "Unknown") }));
    } finally {
      setReinstating(null);
    }
  };

  // ── Archive / Chronicle / Delete ──────────────────────────────────────────────

  const fetchAllCampaignData = async () => {
    const [membersRes, roundsRes, ledgerRes, conflictsRes, playerStateRes,
           campaignEventsRes, campaignRelicsRes, movesRes, postsRes] = await Promise.all([
      supabase.from("campaign_members").select("*").eq("campaign_id", campaignId),
      supabase.from("rounds").select("*").eq("campaign_id", campaignId).order("round_number"),
      supabase.from("ledger").select("*").eq("campaign_id", campaignId).order("created_at"),
      supabase.from("conflicts").select("*, missions(name, description, mission_type)").eq("campaign_id", campaignId),
      supabase.from("player_state").select("*").eq("campaign_id", campaignId),
      supabase.from("campaign_events").select("*").eq("campaign_id", campaignId).order("round_number"),
      supabase.from("campaign_relics").select("*, relics(name, lore, rarity)").eq("campaign_id", campaignId),
      supabase.from("moves").select("*").eq("campaign_id", campaignId).order("round_number"),
      supabase.from("posts").select("*").eq("campaign_id", campaignId).order("round_number"),
    ]);
    const conflictIds = (conflictsRes.data ?? []).map((c: any) => c.id);
    let battleResults: any[] = [];
    if (conflictIds.length) {
      const { data } = await supabase.from("battle_results").select("*").in("conflict_id", conflictIds);
      battleResults = data ?? [];
    }
    return {
      members:          membersRes.data ?? [],
      rounds:           roundsRes.data ?? [],
      ledger:           ledgerRes.data ?? [],
      conflicts:        conflictsRes.data ?? [],
      player_state:     playerStateRes.data ?? [],
      battle_results:   battleResults,
      campaign_events:  campaignEventsRes.data ?? [],
      campaign_relics:  campaignRelicsRes.data ?? [],
      moves:            movesRes.data ?? [],
      posts:            (postsRes.data ?? []).filter((p: any) => p.visibility === "public"),
    };
  };

  const archiveCampaign = async () => {
    if (!campaignId || !campaign) return;
    setArchiving(true);
    try {
      const data = await fetchAllCampaignData();
      const blob = new Blob(
        [JSON.stringify({ exported_at: new Date().toISOString(), campaign, chronicle: chronicle ?? null, ...data }, null, 2)],
        { type: "application/json" }
      );
      const url = URL.createObjectURL(blob);
      const a   = document.createElement("a");
      a.href = url; a.download = `${campaign.name.replace(/[^a-z0-9]/gi, "_")}_archive.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { alert("Archive failed: " + (e?.message ?? "Unknown")); }
    finally { setArchiving(false); }
  };

  const generateChronicle = async () => {
    if (!campaignId || !campaign) return;
    setGeneratingChronicle(true);
    setShowChronicle(true);
    setChronicle(null);
    try {
      const data          = await fetchAllCampaignData();
      const memberSummary = data.members.map((m: any) =>
        `${m.commander_name ?? "Unknown"} (${m.faction_name ?? "Unknown"}, ${m.role})`
      ).join(", ");
      const finalStandings = data.player_state.map((ps: any) => {
        const m = data.members.find((x: any) => x.user_id === ps.user_id);
        return `${m?.commander_name ?? m?.faction_name ?? ps.user_id.slice(0, 8)}: ${ps.ncp} NCP, ${ps.nip} NIP`;
      }).join("\n");
      const conflictSummary = data.conflicts.map((c: any) => {
        const r  = data.battle_results.find((br: any) => br.conflict_id === c.id);
        const w  = r ? data.members.find((m: any) => m.user_id === r.winner_user_id) : null;
        const pA = data.members.find((m: any) => m.user_id === c.player_a);
        const pB = data.members.find((m: any) => m.user_id === c.player_b);
        return `Round ${c.round_number} — ${c.zone_key}:${c.sector_key}: ${pA?.faction_name ?? "?"} vs ${pB?.faction_name ?? "?"}, winner: ${w?.faction_name ?? "unresolved"}`;
      }).join("\n");
      const prompt = `You are a Warhammer 40,000 campaign chronicler. Write a vivid grimdark narrative summary.\n\nCAMPAIGN: ${campaign.name}\nRounds: ${data.rounds.length}, Instability: ${campaign.instability}/10\n\nCOMBATANTS:\n${memberSummary}\n\nSTANDINGS:\n${finalStandings || "None recorded."}\n\nBATTLES:\n${conflictSummary || "None recorded."}\n\nWrite 4-6 paragraphs. Flowing prose only, no bullet points.`;
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setChronicle("Session expired."); return; }
      const { data: genData, error: genErr } = await supabase.functions.invoke("generate-narrative", {
        body: { prompt, max_tokens: 1500 },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (genErr) throw genErr;
      if (!genData?.ok) throw new Error(genData?.error ?? "Generation failed");
      setChronicle(genData?.text ?? "No response.");
    } catch (e: any) {
      setChronicle("Chronicle failed: " + (e?.message ?? "Unknown"));
    } finally {
      setGeneratingChronicle(false);
    }
  };

  const deleteCampaign = async () => {
    if (!campaignId) return;
    setDeleting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const { data, error } = await supabase.functions.invoke("delete-campaign", {
        body: { campaign_id: campaignId },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Delete failed");
      alert("Campaign deleted.");
      window.location.href = "/";
    } catch (e: any) {
      alert("Delete failed: " + (e?.message ?? "Unknown"));
    } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };

  const sendInvites = async () => {
    const emails = inviteEmails.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return alert("Enter at least one email address.");
    setSendingInvite(true);
    setInviteStatus("");
    try {
      const token = await getToken();
      if (!token) return;
      const { data, error } = await supabase.functions.invoke("invite-players", {
        body: { campaign_id: campaignId, player_emails: emails },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Failed");
      const parts = [];
      if (data.sent > 0)           parts.push(`${data.sent} invite${data.sent > 1 ? "s" : ""} sent`);
      if (data.existing_users > 0) parts.push(`${data.existing_users} existing player${data.existing_users > 1 ? "s" : ""} notified`);
      if (data.failed > 0)         parts.push(`${data.failed} failed`);
      setInviteStatus(
        parts.join(" · ") + "." +
        (isLateInvite ? " Allocate their sector once they join." : " They will auto-join on sign in.")
      );
      setInviteEmails("");
      await load(campaignId);
    } catch (e: any) {
      setInviteStatus(`Error: ${e?.message ?? "Failed."}`);
    } finally {
      setSendingInvite(false);
    }
  };

  // ── Style helpers ─────────────────────────────────────────────────────────────

  const roleBadge = (r: string) => {
    if (r === "lead")  return "bg-brass/20 text-brass border border-brass/40";
    if (r === "admin") return "bg-blood/20 text-blood border border-blood/40";
    return "bg-iron/40 text-parchment/70 border border-parchment/20";
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Frame title="Lead Controls" campaignId={campaignId} role={role} currentPage="lead">
      <div className="space-y-6">

        {/* ── 1. Campaign ── */}
        <Card title="Campaign">
          {campaign && (
            <div className="space-y-5 text-parchment/80">

              {/* Header */}
              <div className="space-y-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-brass font-semibold text-lg">{campaign.name}</span>
                  {campaignStarted ? (
                    <span className="text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide bg-brass/20 text-brass border border-brass/40">
                      Running
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide bg-iron/40 text-parchment/50 border border-parchment/20">
                      Not started
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-brass">Phase:</span> {campaign.phase} &nbsp;
                  <span className="text-brass">Round:</span> {campaign.round_number} &nbsp;
                  <span className="text-brass">Instability:</span>{" "}
                  <span className={
                    campaign.instability >= 8 ? "text-blood font-semibold" :
                    campaign.instability >= 4 ? "text-yellow-500/80" :
                    "text-parchment/80"
                  }>
                    {campaign.instability}/10
                  </span>
                </div>
                {currentStage && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-brass">Stage:</span>
                    {STAGE_ORDER.map((s, i) => (
                      <span
                        key={s}
                        className={[
                          "text-xs px-2 py-0.5 rounded font-mono capitalize",
                          s === currentStage
                            ? "bg-brass/25 text-brass border border-brass/50"
                            : STAGE_ORDER.indexOf(currentStage) > i
                            ? "text-parchment/25"
                            : "text-parchment/40",
                        ].join(" ")}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                <div><span className="text-brass">Your role:</span> {role}</div>
              </div>

              {/* ── Start Campaign ── */}
              <div className="border-t border-brass/20 pt-4">
                <p className="text-parchment/60 text-sm mb-2">
                  {campaignStarted
                    ? "Campaign is running. Starting locations have been allocated."
                    : "Allocates secret starting locations for all current players. Campaign opens at the Spend phase."}
                </p>
                <button
                  disabled={!allowed || campaignStarted}
                  className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm"
                  onClick={startCampaign}
                >
                  {campaignStarted ? "Campaign Already Started" : "Start Campaign"}
                </button>
                {startStatus && (
                  <p className={"mt-2 text-xs " + (startStatus.startsWith("Error") ? "text-blood/70" : "text-parchment/60")}>
                    {startStatus}
                  </p>
                )}
              </div>

              {/* ── Advance Stage ── */}
              {allowed && campaignStarted && (
                <div className="border-t border-brass/20 pt-4">
                  <div className="text-sm font-semibold text-parchment/90 mb-1">Advance Stage</div>
                  <p className="text-parchment/60 text-xs mb-3">
                    Round order: spend → movement → recon → conflicts → missions → results → publish → (next round).
                    Advancing from movement automatically detects conflicts.
                  </p>
                  <button
                    disabled={!allowed || advancing}
                    className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm"
                    onClick={() => callFnStatus("advance-round", setAdvanceStatus, setAdvancing)}
                  >
                    {advancing
                      ? "Advancing…"
                      : currentStage === "publish"
                      ? "Publish & Start Next Round"
                      : `Advance from ${currentStage ?? "—"}`}
                  </button>
                  {advanceStatus && (
                    <p className={"mt-2 text-xs " + (advanceStatus.startsWith("Error") ? "text-blood/70" : "text-parchment/60")}>
                      {advanceStatus}
                    </p>
                  )}
                </div>
              )}

              {/* ── Assign Missions (missions stage + conflicts exist) ── */}
              {showAssignMissions && (
                <div className="border-t border-brass/20 pt-4">
                  <div className="text-sm font-semibold text-parchment/90 mb-1">Assign Missions</div>
                  <p className="text-parchment/60 text-xs mb-3">
                    Draws missions for each active conflict, respecting any NIP-purchased player preferences.
                    {activeConflictCount > 0 && (
                      <span className="ml-1 text-brass">
                        {activeConflictCount} unresolved conflict{activeConflictCount > 1 ? "s" : ""} this round.
                      </span>
                    )}
                  </p>
                  <button
                    disabled={!allowed || assigning}
                    className="px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40 text-sm"
                    onClick={() => callFnStatus("assign-missions", setAssignStatus, setAssigning)}
                  >
                    {assigning ? "Assigning…" : "Assign Missions"}
                  </button>
                  {assignStatus && (
                    <p className={"mt-2 text-xs " + (assignStatus.startsWith("Error") ? "text-blood/70" : "text-parchment/60")}>
                      {assignStatus}
                    </p>
                  )}
                </div>
              )}

              {/* ── Apply Instability (results stage only) ── */}
              {allowed && campaignStarted && currentStage === "results" && (
                <div className="border-t border-brass/20 pt-4">
                  <div className="text-sm font-semibold text-parchment/90 mb-1">Apply Instability</div>
                  <p className="text-parchment/60 text-xs mb-3">
                    Roll a d10 instability event for this game day and post the outcome to the War Bulletin.
                    Current instability:{" "}
                    <span className={
                      campaign.instability >= 8 ? "text-blood font-semibold" :
                      campaign.instability >= 4 ? "text-yellow-500/80" :
                      "text-brass"
                    }>
                      {campaign.instability}/10
                    </span>.
                  </p>

                  {!rollResult ? (
                    <button
                      disabled={instabilityRolling}
                      className="px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40 text-sm"
                      onClick={rollInstability}
                    >
                      {instabilityRolling ? "Rolling…" : "Roll Instability Event"}
                    </button>
                  ) : (
                    <div className="space-y-4">

                      {/* Event result card */}
                      <div className="rounded border border-blood/40 bg-blood/5 p-4 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-sm font-semibold text-parchment/90">{rollResult.event_name}</div>
                            <div className="text-xs text-blood/60 mt-0.5">
                              Roll: {rollResult.d10} &nbsp;·&nbsp;
                              Band: {rollResult.threshold_band === 0 ? "1–3" : rollResult.threshold_band === 4 ? "4–7" : "8–10"} &nbsp;·&nbsp;
                              Instability after: {rollResult.new_instability}/10
                            </div>
                          </div>
                          <button
                            disabled={instabilityConfirming}
                            className="text-xs text-parchment/30 hover:text-parchment/60 shrink-0 disabled:opacity-40"
                            onClick={() => { setRollResult(null); setInstabilityStatus(""); }}
                          >
                            ✕ Cancel
                          </button>
                        </div>

                        <p className="text-parchment/70 text-xs leading-relaxed italic">{rollResult.public_text}</p>

                        {/* Automated effects */}
                        {rollResult.auto_effects.length > 0 && (
                          <div className="pt-2 border-t border-blood/20">
                            <div className="text-xs text-parchment/45 uppercase tracking-widest mb-1.5">
                              Applied automatically on confirm
                            </div>
                            {rollResult.auto_effects.map((ef, i) => (
                              <div key={i} className="text-xs text-parchment/70">• {ef}</div>
                            ))}
                          </div>
                        )}

                        {/* Battle rule */}
                        {rollResult.effect.type === "battle_rule" && rollResult.effect.rule && (
                          <div className="pt-2 border-t border-blood/20">
                            <div className="text-xs text-brass/70 uppercase tracking-widest mb-1.5">
                              Battle condition this round
                            </div>
                            <p className="text-xs text-parchment/70">{rollResult.effect.rule}</p>
                          </div>
                        )}

                        {/* Manual instruction */}
                        {rollResult.effect.type === "manual" && rollResult.effect.instruction && (
                          <div className="pt-2 border-t border-blood/20">
                            <div className="text-xs text-brass/70 uppercase tracking-widest mb-1.5">
                              Lead action required
                            </div>
                            <p className="text-xs text-parchment/70">{rollResult.effect.instruction}</p>
                          </div>
                        )}

                        {/* Zone destruction selection */}
                        {rollResult.needs_zone_destroy && (
                          <div className="pt-2 border-t border-blood/20">
                            <div className="text-xs text-blood/70 uppercase tracking-widest mb-2">
                              Select {rollResult.destroy_count} zone{rollResult.destroy_count !== 1 ? "s" : ""} to destroy
                              <span className="ml-2 text-parchment/35 normal-case font-normal">
                                ({selectedDestroyZones.length}/{rollResult.destroy_count} selected)
                              </span>
                            </div>
                            {availableZones.length === 0 ? (
                              <p className="text-xs text-parchment/40 italic">No zones available — all already destroyed.</p>
                            ) : (
                              <div className="grid grid-cols-2 gap-1.5">
                                {availableZones.map((z) => {
                                  const isSelected  = selectedDestroyZones.includes(z.key);
                                  const maxReached  = selectedDestroyZones.length >= rollResult.destroy_count && !isSelected;
                                  return (
                                    <label
                                      key={z.key}
                                      className={[
                                        "flex items-center gap-2 text-xs p-2 rounded border cursor-pointer transition-colors",
                                        isSelected  ? "border-blood/60 bg-blood/15 text-parchment/90" :
                                        maxReached  ? "border-brass/10 text-parchment/30 cursor-not-allowed" :
                                                      "border-brass/20 text-parchment/60 hover:border-brass/40",
                                      ].join(" ")}
                                    >
                                      <input
                                        type="checkbox"
                                        className="shrink-0"
                                        checked={isSelected}
                                        disabled={maxReached}
                                        onChange={(e) => {
                                          if (e.target.checked)
                                            setSelectedDestroyZones((prev) => [...prev, z.key]);
                                          else
                                            setSelectedDestroyZones((prev) => prev.filter((k) => k !== z.key));
                                        }}
                                      />
                                      {z.name ?? titleCase(z.key)}
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                            {destroyedZones.length > 0 && (
                              <p className="text-xs text-parchment/30 mt-1.5">
                                Already destroyed: {destroyedZones.map(titleCase).join(", ")}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Zone selection (hazard / impassable / sensor blind / penalty) */}
                        {rollResult.needs_zone_selection && (
                          <div className="pt-2 border-t border-blood/20">
                            <div className="text-xs text-blood/70 uppercase tracking-widest mb-2">
                              {rollResult.effect.type === "zone_battle_hazard"
                                ? "Designate battle hazard zone"
                                : rollResult.effect.type === "zone_nip_penalty"
                                ? "Select zone — players there lose NIP"
                                : "Select zone affected this round"}
                            </div>
                            <select
                              className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                              value={selectedZone}
                              onChange={(e) => setSelectedZone(e.target.value)}
                            >
                              <option value="">— Select zone —</option>
                              {(mapJson?.zones ?? []).map((z) => (
                                <option key={z.key} value={z.key}>
                                  {z.name ?? titleCase(z.key)}
                                </option>
                              ))}
                            </select>
                            {rollResult.effect.instruction && (
                              <p className="text-xs text-parchment/40 mt-1.5 italic">
                                {rollResult.effect.instruction}
                              </p>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Confirm / Re-roll */}
                      <div className="flex items-center gap-3 flex-wrap">
                        <button
                          disabled={instabilityConfirmDisabled}
                          className="px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40 text-sm"
                          onClick={confirmInstability}
                        >
                          {instabilityConfirming ? "Applying…" : "Confirm & Post to Bulletin"}
                        </button>
                        <button
                          disabled={instabilityConfirming}
                          className="text-xs text-parchment/40 hover:text-parchment/60 underline disabled:opacity-40"
                          onClick={rollInstability}
                        >
                          Re-roll
                        </button>
                      </div>
                    </div>
                  )}

                  {instabilityStatus && (
                    <p className={"mt-2 text-xs " + (instabilityStatus.startsWith("Error") ? "text-blood/70" : "text-parchment/60")}>
                      {instabilityStatus}
                    </p>
                  )}
                </div>
              )}

              {/* ── Force conflict (testing) ── */}
              {allowed && campaignStarted && (
                <div className="border-t border-brass/15 pt-3">
                  <button
                    className="text-xs text-parchment/35 hover:text-parchment/60 underline"
                    onClick={() => setShowForceConflict((v) => !v)}
                  >
                    {showForceConflict ? "▲ Hide" : "▼ Force conflict (testing)"}
                  </button>

                  {showForceConflict && (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-parchment/40 italic">
                        Manually create a conflict — useful for testing before real moves are in play.
                      </p>
                      <div>
                        <label className="text-xs text-parchment/50 mb-0.5 block">Player A</label>
                        <select className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                          value={forcePlayerA} onChange={(e) => setForcePlayerA(e.target.value)}>
                          <option value="">— Select —</option>
                          {members.map((m) => (
                            <option key={m.user_id} value={m.user_id}>
                              {m.faction_name ?? m.commander_name ?? m.user_id.slice(0, 8)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-parchment/50 mb-0.5 block">Player B</label>
                        <select className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                          value={forcePlayerB} onChange={(e) => setForcePlayerB(e.target.value)}>
                          <option value="">— Select —</option>
                          {members.filter((m) => m.user_id !== forcePlayerA).map((m) => (
                            <option key={m.user_id} value={m.user_id}>
                              {m.faction_name ?? m.commander_name ?? m.user_id.slice(0, 8)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-parchment/50 mb-0.5 block">Zone key</label>
                          <input className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                            placeholder="e.g. vault_ruins" value={forceZone} onChange={(e) => setForceZone(e.target.value)} />
                        </div>
                        <div>
                          <label className="text-xs text-parchment/50 mb-0.5 block">Sector key</label>
                          <input className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                            placeholder="e.g. b" value={forceSector} onChange={(e) => setForceSector(e.target.value)} />
                        </div>
                      </div>
                      <button
                        disabled={!forcePlayerA || !forcePlayerB || !forceZone || !forceSector || forceRunning}
                        className="w-full px-3 py-1.5 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-xs disabled:opacity-40"
                        onClick={forceConflict}
                      >
                        {forceRunning ? "Creating…" : "Create Conflict"}
                      </button>
                      {forceStatus && (
                        <p className={"text-xs " + (forceStatus.startsWith("Error") ? "text-blood/70" : "text-parchment/50")}>
                          {forceStatus}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Chronicle / Archive / Delete ── */}
              {allowed && (
                <div className="border-t border-brass/20 pt-4 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={generatingChronicle}
                      className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs text-parchment/80 disabled:opacity-40"
                      onClick={generateChronicle}
                    >
                      {generatingChronicle ? "Generating Chronicle…" : "✦ Generate Chronicle"}
                    </button>
                    <button
                      disabled={archiving}
                      className="px-3 py-1.5 rounded bg-iron/40 border border-parchment/20 hover:bg-iron/60 text-xs text-parchment/60 disabled:opacity-40"
                      onClick={archiveCampaign}
                    >
                      {archiving ? "Exporting…" : "↓ Export Archive"}
                    </button>
                    {!deleteConfirm ? (
                      <button
                        className="px-3 py-1.5 rounded bg-blood/10 border border-blood/30 hover:bg-blood/20 text-xs text-blood/70"
                        onClick={() => setDeleteConfirm(true)}
                      >
                        Delete Campaign
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-blood/80">
                          Delete <span className="font-semibold">{campaign.name}</span>? This cannot be undone.
                        </span>
                        <button
                          disabled={deleting}
                          className="px-3 py-1.5 rounded bg-blood/30 border border-blood/60 text-xs text-blood font-semibold disabled:opacity-40"
                          onClick={deleteCampaign}
                        >
                          {deleting ? "Deleting…" : "Confirm Delete"}
                        </button>
                        <button
                          className="px-3 py-1.5 rounded border border-parchment/20 text-xs text-parchment/50 hover:text-parchment/70"
                          onClick={() => setDeleteConfirm(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>

                  {showChronicle && (
                    <div className="rounded border border-brass/30 bg-void/80">
                      <div className="flex items-center justify-between px-4 py-2 border-b border-brass/20">
                        <span className="text-xs uppercase tracking-widest text-brass/70 font-semibold">Campaign Chronicle</span>
                        <div className="flex gap-2">
                          {chronicle && (
                            <button className="text-xs text-parchment/40 hover:text-parchment/70 underline"
                              onClick={() => navigator.clipboard.writeText(chronicle)}>Copy</button>
                          )}
                          <button className="text-xs text-parchment/40 hover:text-parchment/70"
                            onClick={() => setShowChronicle(false)}>✕ Close</button>
                        </div>
                      </div>
                      <div className="px-4 py-4">
                        {generatingChronicle ? (
                          <div className="space-y-2">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <div key={n} className="h-3 rounded bg-brass/10 animate-pulse" style={{ width: `${70 + n * 5}%` }} />
                            ))}
                            <p className="text-xs text-parchment/30 mt-3 italic">The chronicler is consulting the records…</p>
                          </div>
                        ) : chronicle ? (
                          <p className="text-parchment/80 text-sm leading-relaxed whitespace-pre-wrap">{chronicle}</p>
                        ) : (
                          <p className="text-parchment/40 text-sm italic">No chronicle generated yet.</p>
                        )}
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-parchment/30">
                    Chronicle uses AI to summarise the campaign narrative. Export Archive downloads all campaign data as JSON.
                  </p>
                </div>
              )}

            </div>
          )}

          {!allowed && (
            <p className="mt-3 text-blood/80">You are not authorised for leader controls in this campaign.</p>
          )}
        </Card>

        {/* ── 2. Active Players + Invite ── */}
        {campaign && (
          <Card title={`Active Players — ${members.length} enrolled (${leadCount} lead · ${playerCount} player · ${lockedCount} locked)`}>
            {members.length === 0 ? (
              <p className="text-parchment/60 mb-4">No members yet.</p>
            ) : (
              <div className="space-y-2 mb-5">
                {members.map((m) => (
                  <div key={m.user_id}
                    className="flex flex-col sm:flex-row sm:items-center gap-2 rounded border border-brass/20 bg-void px-4 py-3"
                  >
                    <span className={`text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide shrink-0 w-fit ${roleBadge(m.role)}`}>
                      {m.role}
                    </span>
                    <div className="flex-1 min-w-0">
                      {m.faction_name ? (
                        <>
                          <div className="text-parchment font-semibold truncate">
                            {m.faction_name}
                            {m.faction_key && <span className="ml-2 text-xs text-parchment/40 font-mono">({m.faction_key})</span>}
                          </div>
                          {m.commander_name && <div className="text-xs text-parchment/60">Cmdr: {m.commander_name}</div>}
                        </>
                      ) : (
                        <div className="text-parchment/40 italic text-sm">No faction chosen</div>
                      )}
                    </div>
                    <div className="text-xs shrink-0">
                      {m.faction_locked ? <span className="text-blood/80">🔒 Locked</span> : <span className="text-parchment/30">Unlocked</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {allowed && (
              <div className="pt-4 border-t border-brass/20 space-y-3">
                <div className="text-sm font-semibold text-parchment/80">Invite Players</div>
                <div>
                  <div className="text-xs text-parchment/60 mb-1">Email addresses (comma-separated)</div>
                  <input
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm"
                    placeholder="player@example.com, another@example.com"
                    value={inviteEmails}
                    onChange={(e) => setInviteEmails(e.target.value)}
                    disabled={sendingInvite}
                  />
                </div>
                <label className={`flex items-start gap-3 ${campaignStarted ? "opacity-70" : ""}`}>
                  <input type="checkbox" className="mt-0.5" checked={isLateInvite}
                    disabled={campaignStarted} onChange={(e) => setIsLateInvite(e.target.checked)} />
                  <div>
                    <div className="text-sm text-parchment/80">
                      Late player allocation
                      {campaignStarted && <span className="ml-2 text-xs text-blood/70">(required — campaign running)</span>}
                    </div>
                    <div className="text-xs text-parchment/50 mt-0.5">
                      Late players need their starting location allocated by the lead after joining.
                    </div>
                  </div>
                </label>
                <button
                  disabled={!inviteEmails.trim() || sendingInvite}
                  className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm"
                  onClick={sendInvites}
                >
                  {sendingInvite ? "Sending…" : "Send Invites"}
                </button>
                {inviteStatus && <p className="text-xs text-parchment/60 leading-relaxed">{inviteStatus}</p>}
              </div>
            )}
          </Card>
        )}

        {/* ── 3. Eliminated Players ── */}
        {campaign && (() => {
          const eliminated = playerStates.filter((ps) => ps.status === "inactive");
          if (!eliminated.length) return null;
          return (
            <Card title={`Eliminated Players — ${eliminated.length}`}>
              <p className="text-sm text-parchment/60 mb-3">
                These players have no sectors remaining. Reinstate to allocate a new sector and return them to play.
              </p>
              <div className="space-y-2">
                {eliminated.map((ps) => {
                  const m     = members.find((x) => x.user_id === ps.user_id);
                  const label = m?.faction_name ?? m?.commander_name ?? ps.user_id.slice(0, 8) + "…";
                  return (
                    <div key={ps.user_id}
                      className="flex items-center gap-3 rounded border border-blood/20 bg-blood/5 px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-parchment/80 font-semibold truncate">{label}</div>
                        {m?.faction_key && <div className="text-xs text-parchment/40 font-mono">{m.faction_key}</div>}
                        {reinstateStatus[ps.user_id] && (
                          <div className={`text-xs mt-0.5 ${reinstateStatus[ps.user_id].startsWith("Error") ? "text-blood/70" : "text-parchment/50"}`}>
                            {reinstateStatus[ps.user_id]}
                          </div>
                        )}
                      </div>
                      <span className="text-xs text-blood/60 font-mono uppercase shrink-0">Eliminated</span>
                      {allowed && (
                        <button
                          disabled={reinstating === ps.user_id}
                          className="shrink-0 px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs disabled:opacity-40"
                          onClick={() => reinstatePlayer(ps.user_id)}
                        >
                          {reinstating === ps.user_id ? "Reinstating…" : "Reinstate"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })()}

      </div>
    </Frame>
  );
}
