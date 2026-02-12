"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";


type Template = {
  id: string;
  name: string;
  description: string | null;
};

type Campaign = {
  id: string;
  name: string;
  phase: number;
  round_number: number;
  instability: number;
  created_at: string;
};

type Membership = {
  campaign_id: string;
  role: string;
};


export default function CampaignsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [campaignsById, setCampaignsById] = useState<Record<string, Campaign>>({});
  const [loading, setLoading] = useState(true);

  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [campaignName, setCampaignName] = useState<string>("");
  const [emails, setEmails] = useState<string>("");
  const [creating, setCreating] = useState(false);

const acceptInvites = async () => {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return; // ✅ don't call the function if not signed in / session not ready

    const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/accept-invites`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, // ✅ add apikey
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    // Optional: silence expected 401s on fresh loads
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.warn("accept-invites failed", resp.status, txt);
    }
  } catch (e) {
    console.warn("accept-invites error", e);
  }
};


  const load = async () => {
    setLoading(true);
    try {
      const { data: userResp } = await supabase.auth.getUser();
      if (!userResp.user) {
        setTemplates([]);
        setMemberships([]);
        setCampaignsById({});
        return;
      }

      await acceptInvites();

      // Templates
      const { data: tpls, error: te } = await supabase
        .from("templates")
        .select("id,name,description")
        .order("created_at", { ascending: false });

      if (te) throw te;
      setTemplates(tpls ?? []);
      if (!selectedTemplate && tpls?.length) setSelectedTemplate(tpls[0].id);

      // Memberships
      const { data: mem, error: me } = await supabase
        .from("campaign_members")
        .select("campaign_id,role")
        .order("created_at", { ascending: false });

      if (me) throw me;
      const memRows = (mem ?? []) as Membership[];
      setMemberships(memRows);

      // Campaign summaries (second query avoids join typing headaches)
      const ids = memRows.map((m) => m.campaign_id);
      if (!ids.length) {
        setCampaignsById({});
        return;
      }

      const { data: camps, error: ce } = await supabase
        .from("campaigns")
        .select("id,name,phase,round_number,instability,created_at")
        .in("id", ids);

      if (ce) throw ce;

      const map: Record<string, Campaign> = {};
      (camps ?? []).forEach((c: any) => {
        map[c.id] = c as Campaign;
      });
      setCampaignsById(map);
    } catch (e: any) {
      console.error(e);
      alert(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const createCampaign = async () => {
    if (!selectedTemplate) return alert("Select a template.");
    if (!campaignName.trim()) return alert("Enter a campaign name.");

    setCreating(true);
    try {
      const { data: { session }, error: sessErr } = await supabase.auth.getSession();
      if (sessErr) return alert(sessErr.message);

      const token = session?.access_token;
      if (!token) return alert("Session not ready yet. Refresh the page and try again.");

      const player_emails = emails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);

      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/create-campaign`;

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          template_id: selectedTemplate,
          campaign_name: campaignName.trim(),
          player_emails,
        }),
      });

      const text = await resp.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // non-json response
      }

      if (!resp.ok) {
        alert(`Create failed: ${json?.error ?? text ?? `HTTP ${resp.status}`}`);
        return;
      }

      if (!json?.ok) {
        alert(`Create failed: ${json?.error ?? "Unknown error"}`);
        return;
      }

      alert("Campaign created! You are the Lead player.");
      setCampaignName("");
      setEmails("");
      await load();
    } catch (e: any) {
      console.error(e);
      alert(`Create failed: ${e?.message ?? String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
      console.log("SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
      console.log("HAS_ANON_KEY", !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const myCampaignRows = memberships
    .map((m) => ({
      campaign_id: m.campaign_id,
      role: m.role,
      campaign: campaignsById[m.campaign_id],
    }))
    .filter((x) => !!x.campaign);

  return (
    <Frame title="Campaigns" right={<a className="underline" href="/dashboard">Dashboard</a>}>
      <div className="space-y-6">
        <Card title="Create Campaign">
          <div className="space-y-3">
            <div>
              <div className="text-sm text-parchment/70 mb-1">Template</div>
              <select
                className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                disabled={loading || creating}
              >
                {!templates.length && <option value="">No templates found</option>}
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {templates.length ? (
                <p className="mt-1 text-xs text-parchment/60">
                  {templates.find((t) => t.id === selectedTemplate)?.description ?? ""}
                </p>
              ) : (
                <p className="mt-1 text-xs text-parchment/60">
                  You need at least one template row in <span className="text-brass">templates</span>.
                </p>
              )}
            </div>

            <div>
              <div className="text-sm text-parchment/70 mb-1">Campaign name</div>
              <input
                className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="e.g. Embers of the Shattered Halo (Season 1)"
                disabled={loading || creating}
              />
            </div>

            <div>
              <div className="text-sm text-parchment/70 mb-1">Invite emails (comma-separated)</div>
              <input
                className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="friend1@example.com, friend2@example.com"
                disabled={loading || creating}
              />
              <p className="mt-1 text-xs text-parchment/60">
                Invites are stored in <span className="text-brass">pending_invites</span>. Players auto-join when they sign in.
              </p>
            </div>

            <button
              className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={createCampaign}
              disabled={creating || loading || !templates.length}
            >
              {creating ? "Creating…" : "Create (you become Lead)"}
            </button>
          </div>
        </Card>

        <Card title="My Campaigns">
          {loading ? (
            <p className="text-parchment/70">Loading…</p>
          ) : myCampaignRows.length ? (
            <div className="space-y-3">
              {myCampaignRows.map((row) => (
                <div key={row.campaign_id} className="rounded border border-brass/25 bg-void px-4 py-3">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                    <div>
                      <div className="text-brass font-semibold">{row.campaign!.name}</div>
                      <div className="text-xs text-parchment/60">
                        Role: {row.role} • Phase {row.campaign!.phase} • Round {row.campaign!.round_number} • Instability{" "}
                        {row.campaign!.instability}/10
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" href={`/dashboard?campaign=${row.campaign_id}`}>
                        Open Dashboard
                      </a>
                      <a className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" href={`/map?campaign=${row.campaign_id}`}>
                        Map
                      </a>
                      <a className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" href={`/conflicts?campaign=${row.campaign_id}`}>
                        Conflicts
                      </a>
                      {(row.role === "lead" || row.role === "admin") && (
                        <a className="px-3 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30" href={`/lead?campaign=${row.campaign_id}`}>
                          Lead Controls
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-parchment/70">No campaigns yet. Create one above.</p>
          )}
        </Card>
      </div>
    </Frame>
  );
}
