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
  const [campaignId, setCampaignId] = useState<string>("");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [role, setRole] = useState<string>("player");
  const [members, setMembers] = useState<Member[]>([]);
  const [lateUserId, setLateUserId] = useState<string>("");
  const [startStatus, setStartStatus] = useState<string>("");

  const load = async (cid: string) => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return;

    // Current user's role
    const { data: mem } = await supabase
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", cid)
      .eq("user_id", uid)
      .single();
    setRole(mem?.role ?? "player");

    // Campaign details
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

    // All members
    const { data: allMembers } = await supabase
      .from("campaign_members")
      .select("user_id,role,faction_name,faction_key,commander_name,faction_locked")
      .eq("campaign_id", cid)
      .order("role");
    setMembers((allMembers ?? []) as Member[]);

    // Current round
    const { data: r, error: rErr } = await supabase
      .from("rounds")
      .select("stage")
      .eq("campaign_id", cid)
      .eq("round_number", c.round_number)
      .maybeSingle();

    if (rErr) {
      setRound(null);
      return;
    }
    setRound(r);
  };

  useEffect(() => {
    const q = getQueryCampaign();
    if (q) setCampaignId(q);
  }, []);

  useEffect(() => {
    if (campaignId) load(campaignId);
  }, [campaignId]);

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

  const startCampaign = async () => {
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
    setStartStatus(`OK. Allocated: ${data?.allocated ?? 0}`);
    alert(`Start OK. Allocated: ${data?.allocated ?? 0}`);
    await load(campaignId);
  };

  const allocateLatePlayer = async () => {
    if (!lateUserId) return alert("Enter late player user_id");
    setStartStatus("Allocating late player…");
    const token = await getToken();
    if (!token) return;

    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "late", late_user_id: lateUserId },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) {
      setStartStatus(`Error: ${error.message}`);
      return alert(`Late allocation failed: ${error.message}`);
    }
    setStartStatus(`OK. Allocated: ${data?.allocated ?? 0}`);
    alert(`Late allocation OK. Allocated: ${data?.allocated ?? 0}`);
    await load(campaignId);
  };

  const allowed = role === "lead" || role === "admin";

  // Derived counts
  const playerCount  = members.filter(m => m.role === "player").length;
  const leadCount    = members.filter(m => m.role === "lead").length;
  const lockedCount  = members.filter(m => m.faction_locked).length;

  // Role badge colours
  const roleBadge = (r: string) => {
    if (r === "lead")  return "bg-brass/20 text-brass border border-brass/40";
    if (r === "admin") return "bg-blood/20 text-blood border border-blood/40";
    return "bg-iron/40 text-parchment/70 border border-parchment/20";
  };

  return (
    <Frame
      title="Lead Controls"
      campaignId={campaignId}
      role={role}
      currentPage="lead"
    >
      <div className="space-y-6">

        {/* ── Campaign loader ── */}
        <Card title="Campaign">
          <div className="flex flex-col md:flex-row gap-3">
            <input
              className="flex-1 px-3 py-2 rounded bg-void border border-brass/30"
              placeholder="Campaign ID"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
            />
            <button
              className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
              onClick={() => load(campaignId)}
            >
              Load
            </button>
          </div>

          {campaign && (
            <div className="mt-3 text-parchment/80 space-y-1">
              <div><span className="text-brass">Name:</span> {campaign.name}</div>
              <div>
                <span className="text-brass">Phase:</span> {campaign.phase} &nbsp;
                <span className="text-brass">Round:</span> {campaign.round_number}
              </div>
              <div><span className="text-brass">Instability:</span> {campaign.instability}/10</div>
              <div><span className="text-brass">Stage:</span> {round?.stage ?? "unknown"}</div>
              <div><span className="text-brass">Your role:</span> {role}</div>
            </div>
          )}

          {!allowed && (
            <p className="mt-3 text-blood/80">
              You are not authorised for leader controls in this campaign.
            </p>
          )}
        </Card>

        {/* ── Active players ── */}
        {campaign && (
          <Card title={`Active Players — ${members.length} total (${leadCount} lead, ${playerCount} player)`}>
            {members.length === 0 ? (
              <p className="text-parchment/60">No members found for this campaign.</p>
            ) : (
              <div className="space-y-3">
                {/* Summary counts */}
                <div className="flex flex-wrap gap-4 pb-3 border-b border-brass/20 text-sm">
                  <span>
                    <span className="text-brass font-semibold">{members.length}</span>
                    <span className="text-parchment/60"> enrolled</span>
                  </span>
                  <span>
                    <span className="text-brass font-semibold">{lockedCount}</span>
                    <span className="text-parchment/60"> factions locked</span>
                  </span>
                  <span>
                    <span className="text-brass font-semibold">{members.length - lockedCount}</span>
                    <span className="text-parchment/60"> awaiting faction</span>
                  </span>
                </div>

                {/* Player rows */}
                {members.map((m) => (
                  <div
                    key={m.user_id}
                    className="flex flex-col sm:flex-row sm:items-center gap-2 rounded border border-brass/20 bg-void px-4 py-3"
                  >
                    {/* Role badge */}
                    <span className={`text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide w-fit ${roleBadge(m.role)}`}>
                      {m.role}
                    </span>

                    {/* Faction / commander */}
                    <div className="flex-1 min-w-0">
                      {m.faction_name ? (
                        <>
                          <div className="text-parchment font-semibold truncate">
                            {m.faction_name}
                            {m.faction_key && (
                              <span className="ml-2 text-xs text-parchment/50 font-mono">({m.faction_key})</span>
                            )}
                          </div>
                          {m.commander_name && (
                            <div className="text-xs text-parchment/60">
                              Commander: {m.commander_name}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-parchment/40 italic text-sm">No faction chosen yet</div>
                      )}
                    </div>

                    {/* Faction lock status */}
                    <div className="text-xs shrink-0">
                      {m.faction_locked ? (
                        <span className="text-blood/80">🔒 Locked</span>
                      ) : (
                        <span className="text-parchment/40">Unlocked</span>
                      )}
                    </div>

                    {/* User ID (for late-player allocation) */}
                    <div
                      className="text-xs text-parchment/30 font-mono truncate max-w-[10rem] cursor-pointer hover:text-parchment/60"
                      title={m.user_id}
                      onClick={() => {
                        navigator.clipboard.writeText(m.user_id);
                      }}
                    >
                      {m.user_id.slice(0, 8)}…
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* ── Action cards ── */}
        <div className="grid md:grid-cols-2 gap-6">

          <Card title="Start Campaign">
            <p className="text-parchment/70 text-sm">
              Allocates secret starting locations for all players without revealing assignments.
            </p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={startCampaign}
            >
              Start Campaign (Allocate Starting Locations)
            </button>
            {startStatus && (
              <p className="mt-2 text-xs text-parchment/60">Status: {startStatus}</p>
            )}
          </Card>

          <Card title="Late Player Allocation">
            <p className="text-parchment/70 text-sm">
              Reassigns 1 sector from the dominant player to the late joiner. Click a player ID above to copy it.
            </p>
            <input
              className="mt-3 w-full px-3 py-2 rounded bg-void border border-brass/30"
              value={lateUserId}
              onChange={(e) => setLateUserId(e.target.value)}
              placeholder="Late player user_id (uuid)"
              disabled={!allowed}
            />
            <button
              disabled={!allowed || !lateUserId}
              className="mt-3 w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40"
              onClick={allocateLatePlayer}
            >
              Allocate Late Player
            </button>
          </Card>

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

          <Card title="Apply Instability">
            <p className="text-parchment/70 text-sm">
              Increments Halo Instability by 1 and rolls an event from the appropriate d10 table. Also posts a public bulletin.
            </p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={() => callFn("apply-instability")}
            >
              Apply Instability (Game Day)
            </button>
          </Card>

        </div>

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
