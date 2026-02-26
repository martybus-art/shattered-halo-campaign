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

type Ruleset = { 
  id: string; 
  name: string; 
  description: string | null; 
  key: string 
};

type MapRow = { 
  id: string; 
  name: string; 
  description: string | null; 
  version: number 
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

  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [maps, setMaps] = useState<MapRow[]>([]);
  const [selectedRuleset, setSelectedRuleset] = useState<string>("");
  const [selectedMap, setSelectedMap] = useState<string>("");

  type RulesOverrides = {
  fog?: { enabled: boolean };
  instability?: { enabled: boolean };
  missions?: { mode: string };
  economy?: { enabled?: boolean; catchup?: { enabled: boolean; bonus: number } };
  narrative?: { cp_exchange?: { enabled: boolean } };
  };

  const [rulesOverrides, setRulesOverrides] = useState({
    economy: { enabled: true, catchup: { enabled: true, bonus: 1 } },
    fog: { enabled: true },
    instability: { enabled: true },
    missions: { enabled: true ,mode: "weighted_random_nip" },
    narrative: { cp_exchange: { enabled: true } },
  });
  

  const acceptInvites = async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const { error } = await supabase.functions.invoke("accept-invites", {
        body: {},
      });

      if (error) {
        // not fatal; just log
        console.warn("accept-invites failed:", error);
      }
    } catch (e) {
      console.warn("accept-invites error:", e);
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
      const tplRows = (tpls ?? []) as Template[];
      setTemplates(tplRows);
      if (!selectedTemplate && tplRows.length) setSelectedTemplate(tplRows[0].id);

      // Memberships
      const { data: mem, error: me } = await supabase
        .from("campaign_members")
        .select("campaign_id,role")
        .order("created_at", { ascending: false });

      if (me) throw me;

      const memRows = (mem ?? []) as Membership[];
      setMemberships(memRows);

      // Campaign summaries
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
    const { data: rs } = await supabase.from("rulesets").select("id,key,name,description").eq("is_active", true).order("created_at", { ascending: false });
    setRulesets((rs ?? []) as any);
    if (!selectedRuleset && rs?.length) setSelectedRuleset(rs[0].id);

    const { data: mp } = await supabase.from("maps").select("id,name,description,version").eq("is_active", true).order("created_at", { ascending: false });
    setMaps((mp ?? []) as any);
    if (!selectedMap && mp?.length) setSelectedMap(mp[0].id);
  };

  const createCampaign = async () => {
    if (!selectedTemplate) return alert("Select a template.");
    if (!campaignName.trim()) return alert("Enter a campaign name.");

    setCreating(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        alert("Session not ready yet. Refresh and try again.");
        return;
      }

      const inviteEmails = emails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);

      const { data, error } = await supabase.functions.invoke("create-campaign", {
        body: {
          template_id: selectedTemplate,
          campaign_name: campaignName.trim(),
          player_emails: inviteEmails,
          ruleset_id: selectedRuleset || null,
          rules_overrides: rulesOverrides,
          map_id: selectedMap || null,
          },
      });

      if (error) {
  console.error("invoke error:", error);

  // 👇 this is the money
  try {
    const text = await error.context.text();
    console.error("function response text:", text);
  } catch (e) {
    console.error("no error context body available", e);
  }

  throw error;
}

console.log("data:", data);

      if (!data?.ok) {
        alert(`Create failed: ${data?.error ?? "Unknown error"}`);
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
    // Helpful visibility for env correctness
    console.log("SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
    console.log("HAS_ANON_KEY", !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

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
            
            <div className="mt-4 rounded-2xl border border-brass/30 bg-iron/70 p-4">
              <div className="text-sm font-semibold uppercase tracking-[0.18em] text-brass/90">
                Optional Rules
              </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="flex items-center gap-3">
                <input type="checkbox"
                  checked={!!rulesOverrides.economy?.enabled}
                  onChange={(e) =>
                    setRulesOverrides((r) => ({...r, economy: { ...(r.economy ?? {}), enabled: e.target.checked },
                    }))
                  }
                />
                <span>Economy (NIP/NCP)</span>
              </label>

              <label className="flex items-center gap-3">
                <input type="checkbox"
                  checked={!!rulesOverrides.fog?.enabled}
                  onChange={(e) =>
                    setRulesOverrides((r) => ({...r, fog: { ...(r.fog ?? {}), enabled: e.target.checked },
                    }))
                  }
                />
                <span>Fog of War</span>
              </label>

              <label className="flex items-center gap-3">
                <input type="checkbox"
                  checked={!!rulesOverrides.instability?.enabled}
                  onChange={(e) =>
                    setRulesOverrides((r) => ({...r, instability: { ...(r.instability ?? {}), enabled: e.target.checked },
                    }))
                  }
                />
                <span>Instability Events</span>
              </label>

              <div className="flex flex-col gap-2">
                <span className="text-xs text-parchment/70">Mission Selection</span>
                <select
                  value={rulesOverrides.missions?.mode ?? "weighted_random_nip"}
                  onChange={(e) =>
                    setRulesOverrides((r) => ({...r, missions: { ...(r.missions ?? {}), mode: e.target.value },
                    }))
                }
                className="rounded-lg border border-brass/30 bg-black/30 px-3 py-2"
        >
          <option value="random">Random</option>
          <option value="player_choice">Player Choice</option>
          <option value="player_choice_nip">Player Choice + NIP Influence</option>
          <option value="weighted_random_nip">Weighted Random + NIP Influence</option>
        </select>
      </div>
    </div>
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
                      <a
                        className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                        href={`/dashboard?campaign=${row.campaign_id}`}
                      >
                        Open Dashboard
                      </a>
                      <a
                        className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                        href={`/map?campaign=${row.campaign_id}`}
                      >
                        Map
                      </a>
                      <a
                        className="px-3 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                        href={`/conflicts?campaign=${row.campaign_id}`}
                      >
                        Conflicts
                      </a>
                      {(row.role === "lead" || row.role === "admin") && (
                        <a
                          className="px-3 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30"
                          href={`/lead?campaign=${row.campaign_id}`}
                        >
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