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

  // Archive / Delete
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting]           = useState(false);
  const [archiving, setArchiving]         = useState(false);

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
      .select("id,name,phase,round_number,instability")
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

    const { data: allMembers } = await supabase
      .from("campaign_members")
      .select("user_id,role,faction_name,faction_key,commander_name,faction_locked")
      .eq("campaign_id", cid)
      .order("role");
    setMembers((allMembers ?? []) as Member[]);
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

  const archiveCampaign = async () => {
    if (!campaignId || !campaign) return;
    setArchiving(true);
    try {
      // Fetch all related data for export
      const [membersRes, roundsRes, ledgerRes, conflictsRes] = await Promise.all([
        supabase.from("campaign_members").select("*").eq("campaign_id", campaignId),
        supabase.from("rounds").select("*").eq("campaign_id", campaignId),
        supabase.from("ledger").select("*").eq("campaign_id", campaignId),
        supabase.from("conflicts").select("*").eq("campaign_id", campaignId),
      ]);

      const archive = {
        exported_at: new Date().toISOString(),
        campaign,
        members: membersRes.data ?? [],
        rounds: roundsRes.data ?? [],
        ledger: ledgerRes.data ?? [],
        conflicts: conflictsRes.data ?? [],
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

              {/* ── Archive / Delete ── */}
              {allowed && (
                <div className="pt-3 border-t border-brass/20">
                  <div className="flex flex-wrap gap-2">
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

                    {/* User ID — click to copy */}
                    <div
                      className="text-xs text-parchment/30 font-mono truncate max-w-[9rem] cursor-pointer hover:text-parchment/60 shrink-0"
                      title={`Click to copy: ${m.user_id}`}
                      onClick={() => navigator.clipboard.writeText(m.user_id)}
                    >
                      {m.user_id.slice(0, 8)}…
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
            <li>Add "Process Movement" + "Detect Conflicts" functions to fully remove admin work.</li>
            <li>Add "Resolve Recon" and "Apply Underdog Choices" functions.</li>
            <li>Add "Publish Bulletin" helper that writes a public post scaffold.</li>
          </ul>
        </Card>

      </div>
    </Frame>
  );
}
