"use client";
// apps/web/src/app/lead/page.tsx
// Lead Player Dashboard -- campaign controls for lead/admin role.
//
// changelog:
//   2026-03-04 -- added Delete Campaign card; calls delete-campaign edge function
//                 with window.confirm prompt; redirects to / on success.

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

type Campaign = { id: string; name: string; phase: number; round_number: number; instability: number };
type Round = { stage: string };

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
  const [lateUserId, setLateUserId]   = useState<string>("");
  const [startStatus, setStartStatus] = useState<string>("");
  const [deleting, setDeleting]       = useState(false);

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
      .select("id,name,phase,round_number,instability")
      .eq("id", cid).single();

    if (cErr || !c) {
      alert(cErr?.message ?? "Campaign not found");
      setCampaign(null);
      setRound(null);
      return;
    }
    setCampaign(c);

    const { data: r, error: rErr } = await supabase
      .from("rounds").select("stage")
      .eq("campaign_id", cid)
      .eq("round_number", c.round_number)
      .maybeSingle();

    if (rErr) { setRound(null); return; }
    setRound(r);
  };

  useEffect(() => {
    const q = getQueryCampaign();
    if (q) setCampaignId(q);
  }, []);

  useEffect(() => { if (campaignId) load(campaignId); }, [campaignId]);

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
    setStartStatus("Starting campaign...");
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
    setStartStatus("Allocating late player...");
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

  const deleteCampaign = async () => {
    if (!campaignId) return;
    const confirmed = window.confirm(
      `Delete campaign "${campaign?.name ?? campaignId}"?\n\n` +
      "This will permanently delete all campaign data including sectors, rounds, " +
      "player state, posts, and map artwork.\n\n" +
      "This cannot be undone."
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const { data, error } = await supabase.functions.invoke("delete-campaign", {
        body: { campaign_id: campaignId },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) return alert(`Delete failed: ${error.message}`);
      if (!data?.ok) return alert(data?.error ?? "Delete failed");
      window.location.href = "/";
    } finally {
      setDeleting(false);
    }
  };

  const allowed = role === "lead" || role === "admin";

  return (
    <Frame title="Lead Player Dashboard" right={<a className="underline" href={`/dashboard?campaign=${campaignId}`}>Back</a>}>
      <div className="space-y-6">

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
              <div><span className="text-brass">Phase:</span> {campaign.phase} &bull; <span className="text-brass">Round:</span> {campaign.round_number}</div>
              <div><span className="text-brass">Instability:</span> {campaign.instability}/10</div>
              <div><span className="text-brass">Stage:</span> {round?.stage ?? "unknown"}</div>
              <div><span className="text-brass">Role:</span> {role}</div>
            </div>
          )}
          {!allowed && <p className="mt-3 text-blood/80">You are not authorised for leader controls in this campaign.</p>}
        </Card>

        <div className="grid md:grid-cols-2 gap-6">

          <Card title="Start Campaign">
            <p className="text-parchment/70 text-sm">Allocates secret starting locations for all players without revealing assignments.</p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={startCampaign}
            >
              Start Campaign (Allocate Starting Locations)
            </button>
            {startStatus && <p className="mt-2 text-xs text-parchment/60">Status: {startStatus}</p>}
          </Card>

          <Card title="Late Player Allocation">
            <p className="text-parchment/70 text-sm">Reassigns 1 sector from the dominant player to the late joiner.</p>
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
            <p className="text-parchment/70 text-sm">Moves through the stage order: movement &rarr; recon &rarr; conflicts &rarr; missions &rarr; results &rarr; spend &rarr; publish &rarr; next round.</p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={() => callFn("advance-round")}
            >
              Advance
            </button>
          </Card>

          <Card title="Assign Missions">
            <p className="text-parchment/70 text-sm">Assigns missions to conflicts in the current round, respecting any NIP influence ("choose", "veto", etc.).</p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40"
              onClick={() => callFn("assign-missions")}
            >
              Assign Missions
            </button>
          </Card>

          <Card title="Apply Instability">
            <p className="text-parchment/70 text-sm">Increments Halo Instability by 1 and rolls an event from the appropriate d10 table. Also posts a public bulletin.</p>
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

        {/* Danger zone -- only shown when a campaign is loaded and user is lead/admin */}
        {campaign && allowed && (
          <Card title="Danger Zone">
            <p className="text-parchment/70 text-sm">
              Permanently deletes this campaign, all player data, sectors, rounds, posts, and map artwork.
              This action cannot be undone.
            </p>
            <button
              disabled={deleting}
              className="mt-3 w-full px-4 py-2 rounded bg-blood/30 border border-blood/60 hover:bg-blood/50 disabled:opacity-40 text-parchment font-semibold"
              onClick={deleteCampaign}
            >
              {deleting ? "Deleting..." : `Delete Campaign: ${campaign.name}`}
            </button>
          </Card>
        )}

      </div>
    </Frame>
  );
}
