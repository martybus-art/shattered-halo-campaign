"use client";
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
  const [campaignId, setCampaignId] = useState<string>("");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [role, setRole] = useState<string>("player");

  const load = async (cid: string) => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return;

    const { data: mem } = await supabase.from("campaign_members").select("role").eq("campaign_id", cid).eq("user_id", uid).single();
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

const { data: r, error: rErr } = await supabase
  .from("rounds")
  .select("stage")
  .eq("campaign_id", cid)
  .eq("round_number", c.round_number)
  .maybeSingle();

if (rErr) {
  // Not fatal — you can still view the campaign.
  setRound(null);
  return;
}

setRound(r);

  };

  useEffect(() => {
    const q = getQueryCampaign();
    if (q) setCampaignId(q);
  }, []);

  useEffect(() => { if (campaignId) load(campaignId); }, [campaignId]);

  const callFn = async (fn: string) => {
    // Explicitly attach the access token for Edge Functions.
    // (In some setups, invoke() won't include Authorization automatically.)
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;

    if (!token) {
    alert("Session expired. Please refresh the page and try again.");
    return;
  }

    const { data, error } = await supabase.functions.invoke(fn, {
      body: { campaign_id: campaignId },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (error) return alert(error.message);
    if (!data?.ok) return alert(data?.error || "Failed");
    alert("Done");
    await load(campaignId); 
  };

  const allowed = role === "lead" || role === "admin";

  return (
    <Frame title="Lead Controls" right={<a className="underline" href={`/dashboard?campaign=${campaignId}`}>Back</a>}>
      <div className="space-y-6">
        <Card title="Campaign">
          <div className="flex flex-col md:flex-row gap-3">
            <input className="flex-1 px-3 py-2 rounded bg-void border border-brass/30" placeholder="Campaign ID"
              value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            <button className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" onClick={() => load(campaignId)}>Load</button>
          </div>
          {campaign && (
            <div className="mt-3 text-parchment/80 space-y-1">
              <div><span className="text-brass">Name:</span> {campaign.name}</div>
              <div><span className="text-brass">Phase:</span> {campaign.phase} • <span className="text-brass">Round:</span> {campaign.round_number}</div>
              <div><span className="text-brass">Instability:</span> {campaign.instability}/10</div>
              <div><span className="text-brass">Stage:</span> {round?.stage ?? "unknown"}</div>
              <div><span className="text-brass">Role:</span> {role}</div>
            </div>
          )}
          {!allowed && <p className="mt-3 text-blood/80">You are not authorised for lead controls in this campaign.</p>}
        </Card>

        <div className="grid md:grid-cols-2 gap-6">
          <Card title="Advance Stage / Round">
            <p className="text-parchment/70 text-sm">Moves through the stage order: movement → recon → conflicts → missions → results → spend → publish → next round.</p>
            <button disabled={!allowed} className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={() => callFn("advance-round")}>
              Advance
            </button>
          </Card>

          <Card title="Assign Missions">
            <p className="text-parchment/70 text-sm">Assigns missions to conflicts in the current round, respecting any NIP influence (“choose”, “veto”, etc.).</p>
            <button disabled={!allowed} className="mt-3 w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40"
              onClick={() => callFn("assign-missions")}>
              Assign Missions
            </button>
            </Card>

  <Card title="Apply Instability">
    <p className="text-parchment/70 text-sm">Increments Halo Instability by 1 and rolls an event from the appropriate d10 table. Also posts a public bulletin.</p>
    <button disabled={!allowed} className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
      onClick={() => callFn("apply-instability")}>
      Apply Instability (Game Day)
    </button>
  </Card>
</div>

<Card title="What’s next">

          <ul className="list-disc pl-5 space-y-2 text-parchment/75">
            <li>Add “Process Movement” + “Detect Conflicts” functions to fully remove admin work.</li>
            <li>Add “Resolve Recon” and “Apply Underdog Choices” functions.</li>
            <li>Add “Publish Bulletin” helper that writes a public post scaffold.</li>
          </ul>
        </Card>
      </div>
    </Frame>
  );
}
