"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

type Template = { id: string; name: string; description: string };
type CampaignRow = { id: string; name: string; phase: number; round_number: number; instability: number; role: string };

export default function CampaignsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [myCampaigns, setMyCampaigns] = useState<CampaignRow[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [campaignName, setCampaignName] = useState("");
  const [emails, setEmails] = useState("");

  const acceptInvites = async () => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return;
    await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/accept-invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({})
    }).catch(() => null);
  };

  const load = async () => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return;

    await acceptInvites();

    const { data: t } = await supabase.from("templates").select("id,name,description").order("created_at", { ascending: true });
    setTemplates(t ?? []);
    if (!selectedTemplate && t?.length) setSelectedTemplate(t[0].id);

    const { data: mem } = await supabase.from("campaign_members").select("campaign_id,role").eq("user_id", uid);
    const ids = (mem ?? []).map((m: any) => m.campaign_id);
    if (!ids.length) {
      setMyCampaigns([]);
      return;
    }

    const { data: cs } = await supabase.from("campaigns").select("id,name,phase,round_number,instability").in("id", ids);
    const roleById = new Map((mem ?? []).map((m: any) => [m.campaign_id, m.role]));
    setMyCampaigns((cs ?? []).map((c: any) => ({ ...c, role: roleById.get(c.id) ?? "player" })));
  };

  useEffect(() => { load(); }, []);

  const createCampaign = async () => {
    const player_emails = emails.split(",").map(e => e.trim()).filter(Boolean);
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    if (!token) return alert("Not signed in");

    const resp = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/create-campaign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ template_id: selectedTemplate, campaign_name: campaignName, player_emails })
    });

    const json = await resp.json();
    if (!json.ok) return alert(json.error);

    alert("Campaign created! You are the Lead player.");
    setCampaignName("");
    setEmails("");
    await load();
  };

  return (
    <Frame title="Campaigns" right={<a className="underline" href="/dashboard">Dashboard</a>}>
      <div className="grid md:grid-cols-2 gap-6">
        <Card title="My Campaigns">
          <div className="space-y-3">
            {myCampaigns.length === 0 && <p className="text-parchment/70">No campaigns yet. Create one.</p>}
            {myCampaigns.map(c => (
              <div key={c.id} className="rounded border border-brass/20 bg-void p-3">
                <div className="flex justify-between">
                  <div className="font-gothic">{c.name}</div>
                  <div className="text-xs text-brass">{c.role.toUpperCase()}</div>
                </div>
                <div className="text-xs text-parchment/70 mt-1">
                  Phase {c.phase} • Round {c.round_number} • Instability {c.instability}/10
                </div>
                <div className="mt-2 flex gap-2 flex-wrap">
                  <a className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" href={`/dashboard?campaign=${c.id}`}>Open</a>
                  <a className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" href={`/map?campaign=${c.id}`}>Map</a>
                  {(c.role === "lead" || c.role === "admin") && (
                    <a className="px-3 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30" href={`/lead?campaign=${c.id}`}>Lead Controls</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Create Campaign">
          <div className="space-y-3">
            <label className="text-sm text-parchment/80">Template</label>
            <select className="w-full px-3 py-2 rounded bg-void border border-brass/30"
              value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>

            <label className="text-sm text-parchment/80">Campaign name</label>
            <input className="w-full px-3 py-2 rounded bg-void border border-brass/30"
              value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="Embers of the Shattered Halo – Season 1" />

            <label className="text-sm text-parchment/80">Invite players (comma separated emails)</label>
            <input className="w-full px-3 py-2 rounded bg-void border border-brass/30"
              value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="a@x.com, b@y.com, c@z.com" />

            <button className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
              onClick={createCampaign}>
              Create (you become Lead)
            </button>

            <p className="text-xs text-parchment/60">
              Invites are stored as <span className="text-brass">Pending</span> until recipients sign in. On first login, they are auto-added.
            </p>
          </div>
        </Card>
      </div>
    </Frame>
  );
}
