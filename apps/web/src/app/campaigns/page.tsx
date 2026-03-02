"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  key: string;
};

type MapRow = {
  id: string;
  name: string;
  description: string | null;
  version: number;
};

// ── Layout type definitions ───────────────────────────────────────────────────

type LayoutKey = "ring" | "continent" | "radial" | "ship_line";

const LAYOUT_OPTIONS: {
  key: LayoutKey;
  label: string;
  icon: string;
  description: string;
  defaultZones: number;
}[] = [
  {
    key: "ring",
    label: "Halo Ring",
    icon: "◎",
    description:
      "A megastructure ring divided into arc segments. Classic Necromunda-style halo layout with evenly spaced zones arranged in a circle.",
    defaultZones: 8,
  },
  {
    key: "continent",
    label: "Fractured Continent",
    icon: "⬡",
    description:
      "A shattered landmass of irregular plate-like regions separated by chasms, lava flows, and collapsed terrain. Good for large player counts.",
    defaultZones: 10,
  },
  {
    key: "radial",
    label: "Radial Spokes",
    icon: "✦",
    description:
      "Zones radiating outward from a central objective point. Forces conflict at the hub early; outer zones are safer but yield less.",
    defaultZones: 7,
  },
  {
    key: "ship_line",
    label: "Void Warship",
    icon: "⸸",
    description:
      "An ancient warship rendered top-down — compartments arranged bow to stern. Tight corridors, chokepoints, and strategic hull sections.",
    defaultZones: 8,
  },
];

const ZONE_COUNT_OPTIONS: Record<LayoutKey, number[]> = {
  ring:      [6, 7, 8, 9, 10],
  continent: [8, 9, 10, 11, 12],
  radial:    [5, 6, 7, 8, 9],
  ship_line: [6, 7, 8, 9, 10],
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // Templates (loaded but hidden from UI — first one auto-selected)
  const [templates, setTemplates]             = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");

  const [memberships, setMemberships]   = useState<Membership[]>([]);
  const [campaignsById, setCampaignsById] = useState<Record<string, Campaign>>({});
  const [loading, setLoading]           = useState(true);

  const [campaignName, setCampaignName] = useState<string>("");
  const [emails, setEmails]             = useState<string>("");
  const [creating, setCreating]         = useState(false);

  const [rulesets, setRulesets]         = useState<Ruleset[]>([]);
  const [maps, setMaps]                 = useState<MapRow[]>([]);
  const [selectedRuleset, setSelectedRuleset] = useState<string>("");
  const [selectedMap, setSelectedMap]   = useState<string>("");

  // ── Layout type state ────────────────────────────────────────────────────
  const [selectedLayout, setSelectedLayout] = useState<LayoutKey>("ring");
  const [zoneCount, setZoneCount]           = useState<number>(8);

  // Keep zoneCount in range when layout changes
  useEffect(() => {
    const allowed = ZONE_COUNT_OPTIONS[selectedLayout];
    if (!allowed.includes(zoneCount)) setZoneCount(allowed[Math.floor(allowed.length / 2)]);
  }, [selectedLayout]); // eslint-disable-line react-hooks/exhaustive-deps

  const [rulesOverrides, setRulesOverrides] = useState({
    economy:    { enabled: true,  catchup: { enabled: true, bonus: 1 } },
    fog:        { enabled: true },
    instability:{ enabled: true },
    missions:   { enabled: true,  mode: "weighted_random_nip" },
    narrative:  { cp_exchange: { enabled: true } },
  });

  // ── Accept pending invites ───────────────────────────────────────────────

  const acceptInvites = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const { error } = await supabase.functions.invoke("accept-invites", { body: {} });
      if (error) console.warn("accept-invites failed:", error);
    } catch (e) {
      console.warn("accept-invites error:", e);
    }
  };

  // ── Load page data ───────────────────────────────────────────────────────

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

      // Templates (hidden from UI — auto-select first)
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

      const campMap: Record<string, Campaign> = {};
      (camps ?? []).forEach((c: any) => { campMap[c.id] = c as Campaign; });
      setCampaignsById(campMap);

    } catch (e: any) {
      console.error(e);
      alert(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }

    // Rulesets & maps (non-fatal)
    const { data: rs } = await supabase
      .from("rulesets")
      .select("id,key,name,description")
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    setRulesets((rs ?? []) as any);
    if (!selectedRuleset && rs?.length) setSelectedRuleset(rs[0].id);

    const { data: mp } = await supabase
      .from("maps")
      .select("id,name,description,version")
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    setMaps((mp ?? []) as any);
    if (!selectedMap && mp?.length) setSelectedMap(mp[0].id);
  };

  // ── Create campaign ──────────────────────────────────────────────────────

  const createCampaign = async () => {
    if (!selectedTemplate) return alert("No template found — ensure the templates table has at least one row.");
    if (!campaignName.trim()) return alert("Enter a campaign name.");

    setCreating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
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
          template_id:     selectedTemplate,
          campaign_name:   campaignName.trim(),
          player_emails:   inviteEmails,
          ruleset_id:      selectedRuleset || null,
          rules_overrides: rulesOverrides,
          map_id:          selectedMap || null,
          // ── Map generation parameters ──
          layout:          selectedLayout,
          zone_count:      zoneCount,
        },
      });

      if (error) {
        console.error("invoke error:", error);
        try {
          const text = await error.context.text();
          console.error("function response text:", text);
        } catch (e) {
          console.error("no error context body available", e);
        }
        throw error;
      }

      console.log("create-campaign response:", data);

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
    console.log("SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
    console.log("HAS_ANON_KEY", !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const myCampaignRows = memberships
    .map((m) => ({
      campaign_id: m.campaign_id,
      role:        m.role,
      campaign:    campaignsById[m.campaign_id],
    }))
    .filter((x) => !!x.campaign);

  const currentLayout = LAYOUT_OPTIONS.find((l) => l.key === selectedLayout)!;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame title="Campaigns" right={<a className="underline" href="/dashboard">Dashboard</a>}>
      <div className="space-y-6">

        {/* ── Create Campaign ── */}
        <Card title="Create Campaign">
          <div className="space-y-4">

            {/* ── Map Layout selector (replaces template dropdown) ── */}
            <div>
              <div className="text-sm text-parchment/70 mb-2">Map Layout</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {LAYOUT_OPTIONS.map((opt) => {
                  const isSelected = selectedLayout === opt.key;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => setSelectedLayout(opt.key)}
                      disabled={loading || creating}
                      className={`
                        flex flex-col items-center gap-1.5 px-3 py-3 rounded border transition-colors text-center
                        ${isSelected
                          ? "border-brass bg-brass/15 text-brass"
                          : "border-brass/25 bg-void hover:border-brass/50 hover:bg-brass/5 text-parchment/60 hover:text-parchment/90"}
                        disabled:opacity-40
                      `}
                    >
                      <span className={`text-2xl leading-none ${isSelected ? "text-brass" : "text-parchment/40"}`}>
                        {opt.icon}
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-wider leading-tight">
                        {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* Description of selected layout */}
              <p className="mt-2 text-xs text-parchment/55 italic leading-relaxed">
                {currentLayout.description}
              </p>
            </div>

            {/* ── Zone count ── */}
            <div>
              <div className="text-sm text-parchment/70 mb-1.5">
                Number of zones
                <span className="ml-2 text-brass font-semibold">{zoneCount}</span>
              </div>
              <div className="flex gap-2">
                {ZONE_COUNT_OPTIONS[selectedLayout].map((n) => (
                  <button
                    key={n}
                    onClick={() => setZoneCount(n)}
                    disabled={loading || creating}
                    className={`
                      px-3 py-1.5 rounded border text-sm font-mono transition-colors
                      ${zoneCount === n
                        ? "border-brass bg-brass/20 text-brass"
                        : "border-brass/25 bg-void hover:border-brass/40 text-parchment/55 hover:text-parchment/80"}
                      disabled:opacity-40
                    `}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Campaign name ── */}
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

            {/* ── Optional rules ── */}
            <div className="rounded-2xl border border-brass/30 bg-iron/70 p-4">
              <div className="text-sm font-semibold uppercase tracking-[0.18em] text-brass/90">
                Optional Rules
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={!!rulesOverrides.economy?.enabled}
                    onChange={(e) =>
                      setRulesOverrides((r) => ({
                        ...r,
                        economy: { ...(r.economy ?? {}), enabled: e.target.checked },
                      }))
                    }
                  />
                  <span>Economy (NIP/NCP)</span>
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={!!rulesOverrides.fog?.enabled}
                    onChange={(e) =>
                      setRulesOverrides((r) => ({
                        ...r,
                        fog: { ...(r.fog ?? {}), enabled: e.target.checked },
                      }))
                    }
                  />
                  <span>Fog of War</span>
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={!!rulesOverrides.instability?.enabled}
                    onChange={(e) =>
                      setRulesOverrides((r) => ({
                        ...r,
                        instability: { ...(r.instability ?? {}), enabled: e.target.checked },
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
                      setRulesOverrides((r) => ({
                        ...r,
                        missions: { ...(r.missions ?? {}), mode: e.target.value },
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

            {/* ── Invite emails ── */}
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
                Invites are stored in{" "}
                <span className="text-brass">pending_invites</span>. Players auto-join when they sign in.
              </p>
            </div>

            <button
              className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={createCampaign}
              disabled={creating || loading || !templates.length}
            >
              {creating ? "Creating…" : "Create (you become Lead)"}
            </button>

            {/* No template warning (shown if templates table is empty) */}
            {!loading && !templates.length && (
              <p className="text-xs text-blood/80 text-center">
                No templates found in the{" "}
                <span className="text-brass">templates</span> table — campaign creation is disabled.
              </p>
            )}
          </div>
        </Card>

        {/* ── My Campaigns ── */}
        <Card title="My Campaigns">
          {loading ? (
            <p className="text-parchment/70">Loading…</p>
          ) : myCampaignRows.length ? (
            <div className="space-y-3">
              {myCampaignRows.map((row) => (
                <div
                  key={row.campaign_id}
                  className="rounded border border-brass/25 bg-void px-4 py-3"
                >
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                    <div>
                      <div className="text-brass font-semibold">{row.campaign!.name}</div>
                      <div className="text-xs text-parchment/60">
                        Role: {row.role} • Phase {row.campaign!.phase} • Round{" "}
                        {row.campaign!.round_number} • Instability {row.campaign!.instability}/10
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
