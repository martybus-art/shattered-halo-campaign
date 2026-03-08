"use client";
// src/app/conflicts/page.tsx
//
// changelog:
//   2026-03-08 — SECURITY: authChecked state added. load() now redirects
//                unauthenticated users to / immediately rather than silently
//                rendering an empty page. Spinner shown while auth resolves.
//   2026-03-08 — FEATURE: Alliance / Ceasefire system. Involved players can
//                now propose, withdraw, accept, or decline a ceasefire pact
//                on any scheduled conflict. Accepting calls the form-alliance
//                edge function which resolves the conflict as "allied" and
//                posts a public announcement to the War Bulletin.
//                Propose/withdraw/decline call the propose-alliance edge
//                function (admin-side, no client-side conflict UPDATE needed).
//   2026-03-08 — FEATURE: Battle Chronicle narratives are now also published
//                to the War Bulletin (posts table) by the generate-narrative
//                edge function. A "✓ Posted to War Bulletin" confirmation is
//                shown after generation succeeds.
//   2026-03-08 — SECURITY: replaced ?campaign=UUID URL pattern with
//                bootstrapCampaignId() from campaignSession. Campaign ID is
//                now stored in sessionStorage and wiped from the URL bar on
//                first load. Added no-campaign fallback state.

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { bootstrapCampaignId } from "@/lib/campaignSession";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// ── Types ─────────────────────────────────────────────────────────────────────
type Conflict = {
  id: string;
  campaign_id: string;
  round_number: number;
  zone_key: string;
  sector_key: string;
  player_a: string;
  player_b: string;
  mission_id: string | null;
  mission_status: string;
  twist_tags: string[];
  status: string;
  alliance_proposed_by: string | null;
};

type Mission = {
  id: string;
  name: string;
  description: string;
  mission_type: string;
};

type BattleResult = {
  id: string;
  conflict_id: string;
  reported_by: string;
  winner_user_id: string | null;
  outcome_json: Record<string, unknown>;
  confirmed: boolean;
};

type Member = {
  user_id: string;
  faction_name: string | null;
  faction_key: string | null;
  commander_name: string | null;
  role: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function memberLabel(members: Member[], userId: string): string {
  const m = members.find((x) => x.user_id === userId);
  if (!m) return userId.slice(0, 8) + "…";
  return m.faction_name ?? m.commander_name ?? userId.slice(0, 8) + "…";
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function ConflictsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // bootstrapCampaignId reads ?campaign= from URL (if present), saves to
  // sessionStorage, wipes from URL bar, then returns the ID.
  const [campaignId] = useState<string>(() => bootstrapCampaignId());

  const [uid, setUid]                   = useState<string | null>(null);
  const [role, setRole]                 = useState("player");
  const [authChecked, setAuthChecked]   = useState(false);
  const [roundNumber, setRoundNumber]   = useState(0);
  const [templateId, setTemplateId]     = useState<string | null>(null);
  const [conflicts, setConflicts]       = useState<Conflict[]>([]);
  const [missions, setMissions]         = useState<Mission[]>([]);
  const [members, setMembers]           = useState<Member[]>([]);
  const [results, setResults]           = useState<Record<string, BattleResult>>({});

  // Per-conflict UI state
  const [reportingFor, setReportingFor]           = useState<string | null>(null);
  const [winnerPick, setWinnerPick]               = useState<string>("");
  const [nipEarned, setNipEarned]                 = useState(2);
  const [ncpEarned, setNcpEarned]                 = useState(0);
  const [resultNotes, setResultNotes]             = useState("");
  const [submittingResult, setSubmittingResult]   = useState(false);
  const [resultStatus, setResultStatus]           = useState<Record<string, string>>({});

  // Mission influence state
  const [choosingMissionFor, setChoosingMissionFor] = useState<string | null>(null);
  const [pickedMission, setPickedMission]           = useState<string>("");
  const [influenceStatus, setInfluenceStatus]       = useState<Record<string, string>>({});

  // Narrative
  const [generatingFor, setGeneratingFor]     = useState<string | null>(null);
  const [narratives, setNarratives]           = useState<Record<string, string>>({});
  const [narrativePublished, setNarrativePublished] = useState<Record<string, boolean>>({});

  // Alliance state
  const [allianceWorking, setAllianceWorking] = useState<string | null>(null);
  const [allianceStatus, setAllianceStatus]   = useState<Record<string, string>>({});

  // ── Load ────────────────────────────────────────────────────────────────────
  const load = async (cid: string) => {
    const { data: userResp } = await supabase.auth.getUser();
    const currentUid = userResp.user?.id ?? null;
    if (!currentUid) { window.location.href = "/"; return; }
    setUid(currentUid);
    setAuthChecked(true);

    // No campaign in session — auth passed, show the no-campaign fallback
    if (!cid) return;

    if (currentUid) {
      const { data: mem } = await supabase
        .from("campaign_members")
        .select("role")
        .eq("campaign_id", cid)
        .eq("user_id", currentUid)
        .single();
      setRole(mem?.role ?? "player");
    }

    const { data: camp } = await supabase
      .from("campaigns")
      .select("round_number, template_id, phase")
      .eq("id", cid)
      .single();
    if (!camp) return;
    setRoundNumber(camp.round_number);
    setTemplateId(camp.template_id);

    const { data: allMembers } = await supabase
      .from("campaign_members")
      .select("user_id, faction_name, faction_key, commander_name, role")
      .eq("campaign_id", cid);
    setMembers(allMembers ?? []);

    const { data: conf } = await supabase
      .from("conflicts")
      .select("*")
      .eq("campaign_id", cid)
      .order("round_number", { ascending: false });
    setConflicts(conf ?? []);

    const { data: ms } = await supabase
      .from("missions")
      .select("id, name, description, mission_type")
      .eq("template_id", camp.template_id)
      .eq("is_active", true)
      .lte("phase_min", camp.phase ?? 1);
    setMissions(ms ?? []);

    if (conf?.length) {
      const ids = conf.map((c) => c.id);
      const { data: br } = await supabase
        .from("battle_results")
        .select("*")
        .in("conflict_id", ids);
      const brMap: Record<string, BattleResult> = {};
      (br ?? []).forEach((r) => { brMap[r.conflict_id] = r; });
      setResults(brMap);
    }
  };

  useEffect(() => {
    load(campaignId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Session token helper ─────────────────────────────────────────────────────
  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  // ── Mission influence ────────────────────────────────────────────────────────
  const submitInfluence = async (
    conflictId: string,
    type: "veto" | "choose" | "preference" | "twist",
    payload: Record<string, unknown>,
    nip: number
  ) => {
    if (!uid) return;
    const { error } = await supabase.from("mission_influence").insert({
      conflict_id: conflictId,
      user_id: uid,
      influence_type: type,
      nip_spent: nip,
      payload,
    });
    setInfluenceStatus((prev) => ({
      ...prev,
      [conflictId]: error ? "Error: " + error.message : "Influence recorded.",
    }));
    setChoosingMissionFor(null);
    setPickedMission("");
  };

  // ── Report battle result ─────────────────────────────────────────────────────
  const submitResult = async (conflict: Conflict) => {
    if (!uid || !winnerPick) return;
    setSubmittingResult(true);
    try {
      const existing      = results[conflict.id];
      const winnerUserId  = winnerPick === "draw" ? null : winnerPick;
      const isConfirming  = existing && !existing.confirmed && existing.reported_by !== uid;

      if (isConfirming) {
        const reportedWinner = (existing.outcome_json as any)?.winner_user_id ?? null;
        const agrees = reportedWinner === winnerUserId;

        const token = await getToken();
        if (!token) throw new Error("Session expired — refresh.");

        const { data, error } = await supabase.functions.invoke("resolve-conflict", {
          body: {
            conflict_id: conflict.id,
            winner_user_id: winnerUserId,
            confirmer_agrees: agrees,
            nip_earned: nipEarned,
            ncp_earned: ncpEarned,
            notes: resultNotes,
          },
          headers: { Authorization: "Bearer " + token },
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error ?? "Resolution failed");

        let msg = data.status === "disputed"
          ? "Dispute recorded — the lead will adjudicate."
          : "Result confirmed — conflict resolved.";
        if (data.loser_eliminated) msg += " Opponent eliminated (no sectors remaining).";
        if (data.sector_transferred) msg += " Sector control transferred.";

        setResultStatus((prev) => ({ ...prev, [conflict.id]: msg }));

      } else if (!existing) {
        const { error } = await supabase.from("battle_results").insert({
          conflict_id: conflict.id,
          reported_by: uid,
          winner_user_id: winnerUserId,
          confirmed: false,
          outcome_json: {
            winner_user_id: winnerUserId,
            nip_earned: nipEarned,
            ncp_earned: ncpEarned,
            notes: resultNotes,
          },
        });
        if (error) throw error;
        setResultStatus((prev) => ({
          ...prev,
          [conflict.id]: "Result submitted — awaiting confirmation from your opponent.",
        }));
      }

      await load(campaignId);
      setReportingFor(null);
      setWinnerPick("");
      setResultNotes("");
    } catch (e: any) {
      setResultStatus((prev) => ({
        ...prev,
        [conflict.id]: "Error: " + (e?.message ?? "Unknown"),
      }));
    } finally {
      setSubmittingResult(false);
    }
  };

  // ── Generate battle narrative ────────────────────────────────────────────────
  const generateNarrative = async (conflict: Conflict) => {
    setGeneratingFor(conflict.id);
    setNarratives((prev) => ({ ...prev, [conflict.id]: "" }));
    setNarrativePublished((prev) => ({ ...prev, [conflict.id]: false }));
    try {
      const token = await getToken();
      if (!token) { setGeneratingFor(null); return; }

      const result    = results[conflict.id];
      const mission   = missions.find((m) => m.id === conflict.mission_id);
      const factionA  = memberLabel(members, conflict.player_a);
      const factionB  = memberLabel(members, conflict.player_b);
      const winnerUid = result?.winner_user_id ?? null;
      const winnerLabel = winnerUid
        ? memberLabel(members, winnerUid)
        : "a draw";
      const outcomeNotes = (result?.outcome_json as any)?.notes ?? "";

      const prompt = [
        "You are a Warhammer 40,000 campaign chronicler writing a vivid battle report.",
        "Write 3-4 paragraphs in grimdark 40K style about the following engagement.",
        "Be specific about the zone, factions, and mission. End with the outcome and its consequences.",
        "",
        "ENGAGEMENT DETAILS:",
        "Zone: " + titleCase(conflict.zone_key),
        "Sector: " + conflict.sector_key.toUpperCase(),
        "Round: " + conflict.round_number,
        "Combatants: " + factionA + " vs " + factionB,
        "Mission: " + (mission ? mission.name + " (" + mission.mission_type + ")" : "Unknown"),
        mission ? "Mission objective: " + mission.description : "",
        "Outcome: " + (result ? (winnerUid ? factionA === winnerLabel ? factionA + " victorious" : factionB + " victorious" : "drawn engagement") : "unresolved"),
        outcomeNotes ? "Notes from the field: " + outcomeNotes : "",
        conflict.twist_tags?.length ? "Battlefield twist: " + conflict.twist_tags.join(", ") : "",
        "",
        "Flowing prose only — no markdown headers or bullet points.",
      ].filter(Boolean).join("\n");

      // Chronicle title used for the War Bulletin post
      const chronicle_title =
        "Chronicle: " + titleCase(conflict.zone_key) + " — " +
        conflict.sector_key.toUpperCase() + "  (Round " + conflict.round_number + ")";

      const { data, error } = await supabase.functions.invoke("generate-narrative", {
        body: {
          prompt,
          max_tokens: 800,
          // Pass context so the edge function can also publish to the War Bulletin
          conflict_id: conflict.id,
          campaign_id: conflict.campaign_id,
          round_number: conflict.round_number,
          chronicle_title,
        },
        headers: { Authorization: "Bearer " + token },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Generation failed");

      setNarratives((prev) => ({ ...prev, [conflict.id]: data.text ?? "" }));
      setNarrativePublished((prev) => ({ ...prev, [conflict.id]: data.published === true }));

    } catch (e: any) {
      setNarratives((prev) => ({
        ...prev,
        [conflict.id]: "Generation failed: " + (e?.message ?? "Unknown"),
      }));
    } finally {
      setGeneratingFor(null);
    }
  };

  // ── Alliance actions ─────────────────────────────────────────────────────────
  const allianceAction = async (
    conflict: Conflict,
    action: "propose" | "withdraw" | "decline" | "accept"
  ) => {
    if (!uid) return;
    setAllianceWorking(conflict.id);
    setAllianceStatus((prev) => ({ ...prev, [conflict.id]: "" }));
    try {
      const token = await getToken();
      if (!token) throw new Error("Session expired — refresh.");

      if (action === "accept") {
        // Accept goes to form-alliance which also posts to the bulletin
        const { data, error } = await supabase.functions.invoke("form-alliance", {
          body: { conflict_id: conflict.id },
          headers: { Authorization: "Bearer " + token },
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error ?? "Alliance failed");
        setAllianceStatus((prev) => ({ ...prev, [conflict.id]: data.message ?? "Ceasefire pact formed." }));
      } else {
        // Propose, withdraw, or decline go to propose-alliance
        const { data, error } = await supabase.functions.invoke("propose-alliance", {
          body: { conflict_id: conflict.id, action },
          headers: { Authorization: "Bearer " + token },
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error ?? "Action failed");
        setAllianceStatus((prev) => ({ ...prev, [conflict.id]: data.message ?? "Done." }));
      }

      await load(campaignId);
    } catch (e: any) {
      setAllianceStatus((prev) => ({
        ...prev,
        [conflict.id]: "Error: " + (e?.message ?? "Unknown"),
      }));
    } finally {
      setAllianceWorking(null);
    }
  };

  // ── Result report form ───────────────────────────────────────────────────────
  const renderResultForm = (conflict: Conflict) => {
    const isConfirming = !!(results[conflict.id] && !results[conflict.id].confirmed && results[conflict.id].reported_by !== uid);
    return (
      <div className="space-y-3 pt-1">
        <div>
          <label className="text-xs text-parchment/50 mb-1 block">Who won?</label>
          <div className="flex flex-wrap gap-2">
            {[conflict.player_a, conflict.player_b].map((playerId) => (
              <button
                key={playerId}
                className={[
                  "px-3 py-1.5 rounded border text-sm transition-colors",
                  winnerPick === playerId
                    ? "border-brass/70 bg-brass/25 text-parchment"
                    : "border-brass/25 bg-void hover:border-brass/50 text-parchment/70",
                ].join(" ")}
                onClick={() => setWinnerPick(playerId)}
              >
                {memberLabel(members, playerId)}
              </button>
            ))}
            <button
              className={[
                "px-3 py-1.5 rounded border text-sm transition-colors",
                winnerPick === "draw"
                  ? "border-parchment/50 bg-parchment/10 text-parchment"
                  : "border-parchment/20 bg-void hover:border-parchment/40 text-parchment/50",
              ].join(" ")}
              onClick={() => setWinnerPick("draw")}
            >
              Draw
            </button>
          </div>
        </div>

        {!isConfirming && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-parchment/50 mb-1 block">NIP earned (winner)</label>
              <input
                type="number" min={0} max={10}
                value={nipEarned}
                onChange={(e) => setNipEarned(parseInt(e.target.value) || 0)}
                className="w-full px-2 py-1 rounded bg-void border border-brass/30 text-sm text-center"
              />
            </div>
            <div>
              <label className="text-xs text-parchment/50 mb-1 block">NCP earned (winner)</label>
              <input
                type="number" min={0} max={5}
                value={ncpEarned}
                onChange={(e) => setNcpEarned(parseInt(e.target.value) || 0)}
                className="w-full px-2 py-1 rounded bg-void border border-brass/30 text-sm text-center"
              />
            </div>
          </div>
        )}

        <div>
          <label className="text-xs text-parchment/50 mb-1 block">Notes (optional)</label>
          <textarea
            rows={2}
            className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-sm resize-none"
            placeholder="Anything notable about the battle…"
            value={resultNotes}
            onChange={(e) => setResultNotes(e.target.value)}
          />
        </div>

        <div className="flex gap-2 items-center">
          <button
            disabled={!winnerPick || submittingResult}
            className="px-4 py-1.5 rounded bg-brass/25 border border-brass/50 hover:bg-brass/35 text-sm font-semibold disabled:opacity-40"
            onClick={() => submitResult(conflict)}
          >
            {submittingResult ? "Submitting…" : isConfirming ? "Confirm Result" : "Submit Result"}
          </button>
          <button
            className="text-xs text-parchment/40 hover:text-parchment/60 underline"
            onClick={() => { setReportingFor(null); setWinnerPick(""); setResultNotes(""); }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  // ── Render alliance section ───────────────────────────────────────────────────
  // Shown inside each conflict card for involved players when the conflict is
  // still scheduled (not yet resolved or allied).
  const renderAllianceSection = (conflict: Conflict) => {
    if (!uid) return null;
    const isInvolved = uid === conflict.player_a || uid === conflict.player_b;
    if (!isInvolved) return null;

    // Allied — show a read-only banner
    if (conflict.status === "allied") {
      return (
        <div className="border-t border-brass/15 pt-3">
          <div className="rounded border border-brass/30 bg-brass/5 px-3 py-2 flex items-center gap-2">
            <span className="text-brass text-base">⚜</span>
            <span className="text-parchment/80 text-sm">Ceasefire Pact — no battle took place. Both factions stood down.</span>
          </div>
        </div>
      );
    }

    // Only offer alliance options on scheduled, unresolved conflicts
    if (conflict.status !== "scheduled") return null;

    const proposedByMe       = conflict.alliance_proposed_by === uid;
    const proposedByOpponent = conflict.alliance_proposed_by !== null && conflict.alliance_proposed_by !== uid;
    const isWorking          = allianceWorking === conflict.id;
    const statusMsg          = allianceStatus[conflict.id];
    const opponentLabel      = uid === conflict.player_a
      ? memberLabel(members, conflict.player_b)
      : memberLabel(members, conflict.player_a);

    return (
      <div className="border-t border-brass/15 pt-3">
        <div className="text-xs text-parchment/40 uppercase tracking-widest mb-2">Ceasefire Negotiation</div>

        {/* No proposal active — offer to propose */}
        {!proposedByMe && !proposedByOpponent && (
          <div className="space-y-2">
            <p className="text-xs text-parchment/50 leading-snug">
              Rather than fight, your factions may agree to a ceasefire. No battle takes place
              and the engagement is stood down. A public announcement will be posted to the War Bulletin.
            </p>
            <button
              disabled={isWorking}
              className="px-3 py-1.5 rounded bg-brass/10 border border-brass/25 hover:bg-brass/20 text-xs transition-colors disabled:opacity-40"
              onClick={() => allianceAction(conflict, "propose")}
            >
              {isWorking ? "Sending…" : "⚜ Propose Ceasefire"}
            </button>
          </div>
        )}

        {/* Current player proposed — waiting for opponent */}
        {proposedByMe && (
          <div className="space-y-2">
            <div className="rounded border border-brass/20 bg-void/60 px-3 py-2">
              <p className="text-sm text-parchment/70">
                <span className="text-brass">⚜</span> Ceasefire proposed — awaiting response from{" "}
                <span className="text-brass">{opponentLabel}</span>.
              </p>
            </div>
            <button
              disabled={isWorking}
              className="text-xs text-parchment/40 hover:text-parchment/60 underline transition-colors disabled:opacity-40"
              onClick={() => allianceAction(conflict, "withdraw")}
            >
              {isWorking ? "Withdrawing…" : "Withdraw proposal"}
            </button>
          </div>
        )}

        {/* Opponent proposed — offer to accept or decline */}
        {proposedByOpponent && (
          <div className="rounded border border-brass/25 bg-void/60 px-3 py-2 space-y-2">
            <p className="text-sm text-parchment/80">
              <span className="text-brass">{opponentLabel}</span> has proposed a ceasefire.
              Accepting will stand down the engagement and post a public announcement.
            </p>
            <div className="flex gap-2 flex-wrap">
              <button
                disabled={isWorking}
                className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm font-semibold disabled:opacity-40 transition-colors"
                onClick={() => allianceAction(conflict, "accept")}
              >
                {isWorking ? "Forming pact…" : "⚜ Accept Ceasefire"}
              </button>
              <button
                disabled={isWorking}
                className="px-3 py-1.5 rounded bg-void border border-blood/25 hover:border-blood/50 text-sm text-parchment/60 disabled:opacity-40 transition-colors"
                onClick={() => allianceAction(conflict, "decline")}
              >
                {isWorking ? "Declining…" : "Decline"}
              </button>
            </div>
          </div>
        )}

        {statusMsg && (
          <p className={"mt-2 text-xs " + (statusMsg.startsWith("Error") ? "text-blood/80" : "text-parchment/50")}>
            {statusMsg}
          </p>
        )}
      </div>
    );
  };

  // ── Render conflict card ──────────────────────────────────────────────────────
  const renderConflict = (conflict: Conflict) => {
    const existing        = results[conflict.id];
    const isInvolved      = uid === conflict.player_a || uid === conflict.player_b;
    const isReporting     = reportingFor === conflict.id;
    const isChoosingMs    = choosingMissionFor === conflict.id;
    const narrative       = narratives[conflict.id];
    const isGenerating    = generatingFor === conflict.id;
    const wasPublished    = narrativePublished[conflict.id] ?? false;
    const mission         = missions.find((m) => m.id === conflict.mission_id);
    const alreadyReported = existing?.reported_by === uid;
    const confirmed       = existing?.confirmed ?? false;
    const canConfirm      = existing && !confirmed && existing.reported_by !== uid && isInvolved;
    const opponentLabel   = uid === conflict.player_a
      ? memberLabel(members, conflict.player_b)
      : memberLabel(members, conflict.player_a);

    return (
      <Card
        key={conflict.id}
        title={titleCase(conflict.zone_key) + " — " + conflict.sector_key.toUpperCase() + "  (Round " + conflict.round_number + ")"}
      >
        <div className="space-y-4">

          {/* Players + mission header */}
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-parchment/40 uppercase tracking-widest mb-0.5">Combatants</div>
              <div className="text-brass font-semibold">{memberLabel(members, conflict.player_a)}</div>
              <div className="text-parchment/50 text-xs">vs</div>
              <div className="text-brass font-semibold">{memberLabel(members, conflict.player_b)}</div>
            </div>
            <div>
              <div className="text-xs text-parchment/40 uppercase tracking-widest mb-0.5">Mission</div>
              {mission ? (
                <>
                  <div className="text-parchment font-semibold">{mission.name}</div>
                  <div className="text-xs text-parchment/50 capitalize">{mission.mission_type}</div>
                  <div className="text-xs text-parchment/40 mt-0.5 leading-snug">{mission.description}</div>
                </>
              ) : (
                <div className="text-parchment/30 italic text-xs">
                  {conflict.mission_status === "unassigned" ? "Mission not yet assigned" : "Mission assigned"}
                </div>
              )}
              {conflict.twist_tags?.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {conflict.twist_tags.map((t) => (
                    <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-blood/10 border border-blood/20 text-blood/70">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Ceasefire section — before battle result so players see it first */}
          {renderAllianceSection(conflict)}

          {/* Battle result status — hidden if allied */}
          {conflict.status !== "allied" && (
            <div className="border-t border-brass/15 pt-3">
              <div className="text-xs text-parchment/40 uppercase tracking-widest mb-2">Battle Result</div>

              {confirmed ? (
                <div className="rounded border border-brass/30 bg-brass/5 px-3 py-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-brass text-base">✓</span>
                    <span className="text-parchment/80">
                      {(existing?.outcome_json as any)?.disputed
                        ? "Result disputed — awaiting lead adjudication"
                        : existing?.winner_user_id
                          ? memberLabel(members, existing.winner_user_id) + " victorious"
                          : "Drawn engagement"
                      }
                    </span>
                  </div>
                  {(existing?.outcome_json as any)?.notes && (
                    <p className="mt-1 text-xs text-parchment/40 italic">
                      "{(existing.outcome_json as any).notes}"
                    </p>
                  )}
                </div>
              ) : existing && alreadyReported ? (
                <p className="text-sm text-parchment/50 italic">
                  Your result is submitted — awaiting confirmation from {opponentLabel}.
                </p>
              ) : canConfirm ? (
                <div className="rounded border border-brass/25 bg-void/60 px-3 py-2 space-y-2">
                  <p className="text-sm text-parchment/80">
                    <span className="text-brass">{opponentLabel}</span> has reported a result.
                    Select your outcome to confirm or dispute:
                  </p>
                  {!isReporting ? (
                    <button
                      className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                      onClick={() => { setReportingFor(conflict.id); setWinnerPick(""); }}
                    >
                      Confirm / Dispute Result
                    </button>
                  ) : (
                    renderResultForm(conflict)
                  )}
                </div>
              ) : conflict.status === "resolved" ? null : isInvolved && !isReporting ? (
                <button
                  className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                  onClick={() => { setReportingFor(conflict.id); setWinnerPick(""); setResultNotes(""); setNipEarned(2); setNcpEarned(0); }}
                >
                  Report Result
                </button>
              ) : isReporting ? (
                renderResultForm(conflict)
              ) : null}

              {resultStatus[conflict.id] && (
                <p className={"mt-2 text-xs " + (resultStatus[conflict.id].startsWith("Error") ? "text-blood/80" : "text-parchment/50")}>
                  {resultStatus[conflict.id]}
                </p>
              )}
            </div>
          )}

          {/* Mission influence — hidden if allied or resolved */}
          {conflict.mission_status !== "assigned" && isInvolved &&
           conflict.status !== "allied" && conflict.status !== "resolved" && (
            <div className="border-t border-brass/15 pt-3">
              <div className="text-xs text-parchment/40 uppercase tracking-widest mb-2">Mission Influence</div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="px-3 py-1.5 rounded bg-brass/15 border border-brass/30 hover:bg-brass/25 text-xs"
                  onClick={() => submitInfluence(conflict.id, "veto", {}, 2)}
                >
                  Veto (2 NIP)
                </button>
                <button
                  className="px-3 py-1.5 rounded bg-brass/15 border border-brass/30 hover:bg-brass/25 text-xs"
                  onClick={() => { setChoosingMissionFor(isChoosingMs ? null : conflict.id); setPickedMission(""); }}
                >
                  Choose Mission (3 NIP)
                </button>
                <button
                  className="px-3 py-1.5 rounded bg-brass/15 border border-brass/30 hover:bg-brass/25 text-xs"
                  onClick={() => submitInfluence(conflict.id, "twist", { twist: "power_flicker" }, 1)}
                >
                  Add Twist (1 NIP)
                </button>
              </div>

              {isChoosingMs && (
                <div className="mt-2 space-y-2">
                  <select
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm"
                    value={pickedMission}
                    onChange={(e) => setPickedMission(e.target.value)}
                  >
                    <option value="">— Select a mission —</option>
                    {missions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.mission_type})
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <button
                      disabled={!pickedMission}
                      className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs disabled:opacity-40"
                      onClick={() => pickedMission && submitInfluence(conflict.id, "choose", { mission_id: pickedMission }, 3)}
                    >
                      Confirm Choice (3 NIP)
                    </button>
                    <button
                      className="text-xs text-parchment/40 hover:text-parchment/60 underline"
                      onClick={() => { setChoosingMissionFor(null); setPickedMission(""); }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {influenceStatus[conflict.id] && (
                <p className="mt-1 text-xs text-parchment/50">{influenceStatus[conflict.id]}</p>
              )}
            </div>
          )}

          {/* Narrative generator */}
          <div className="border-t border-brass/15 pt-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-xs text-parchment/40 uppercase tracking-widest">Battle Chronicle</div>
              <button
                disabled={isGenerating}
                className="px-3 py-1.5 rounded bg-brass/15 border border-brass/25 hover:bg-brass/25 text-xs disabled:opacity-40"
                onClick={() => generateNarrative(conflict)}
              >
                {isGenerating ? "Generating…" : "✦ Generate Chronicle"}
              </button>
            </div>

            {isGenerating && (
              <div className="mt-2 space-y-1.5">
                <div className="h-2.5 rounded bg-brass/10 animate-pulse w-full" />
                <div className="h-2.5 rounded bg-brass/10 animate-pulse w-5/6" />
                <div className="h-2.5 rounded bg-brass/10 animate-pulse w-4/5" />
                <p className="text-xs text-parchment/25 italic mt-1">Consulting the war records…</p>
              </div>
            )}

            {narrative && !isGenerating && (
              <div className="mt-2 rounded border border-brass/20 bg-void/60 px-3 py-3">
                <p className="text-sm text-parchment/80 leading-relaxed whitespace-pre-wrap">{narrative}</p>
                <div className="mt-2 flex items-center gap-3 flex-wrap">
                  <button
                    className="text-xs text-parchment/30 hover:text-parchment/60 underline"
                    onClick={() => navigator.clipboard.writeText(narrative)}
                  >
                    Copy
                  </button>
                  {wasPublished && (
                    <span className="text-xs text-brass/70 flex items-center gap-1">
                      <span>✓</span> Posted to War Bulletin
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

        </div>
      </Card>
    );
  };

  // ── Page render ──────────────────────────────────────────────────────────────

  // Auth loading gate — show spinner until getUser() resolves
  if (!authChecked) {
    return (
      <Frame title="Engagements" currentPage="conflicts" hideNewCampaign>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-brass/20 border-t-brass rounded-full animate-spin" />
        </div>
      </Frame>
    );
  }

  // No campaign in session (e.g. opened in a new tab without a ?campaign= link)
  if (!campaignId) {
    return (
      <Frame title="Engagements" currentPage="conflicts" hideNewCampaign>
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <p className="text-parchment/50">No campaign selected.</p>
          <a href="/" className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-brass text-sm">
            Return to Home
          </a>
        </div>
      </Frame>
    );
  }

  const currentConflicts = conflicts.filter((c) => c.round_number === roundNumber);
  const pastConflicts    = conflicts.filter((c) => c.round_number < roundNumber);

  return (
    <Frame title="Engagements" campaignId={campaignId} role={role} currentPage="conflicts">
      <div className="space-y-6">

        {currentConflicts.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xs uppercase tracking-widest text-parchment/40 px-1">
              Round {roundNumber} — Active Engagements
            </h2>
            {currentConflicts.map(renderConflict)}
          </div>
        )}

        {currentConflicts.length === 0 && (
          <Card title="No Active Engagements">
            <p className="text-parchment/50 text-sm">
              No conflicts scheduled for Round {roundNumber || "—"}.
              Conflicts are generated when two players move to the same sector.
            </p>
          </Card>
        )}

        {pastConflicts.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xs uppercase tracking-widest text-parchment/40 px-1">
              Past Engagements
            </h2>
            {pastConflicts.map(renderConflict)}
          </div>
        )}

      </div>
    </Frame>
  );
}
