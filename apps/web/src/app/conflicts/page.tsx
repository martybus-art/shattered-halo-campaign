"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

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
};

type Mission = { id: string; name: string; description: string; mission_type: string; phase_min: number; zone_tags: any };

function getQueryCampaign(): string | null {
  if (typeof window === "undefined") return null;
  const u = new URL(window.location.href);
  return u.searchParams.get("campaign");
}

export default function ConflictsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [campaignId, setCampaignId] = useState("");
  const [round, setRound] = useState<number>(1);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);

  useEffect(() => {
    const q = getQueryCampaign();
    if (q) setCampaignId(q);
  }, []);

  const load = async () => {
const { data: c, error: cErr } = await supabase
  .from("campaigns")
  .select("round_number,template_id,phase")
  .eq("id", campaignId)
  .single();

if (cErr) {
  alert(cErr.message);
  return;
}

if (!c) {
  alert("Campaign not found");
  return;
}


    const { data: conf, error: ce } = await supabase.from("conflicts").select("*").eq("campaign_id", campaignId).eq("round_number", c.round_number);
    if (ce) return alert(ce.message);
    setConflicts(conf ?? []);

    const { data: ms, error: me } = await supabase.from("missions").select("*").eq("template_id", c.template_id).eq("is_active", true);
    if (me) return alert(me.message);
    // phase gating client-side
    setMissions((ms ?? []).filter((m: any) => (m.phase_min ?? 1) <= (c.phase ?? 1)));
  };

  useEffect(() => { if (campaignId) load(); }, [campaignId]);

  const influence = async (conflictId: string, type: "veto"|"choose"|"preference"|"twist", payload: any, nip: number) => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return alert("Not signed in");

    const { error: ie } = await supabase.from("mission_influence").insert({
      conflict_id: conflictId,
      user_id: uid,
      influence_type: type,
      nip_spent: nip,
      payload
    });
    if (ie) return alert(ie.message);

    alert("Influence recorded. Lead can run mission assignment.");
  };

  const randomMissionId = () => {
    const pick = missions[Math.floor(Math.random()*missions.length)];
    return pick?.id;
  };

  return (
    <Frame title="Engagements" right={<a className="underline" href={`/dashboard?campaign=${campaignId}`}>Dashboard</a>}>
      <div className="space-y-6">
        <Card title="Load Conflicts">
          <div className="flex gap-3">
            <input className="flex-1 px-3 py-2 rounded bg-void border border-brass/30" placeholder="Campaign ID"
              value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            <button className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" onClick={load}>Load</button>
          </div>
          <p className="mt-2 text-xs text-parchment/60">Round {round}. Conflicts are visible only to involved players (fog-safe).</p>
        </Card>

        <div className="space-y-4">
          {conflicts.map(c => (
            <Card key={c.id} title={`Conflict @ ${c.zone_key.toUpperCase()}-${c.sector_key} (Round ${c.round_number})`}>
              <div className="space-y-2 text-parchment/85">
                <div>Mission status: <span className="text-brass">{c.mission_status}</span></div>
                <div>Mission: {c.mission_id ? <span className="text-parchment">Assigned</span> : <span className="text-parchment/60">Unassigned</span>}</div>

                <div className="pt-3 border-t border-brass/20 space-y-2">
                  <div className="text-sm text-parchment/80">Spend NIP to influence mission selection:</div>
                  <div className="flex flex-wrap gap-2">
                    <button className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                      onClick={() => influence(c.id, "veto", {}, 2)}>Veto (2 NIP)</button>

                    <button className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                      onClick={() => {
                        const mid = randomMissionId();
                        if (!mid) return alert("No missions loaded");
                        influence(c.id, "choose", { mission_id: mid }, 3);
                      }}>Choose (3 NIP)</button>

                    <button className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                      onClick={() => influence(c.id, "twist", { twist: "power_flicker" }, 1)}>Add Twist (1 NIP)</button>
                  </div>

                  <p className="text-xs text-parchment/60">Tip: Lead can click “Assign Missions” in Lead Controls after players spend influence.</p>
                </div>
              </div>
            </Card>
          ))}
          {!conflicts.length && (
            <Card title="No conflicts">
              <p className="text-parchment/70">No scheduled conflicts for you this round.</p>
            </Card>
          )}
        </div>
      </div>
    </Frame>
  );
}
