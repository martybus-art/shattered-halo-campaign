"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

type PlayerState = {
  campaign_id: string;
  user_id: string;
  current_zone_key: string;
  current_sector_key: string;
  nip: number;
  ncp: number;
  status: string;
};

type Campaign = {
  id: string;
  name: string;
  phase: number;
  round_number: number;
  instability: number;
};

export default function Dashboard() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [campaignId, setCampaignId] = useState<string>("");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [state, setState] = useState<PlayerState | null>(null);
  const [role, setRole] = useState<string>("player");
  const [underdogChoice, setUnderdogChoice] = useState<string>("+2 NIP");

  // In production, you'd have a campaign selector. For MVP: paste campaign ID.
  const load = async () => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return;

    const { data: c, error: ce } = await supabase.from("campaigns").select("*").eq("id", campaignId).single();
    if (ce) return alert(ce.message);
    setCampaign(c);

    const { data: mem, error: me } = await supabase.from("campaign_members").select("role").eq("campaign_id", campaignId).eq("user_id", uid).single();
    if (me) return alert("You are not a member of this campaign.");
    setRole(mem.role);

    const { data: ps, error: pe } = await supabase.from("player_state").select("*").eq("campaign_id", campaignId).eq("user_id", uid).single();
    if (pe) return alert(pe.message);
    setState(ps);
  };

  useEffect(() => {
    if (campaignId) load();
  }, [campaignId]);

  const makePublicRecapPrompt = async () => {
    if (!campaign) return;
    const { data: publicPosts } = await supabase
      .from("posts")
      .select("round_number,title,body,tags,created_at")
      .eq("campaign_id", campaign.id)
      .eq("visibility", "public")
      .order("round_number", { ascending: false })
      .limit(20);

    const prompt = [
      `Campaign: ${campaign.name}`,
      `Phase: ${campaign.phase}`,
      `Current Round: ${campaign.round_number}`,
      `Halo Instability: ${campaign.instability}/10`,
      "",
      "PUBLIC CONTEXT (no secrets):",
      JSON.stringify(publicPosts ?? [], null, 2),
      "",
      "Task:",
      "1) Write a 300–600 word grimdark 'Halo War Bulletin' summarizing recent public events.",
      "2) Include paranoia, disputed sightings, and ominous references to the Ashen King.",
      "3) Suggest 3 bounties for next round tied to public tensions.",
      "Tone: 40K grimdark, cosmic horror, military dispatch."
    ].join("\n");

    await navigator.clipboard.writeText(prompt);
    alert("Public recap prompt copied to clipboard.");
  };

  const makePrivateWhisperPrompt = async () => {
    if (!campaign || !state) return;

    const { data: myPosts } = await supabase
      .from("posts")
      .select("round_number,title,body,tags,created_at")
      .eq("campaign_id", campaign.id)
      .eq("visibility", "private")
      .order("round_number", { ascending: false })
      .limit(20);

    const prompt = [
      `Campaign: ${campaign.name}`,
      `Phase: ${campaign.phase}`,
      `Current Round: ${campaign.round_number}`,
      `Halo Instability: ${campaign.instability}/10`,
      "",
      "MY PRIVATE CONTEXT (include secrets):",
      `My location (secret): ${state.current_zone_key}-${state.current_sector_key}`,
      `My status: ${state.status}`,
      `My NIP/NCP: ${state.nip}/${state.ncp}`,
      "My recent private notes:",
      JSON.stringify(myPosts ?? [], null, 2),
      "",
      "Task:",
      "Write a 2–4 paragraph private 'whisper' tailored to my faction/commander.",
      "Include: 1 opportunity, 1 threat, 1 rumor, and 1 suggested objective for next battle.",
      "Tone: ominous, conspiratorial, cinematic."
    ].join("\n");

    await navigator.clipboard.writeText(prompt);
    alert("Private whisper prompt copied to clipboard.");
  };

  return (
    <Frame title="Command Throne" right={<a className="underline" href="/map">Map</a>}>
      <div className="space-y-6">
        <Card title="Join a Campaign">
          <div className="flex flex-col md:flex-row gap-3">
            <input className="flex-1 px-3 py-2 rounded bg-void border border-brass/30"
              placeholder="Paste Campaign ID (uuid)" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            <button className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" onClick={load}>
              Load
            </button>
          </div>
          <p className="mt-2 text-parchment/70 text-sm">MVP note: add a campaign picker later. This keeps secrets safe while you iterate.</p>
        </Card>

        {campaign && state && (
          <div className="grid md:grid-cols-2 gap-6">
            <Card title="Your Status">
              <div className="space-y-2 text-parchment/85">
                <div><span className="text-brass">Campaign:</span> {campaign.name}</div>
                <div><span className="text-brass">Phase:</span> {campaign.phase} &nbsp; <span className="text-brass">Round:</span> {campaign.round_number}</div>
                <div><span className="text-brass">Instability:</span> {campaign.instability}/10</div>
                <div><span className="text-brass">Role:</span> {role}</div>
                <div className="pt-2 border-t border-brass/20">
                  <div><span className="text-brass">NIP:</span> {state.nip} &nbsp; <span className="text-brass">NCP:</span> {state.ncp}</div>
                  <div><span className="text-brass">Location (secret):</span> {state.current_zone_key} – {state.current_sector_key}</div>
                  <div><span className="text-brass">Status:</span> {state.status}</div>
                </div>
              </div>
            </Card>

            <Card title="Catch-up Choice (Underdog)">
              <p className="text-parchment/80">If the system flags you as <span className="text-brass">Underdog</span>, choose one benefit for the round:</p>
              <select className="mt-3 w-full px-3 py-2 rounded bg-void border border-brass/30"
                value={underdogChoice} onChange={(e) => setUnderdogChoice(e.target.value)}>
                <option>+2 NIP</option>
                <option>+1 NCP next battle</option>
                <option>Free Recon</option>
                <option>Safe Passage (1 move cannot be intercepted)</option>
              </select>
              <p className="mt-2 text-parchment/70 text-sm">Production note: store this choice in a `round_choices` table and apply in automation.</p>
            </Card>

            <Card title="Recaps & Whispers">
              <div className="space-y-3">
                {(role === "lead" || role === "admin") && (
                  <button className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                    onClick={makePublicRecapPrompt}>
                    Copy PUBLIC recap prompt (Lead)
                  </button>
                )}
                <button className="w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30"
                  onClick={makePrivateWhisperPrompt}>
                  Copy PRIVATE whisper prompt (You)
                </button>
                <p className="text-parchment/70 text-sm">Public recap uses only public posts (no secrets). Private whisper includes your secret location + notes.</p>
              </div>
            </Card>

            <Card title="Next Actions">
              <div className="flex flex-wrap gap-3">
                <a className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" href="/conflicts">Conflicts & Missions</a>
                <a className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" href="/ledger">Ledger</a>
              </div>
            </Card>
          </div>
        )}
      </div>
    </Frame>
  );
}
