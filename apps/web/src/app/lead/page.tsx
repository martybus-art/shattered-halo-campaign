"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

type Campaign = {
  id: string;
  name: string;
  phase: number;
  round_number: number;
  instability: number;
  invite_message: string | null;
};

type Round = { stage: string };

type Member = {
  user_id: string;
  role: string;
  faction_name: string | null;
  faction_key: string | null;
  commander_name: string | null;
  faction_locked: boolean;
};

function getQueryCampaign(): string | null {
  if (typeof window === "undefined") return null;
  const u = new URL(window.location.href);
  return u.searchParams.get("campaign");
}

export default function LeadControls() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [campaignId, setCampaignId]   = useState<string>("");
  const [campaign, setCampaign]       = useState<Campaign | null>(null);
  const [round, setRound]             = useState<Round | null>(null);
  const [role, setRole]               = useState<string>("player");
  const [members, setMembers]         = useState<Member[]>([]);

  // Invite state
  const [inviteEmails, setInviteEmails]   = useState<string>("");
  const [isLateInvite, setIsLateInvite]   = useState<boolean>(false);
  const [inviteStatus, setInviteStatus]   = useState<string>("");
  const [sendingInvite, setSendingInvite] = useState<boolean>(false);

  // Archive / Delete / Chronicle
  const [deleteConfirm, setDeleteConfirm]     = useState(false);
  const [deleting, setDeleting]               = useState(false);
  const [archiving, setArchiving]             = useState(false);
  const [generatingChronicle, setGeneratingChronicle] = useState(false);
  const [chronicle, setChronicle]             = useState<string | null>(null);
  const [showChronicle, setShowChronicle]     = useState(false);

  // Player states (for eliminated players panel)
  const [playerStates, setPlayerStates] = useState<{ user_id: string; status: string }[]>([]);
  const [reinstating, setReinstating]   = useState<string | null>(null); // user_id being reinstated
  const [reinstateStatus, setReinstateStatus] = useState<Record<string, string>>({});

  // Detect / force conflicts
  const [detectingConflicts, setDetectingConflicts]     = useState(false);
  const [detectConflictStatus, setDetectConflictStatus] = useState("");
  const [showForceConflict, setShowForceConflict]       = useState(false);
  const [forcePlayerA, setForcePlayerA]                 = useState("");
  const [forcePlayerB, setForcePlayerB]                 = useState("");
  const [forceZone, setForceZone]                       = useState("");
  const [forceSector, setForceSector]                   = useState("a1");

  // Start campaign status
  const [startStatus, setStartStatus] = useState<string>("");

  // ── Derived ──────────────────────────────────────────────
  // Campaign is considered started once a round row exists
  const campaignStarted = round !== null;
  const allowed         = role === "lead" || role === "admin";

  // Member counts
  const playerCount = members.filter((m) => m.role === "player").length;
  const leadCount   = members.filter((m) => m.role === "lead").length;
  const lockedCount = members.filter((m) => m.faction_locked).length;

  // ── Load ─────────────────────────────────────────────────
  const load = async (cid: string) => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return;

    const { data: mem } = await supabase
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", cid)
      .eq("user_id", uid)
      .single();
    setRole(mem?.role ?? "player");

    const { data: c, error: cErr } = await supabase
      .from("campaigns")
      .select("id,name,phase,round_number,instability,invite_message")
      .eq("id", cid)
      .single();

    if (cErr || !c) {
      alert(cErr?.message ?? "Campaign not found");
      setCampaign(null);
      setRound(null);
      return;
    }
    setCampaign(c);

    const { data: r } = await supabase
      .from("rounds")
      .select("stage")
      .eq("campaign_id", cid)
      .eq("round_number", c.round_number)
      .maybeSingle();
    setRound(r ?? null);

    const [membersRes, psRes] = await Promise.all([
      supabase
        .from("campaign_members")
        .select("user_id,role,faction_name,faction_key,commander_name,faction_locked")
        .eq("campaign_id", cid)
        .order("role"),
      supabase
        .from("player_state")
        .select("user_id,status")
        .eq("campaign_id", cid),
    ]);
    setMembers((membersRes.data ?? []) as Member[]);
    setPlayerStates((psRes.data ?? []) as { user_id: string; status: string }[]);
  };

  useEffect(() => {
    const q = getQueryCampaign();
    if (q) setCampaignId(q);
  }, []);

  useEffect(() => {
    if (campaignId) load(campaignId);
  }, [campaignId]);

  // Auto-enable late invite toggle once campaign has started
  useEffect(() => {
    if (campaignStarted) setIsLateInvite(true);
  }, [campaignStarted]);

  // ── Helpers ───────────────────────────────────────────────
  const getToken = async (): Promise<string | null> => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      alert("Session expired. Please refresh the page and try again.");
      return null;
    }
    return token;
  };

  const callFn = async (fn: string, extraBody?: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return;
    const { data, error } = await supabase.functions.invoke(fn, {
      body: { campaign_id: campaignId, ...extraBody },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) return alert(error.message);
    if (!data?.ok) return alert(data?.error || "Failed");
    alert("Done");
    await load(campaignId);
  };

  // ── Actions ───────────────────────────────────────────────
  const startCampaign = async () => {
    if (campaignStarted) return;
    setStartStatus("Starting campaign…");
    const token = await getToken();
    if (!token) return;
    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "initial" },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) {
      setStartStatus(`Error: ${error.message}`);
      return alert(`Start failed: ${error.message}`);
    }
    setStartStatus(`Started — ${data?.allocated ?? 0} locations allocated`);
    await load(campaignId);
  };

  // ── Shared data fetch — used by both archive export and chronicle ────────────
  const fetchAllCampaignData = async () => {
    const [
      membersRes, roundsRes, ledgerRes, conflictsRes,
      playerStateRes, battleResultsRes, missionInfluenceRes,
      campaignEventsRes, campaignRelicsRes, movesRes, postsRes,
    ] = await Promise.all([
      supabase.from("campaign_members").select("*").eq("campaign_id", campaignId),
      supabase.from("rounds").select("*").eq("campaign_id", campaignId).order("round_number"),
      supabase.from("ledger").select("*").eq("campaign_id", campaignId).order("created_at"),
      supabase.from("conflicts").select("*, missions(name, description, mission_type)").eq("campaign_id", campaignId),
      supabase.from("player_state").select("*").eq("campaign_id", campaignId),
      supabase.from("battle_results").select("*, conflicts(zone_key, sector_key, round_number)").in(
        "conflict_id",
        // subquery workaround: we'll join after
        ["00000000-0000-0000-0000-000000000000"]
      ),
      supabase.from("mission_influence").select("*").in(
        "conflict_id",
        ["00000000-0000-0000-0000-000000000000"]
      ),
      supabase.from("campaign_events").select("*").eq("campaign_id", campaignId).order("round_number"),
      supabase.from("campaign_relics").select("*, relics(name, lore, rarity)").eq("campaign_id", campaignId),
      supabase.from("moves").select("*").eq("campaign_id", campaignId).order("round_number"),
      supabase.from("posts").select("*").eq("campaign_id", campaignId).order("round_number"),
    ]);

    // Fetch battle_results and mission_influence properly via conflict IDs
    const conflictIds = (conflictsRes.data ?? []).map((c: any) => c.id);
    let battleResults: any[] = [];
    let missionInfluence: any[] = [];
    if (conflictIds.length) {
      const [brRes, miRes] = await Promise.all([
        supabase.from("battle_results").select("*").in("conflict_id", conflictIds),
        supabase.from("mission_influence").select("*").in("conflict_id", conflictIds),
      ]);
      battleResults  = brRes.data ?? [];
      missionInfluence = miRes.data ?? [];
    }

    return {
      members:          membersRes.data ?? [],
      rounds:           roundsRes.data ?? [],
      ledger:           ledgerRes.data ?? [],
      conflicts:        conflictsRes.data ?? [],
      player_state:     playerStateRes.data ?? [],
      battle_results:   battleResults,
      mission_influence: missionInfluence,
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
      const archive = {
        exported_at: new Date().toISOString(),
        campaign,
        chronicle: chronicle ?? null,
        ...data,
      };

      const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${campaign.name.replace(/[^a-z0-9]/gi, "_")}_archive.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert("Archive failed: " + (e?.message ?? "Unknown error"));
    } finally {
      setArchiving(false);
    }
  };

  const generateChronicle = async () => {
    if (!campaignId || !campaign) return;
    setGeneratingChronicle(true);
    setShowChronicle(true);
    setChronicle(null);

    try {
      const data = await fetchAllCampaignData();

      // Build a structured prompt with all the campaign data
      // Resolve member names from faction/commander names for readability
      const memberSummary = data.members.map((m: any) =>
        `${m.commander_name ?? "Unknown Commander"} (${m.faction_name ?? "Unknown Faction"}, ${m.role})`
      ).join(", ");

      const finalStandings = data.player_state.map((ps: any) => {
        const member = data.members.find((m: any) => m.user_id === ps.user_id);
        const name = member?.commander_name ?? member?.faction_name ?? ps.user_id.slice(0, 8);
        return `${name}: ${ps.ncp} NCP, ${ps.nip} NIP, location: ${ps.public_location ?? "unknown"}`;
      }).join("\n");

      const conflictSummary = data.conflicts.map((c: any) => {
        const mission = (c as any).missions;
        const result  = data.battle_results.find((br: any) => br.conflict_id === c.id);
        const winner  = result
          ? data.members.find((m: any) => m.user_id === result.winner_user_id)
          : null;
        const playerA = data.members.find((m: any) => m.user_id === c.player_a);
        const playerB = data.members.find((m: any) => m.user_id === c.player_b);
        return `Round ${c.round_number} — ${c.zone_key} (${c.sector_key}): ` +
          `${playerA?.faction_name ?? "?"} vs ${playerB?.faction_name ?? "?"}, ` +
          `mission: ${mission?.name ?? "unassigned"}, ` +
          `winner: ${winner ? (winner.faction_name ?? winner.commander_name ?? "unknown") : "unresolved"}`;
      }).join("\n");

      const eventSummary = data.campaign_events.map((e: any) =>
        `Round ${e.round_number}: ${e.event_name} (instability after: ${e.instability_after}/10)`
      ).join("\n");

      const relicSummary = data.campaign_relics.map((cr: any) => {
        const relic   = (cr as any).relics;
        const holder  = data.members.find((m: any) => m.user_id === cr.controller_user_id);
        return `${relic?.name ?? "Unknown Relic"} — held by ${holder?.faction_name ?? "unclaimed"}, status: ${cr.status}`;
      }).join("\n");

      const publicPosts = data.posts.map((p: any) =>
        `[Round ${p.round_number}] "${p.title}": ${p.body}`
      ).join("\n\n");

      const prompt = `You are a Warhammer 40,000 campaign chronicler. Write a vivid, atmospheric narrative summary of the following campaign. Use grimdark 40K tone — epic, ominous, with a sense of cosmic consequence. Reference specific factions, commanders, zones, missions and events. Structure it as a chronicle that reads like an in-universe after-action report or historical record.

CAMPAIGN: ${campaign.name}
Rounds played: ${data.rounds.length}
Final instability: ${campaign.instability}/10
Phase: ${campaign.phase}

${campaign.invite_message ? `ORIGINAL CAMPAIGN PREMISE:
${campaign.invite_message}
` : ""}

COMBATANTS:
${memberSummary}

FINAL STANDINGS:
${finalStandings || "No final standings recorded."}

BATTLES FOUGHT:
${conflictSummary || "No conflicts recorded."}

INSTABILITY EVENTS:
${eventSummary || "No events recorded."}

RELICS:
${relicSummary || "No relics in play."}

${publicPosts ? `NARRATIVE DISPATCHES (public posts):
${publicPosts}` : ""}

Write the chronicle now. Aim for 4-6 paragraphs. Do not use markdown headers or bullet points — flowing prose only.`;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setChronicle("Session expired — refresh and try again.");
        return;
      }

      const { data: genData, error: genErr } = await supabase.functions.invoke("generate-narrative", {
        body: { prompt, max_tokens: 1500 },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (genErr) throw genErr;
      if (!genData?.ok) throw new Error(genData?.error ?? "Generation failed");
      const text = genData?.text ?? "";
      if (text) setChronicle(text);
      else setChronicle("Chronicle generation failed — no response from AI.");
    } catch (e: any) {
      setChronicle("Chronicle generation failed: " + (e?.message ?? "Unknown error"));
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
      alert("Delete failed: " + (e?.message ?? "Unknown error"));
    } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };

  const sendInvites = async () => {
    const emails = inviteEmails
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

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
      if (!data?.ok) throw new Error(data?.error ?? "Failed to send invites");

      // Build a status summary
      const parts: string[] = [];
      if (data.sent > 0)
        parts.push(`${data.sent} invite email${data.sent > 1 ? "s" : ""} sent`);
      if (data.existing_users > 0)
        parts.push(`${data.existing_users} existing player${data.existing_users > 1 ? "s" : ""} notified on next login`);
      if (data.failed > 0)
        parts.push(`${data.failed} failed`);

      const lateNote = isLateInvite
        ? " Once they join, click Allocate next to their name."
        : " They will auto-join when they sign in.";

      setInviteStatus(parts.join(" · ") + "." + lateNote);
      setInviteEmails("");
      await load(campaignId);
    } catch (e: any) {
      setInviteStatus(`Error: ${e?.message ?? "Failed to send invites."}`);
    } finally {
      setSendingInvite(false);
    }
  };


  // ── Style helpers ─────────────────────────────────────────
  const roleBadge = (r: string) => {
    if (r === "lead")  return "bg-brass/20 text-brass border border-brass/40";
    if (r === "admin") return "bg-blood/20 text-blood border border-blood/40";
    return "bg-iron/40 text-parchment/70 border border-parchment/20";
  };

  // ── Render ────────────────────────────────────────────────
  // ── Reinstate eliminated player ──────────────────────────────────────────
  const reinstatePlayer = async (userId: string) => {
    if (!campaignId) return;
    setReinstating(userId);
    setReinstateStatus((prev) => ({ ...prev, [userId]: "" }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Session expired — refresh.");

      // Reuse start-campaign in late mode to allocate a sector
      const { data, error } = await supabase.functions.invoke("start-campaign", {
        body: { campaign_id: campaignId, mode: "late", late_user_id: userId },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Reinstatement failed");

      // Mark player active again
      await supabase
        .from("player_state")
        .update({ status: "normal" })
        .eq("campaign_id", campaignId)
        .eq("user_id", userId);

      setReinstateStatus((prev) => ({
        ...prev,
        [userId]: "Reinstated — new sector allocated.",
      }));
      await load(campaignId);
    } catch (e: any) {
      setReinstateStatus((prev) => ({
        ...prev,
        [userId]: "Error: " + (e?.message ?? "Unknown"),
      }));
    } finally {
      setReinstating(null);
    }
  };

  // ── Detect / force conflicts ─────────────────────────────────────────────
  const detectConflicts = async (forcePairs?: object[]) => {
    if (!campaignId) return;
    setDetectingConflicts(true);
    setDetectConflictStatus("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Session expired.");

      const body: Record<string, unknown> = { campaign_id: campaignId };
      if (forcePairs?.length) body.force_pairs = forcePairs;

      const { data, error } = await supabase.functions.invoke("detect-conflicts", {
        body,
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Detection failed");

      setDetectConflictStatus(
        data.conflicts_created > 0
          ? `${data.conflicts_created} conflict(s) created for Round ${data.round_number}.`
          : data.note ?? "No new conflicts detected."
      );
      if (forcePairs) {
        setShowForceConflict(false);
        setForcePlayerA(""); setForcePlayerB(""); setForceZone(""); setForceSector("a1");
      }
    } catch (e: any) {
      setDetectConflictStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setDetectingConflicts(false);
    }
  };

  return (
    <Frame
      title="Lead Controls"
      campaignId={campaignId}
      role={role}
      currentPage="lead"
    >
      <div className="space-y-6">

        {/* ── 1. Campaign ── */}
        <Card title="Campaign">
          {campaign && (
            <div className="mt-4 space-y-1 text-parchment/80">
              <div className="flex items-center gap-3">
                <span className="text-brass font-semibold text-lg">{campaign.name}</span>
                {/* Status badge */}
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
                <span className="text-brass">Instability:</span> {campaign.instability}/10
              </div>
              {campaignStarted && (
                <div><span className="text-brass">Stage:</span> {round?.stage}</div>
              )}
              <div><span className="text-brass">Your role:</span> {role}</div>

              {/* Start Campaign button lives here, disabled once started */}
              <div className="pt-3 border-t border-brass/20">
                <p className="text-parchment/60 text-sm mb-2">
                  {campaignStarted
                    ? "Campaign is running. Starting locations have been allocated."
                    : "Allocates secret starting locations for all current players."}
                </p>
                <button
                  disabled={!allowed || campaignStarted}
                  className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 disabled:cursor-not-allowed text-sm"
                  onClick={startCampaign}
                >
                  {campaignStarted ? "Campaign Already Started" : "Start Campaign"}
                </button>
                {startStatus && (
                  <p className="mt-2 text-xs text-parchment/60">{startStatus}</p>
                )}
              </div>

              {/* ── Chronicle / Archive / Delete ── */}
              {allowed && (
                <div className="pt-3 border-t border-brass/20 space-y-3">

                  {/* Action buttons row */}
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
                          className="px-3 py-1.5 rounded bg-blood/30 border border-blood/60 hover:bg-blood/40 text-xs text-blood font-semibold disabled:opacity-40"
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

                  {/* Chronicle display panel */}
                  {showChronicle && (
                    <div className="rounded border border-brass/30 bg-void/80">
                      <div className="flex items-center justify-between px-4 py-2 border-b border-brass/20">
                        <span className="text-xs uppercase tracking-widest text-brass/70 font-semibold">
                          Campaign Chronicle
                        </span>
                        <div className="flex gap-2">
                          {chronicle && (
                            <button
                              className="text-xs text-parchment/40 hover:text-parchment/70 underline"
                              onClick={() => {
                                navigator.clipboard.writeText(chronicle);
                              }}
                            >
                              Copy
                            </button>
                          )}
                          <button
                            className="text-xs text-parchment/40 hover:text-parchment/70"
                            onClick={() => setShowChronicle(false)}
                          >
                            ✕ Close
                          </button>
                        </div>
                      </div>
                      <div className="px-4 py-4">
                        {generatingChronicle ? (
                          <div className="space-y-2">
                            <div className="h-3 rounded bg-brass/10 animate-pulse w-full" />
                            <div className="h-3 rounded bg-brass/10 animate-pulse w-5/6" />
                            <div className="h-3 rounded bg-brass/10 animate-pulse w-4/5" />
                            <div className="h-3 rounded bg-brass/10 animate-pulse w-full mt-4" />
                            <div className="h-3 rounded bg-brass/10 animate-pulse w-3/4" />
                            <p className="text-xs text-parchment/30 mt-3 italic">
                              The chronicler is consulting the records…
                            </p>
                          </div>
                        ) : chronicle ? (
                          <p className="text-parchment/80 text-sm leading-relaxed whitespace-pre-wrap">
                            {chronicle}
                          </p>
                        ) : (
                          <p className="text-parchment/40 text-sm italic">No chronicle generated yet.</p>
                        )}
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-parchment/30">
                    Chronicle uses AI to summarise the campaign narrative. Export Archive downloads all raw campaign data as JSON.
                    {chronicle && " Chronicle is included in the archive export."}
                  </p>
                </div>
              )}
            </div>
          )}

          {!allowed && (
            <p className="mt-3 text-blood/80">
              You are not authorised for leader controls in this campaign.
            </p>
          )}
        </Card>

        {/* ── 2. Active Players + Invite ── */}
        {campaign && (
          <Card title={`Active Players — ${members.length} enrolled (${leadCount} lead · ${playerCount} player · ${lockedCount} faction locked)`}>

            {/* Player rows */}
            {members.length === 0 ? (
              <p className="text-parchment/60 mb-4">No members yet.</p>
            ) : (
              <div className="space-y-2 mb-5">
                {members.map((m) => (
                  <div
                    key={m.user_id}
                    className="flex flex-col sm:flex-row sm:items-center gap-2 rounded border border-brass/20 bg-void px-4 py-3"
                  >
                    {/* Role badge */}
                    <span className={`text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide shrink-0 w-fit ${roleBadge(m.role)}`}>
                      {m.role}
                    </span>

                    {/* Faction / commander */}
                    <div className="flex-1 min-w-0">
                      {m.faction_name ? (
                        <>
                          <div className="text-parchment font-semibold truncate">
                            {m.faction_name}
                            {m.faction_key && (
                              <span className="ml-2 text-xs text-parchment/40 font-mono">({m.faction_key})</span>
                            )}
                          </div>
                          {m.commander_name && (
                            <div className="text-xs text-parchment/60">Cmdr: {m.commander_name}</div>
                          )}
                        </>
                      ) : (
                        <div className="text-parchment/40 italic text-sm">No faction chosen</div>
                      )}
                    </div>

                    {/* Lock status */}
                    <div className="text-xs shrink-0">
                      {m.faction_locked
                        ? <span className="text-blood/80">🔒 Locked</span>
                        : <span className="text-parchment/30">Unlocked</span>}
                    </div>


                  </div>
                ))}

              </div>
            )}

            {/* Invite form */}
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

                {/* Late player toggle */}
                <label className={`flex items-start gap-3 ${campaignStarted ? "opacity-70" : ""}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={isLateInvite}
                    disabled={campaignStarted} // forced true once started
                    onChange={(e) => setIsLateInvite(e.target.checked)}
                  />
                  <div>
                    <div className="text-sm text-parchment/80">
                      Late player allocation
                      {campaignStarted && (
                        <span className="ml-2 text-xs text-blood/70">(required — campaign running)</span>
                      )}
                    </div>
                    <div className="text-xs text-parchment/50 mt-0.5">
                      Late players will need their starting location allocated by the lead after they join — use the Start Campaign function again to reallocate.
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

                {inviteStatus && (
                  <p className="text-xs text-parchment/60 leading-relaxed">{inviteStatus}</p>
                )}
              </div>
            )}
          </Card>
        )}

        {/* ── 2b. Eliminated Players ── */}
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
                  const m = members.find((x) => x.user_id === ps.user_id);
                  const label = m?.faction_name ?? m?.commander_name ?? ps.user_id.slice(0, 8) + "…";
                  const isReinstate = reinstating === ps.user_id;
                  return (
                    <div
                      key={ps.user_id}
                      className="flex items-center gap-3 rounded border border-blood/20 bg-blood/5 px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-parchment/80 font-semibold truncate">{label}</div>
                        {m?.faction_key && (
                          <div className="text-xs text-parchment/40 font-mono">{m.faction_key}</div>
                        )}
                        {reinstateStatus[ps.user_id] && (
                          <div className={`text-xs mt-0.5 ${reinstateStatus[ps.user_id].startsWith("Error") ? "text-blood/70" : "text-parchment/50"}`}>
                            {reinstateStatus[ps.user_id]}
                          </div>
                        )}
                      </div>
                      <span className="text-xs text-blood/60 font-mono uppercase shrink-0">Eliminated</span>
                      {allowed && (
                        <button
                          disabled={isReinstate}
                          className="shrink-0 px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs disabled:opacity-40"
                          onClick={() => reinstatePlayer(ps.user_id)}
                        >
                          {isReinstate ? "Reinstating…" : "Reinstate"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })()}

        {/* ── 3 & 4. Frequently used actions ── */}
        {campaign && (
          <div className="grid md:grid-cols-2 gap-6">

            <Card title="Advance Stage / Round">
              <p className="text-parchment/70 text-sm">
                Moves through the stage order: movement → recon → conflicts → missions → results → spend → publish → next round.
              </p>
              <button
                disabled={!allowed}
                className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
                onClick={() => callFn("advance-round")}
              >
                Advance
              </button>
            </Card>

            <Card title="Assign Missions">
              <p className="text-parchment/70 text-sm">
                Assigns missions to conflicts in the current round, respecting any NIP influence ("choose", "veto", etc.).
              </p>
              <button
                disabled={!allowed}
                className="mt-3 w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40"
                onClick={() => callFn("assign-missions")}
              >
                Assign Missions
              </button>
            </Card>

            <Card title="Detect Conflicts">
              <p className="text-parchment/70 text-sm">
                Scans this round's moves and generates conflict rows where two or more players landed in the same sector.
              </p>
              <button
                disabled={!allowed || detectingConflicts}
                className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
                onClick={() => detectConflicts()}
              >
                {detectingConflicts ? "Scanning…" : "Detect Conflicts"}
              </button>

              {/* Force conflict — testing / manual override */}
              <div className="mt-3 pt-3 border-t border-brass/15">
                <button
                  className="text-xs text-parchment/40 hover:text-parchment/60 underline"
                  onClick={() => setShowForceConflict((v) => !v)}
                >
                  {showForceConflict ? "▲ Hide" : "▼ Force conflict (testing)"}
                </button>

                {showForceConflict && (
                  <div className="mt-2 space-y-2">
                    <div className="text-xs text-parchment/50 italic">
                      Manually create a conflict between two players — useful for testing before movement system is live.
                    </div>
                    <div>
                      <label className="text-xs text-parchment/50 mb-0.5 block">Player A</label>
                      <select
                        className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                        value={forcePlayerA}
                        onChange={(e) => setForcePlayerA(e.target.value)}
                      >
                        <option value="">— Select player —</option>
                        {members.map((m) => (
                          <option key={m.user_id} value={m.user_id}>
                            {m.faction_name ?? m.commander_name ?? m.user_id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-parchment/50 mb-0.5 block">Player B</label>
                      <select
                        className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                        value={forcePlayerB}
                        onChange={(e) => setForcePlayerB(e.target.value)}
                      >
                        <option value="">— Select player —</option>
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
                        <input
                          className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                          placeholder="e.g. vault_ruins"
                          value={forceZone}
                          onChange={(e) => setForceZone(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-parchment/50 mb-0.5 block">Sector key</label>
                        <input
                          className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-xs"
                          placeholder="e.g. a1"
                          value={forceSector}
                          onChange={(e) => setForceSector(e.target.value)}
                        />
                      </div>
                    </div>
                    <button
                      disabled={!forcePlayerA || !forcePlayerB || !forceZone || !forceSector || detectingConflicts}
                      className="w-full px-3 py-1.5 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-xs disabled:opacity-40"
                      onClick={() => detectConflicts([{
                        player_a: forcePlayerA,
                        player_b: forcePlayerB,
                        zone_key: forceZone,
                        sector_key: forceSector,
                      }])}
                    >
                      {detectingConflicts ? "Creating…" : "Create Conflict"}
                    </button>
                  </div>
                )}
              </div>

              {detectConflictStatus && (
                <p className={`mt-2 text-xs ${detectConflictStatus.startsWith("Error") ? "text-blood/70" : "text-parchment/50"}`}>
                  {detectConflictStatus}
                </p>
              )}
            </Card>

          </div>
        )}

        {/* ── 5. Less frequent actions ── */}
        {campaign && (
          <Card title="Apply Instability">
            <p className="text-parchment/70 text-sm">
              Increments Halo Instability by 1 and rolls an event from the appropriate d10 table. Also posts a public bulletin.
            </p>
            <button
              disabled={!allowed}
              className="mt-3 px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={() => callFn("apply-instability")}
            >
              Apply Instability (Game Day)
            </button>
          </Card>
        )}

        {/* ── 6. What's next ── */}
        <Card title="What's next">
          <ul className="list-disc pl-5 space-y-2 text-parchment/75">
            <li>Add "Process Movement" function to automate secret location updates from moves.</li>
            <li>Add "Resolve Recon" and "Apply Underdog Choices" functions.</li>
            <li>Add "Publish Bulletin" helper that writes a public post scaffold.</li>
          </ul>
        </Card>

      </div>
    </Frame>
  );
}
