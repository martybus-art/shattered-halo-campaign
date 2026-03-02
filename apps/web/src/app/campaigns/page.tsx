// apps/web/src/app/campaigns/page.tsx
// Campaign list + multi-step Create Campaign wizard with map preview-first flow.
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";
import { MapImageDisplay } from "@/components/MapImageDisplay";

// ── Types ─────────────────────────────────────────────────────────────────────

type Template   = { id: string; name: string; description: string | null };
type Campaign   = { id: string; name: string; phase: number; round_number: number; instability: number; created_at: string };
type Membership = { campaign_id: string; role: string };
type Ruleset    = { id: string; name: string; description: string | null; key: string };
type MapRow     = { id: string; name: string; description: string | null; version: number };

type LayoutKey = "ring" | "continent" | "radial" | "ship_line";

// ── Wizard steps ──────────────────────────────────────────────────────────────
// configure  → user fills in the form
// previewing → campaign + map row created, map is generating, user can approve or regenerate
// done       → user approved, success toast shown, campaign appears in list
type WizardStep = "configure" | "previewing" | "done";

// ── Toast ─────────────────────────────────────────────────────────────────────

type ToastType = "success" | "error" | "info";
interface Toast { id: number; type: ToastType; title: string; body?: string }

let _toastId = 0;

function ToastContainer({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded border px-4 py-3 shadow-2xl shadow-black/60 backdrop-blur-sm transition-all
            ${t.type === "success" ? "bg-void border-brass/60 text-parchment" : ""}
            ${t.type === "error"   ? "bg-void border-blood/60 text-parchment" : ""}
            ${t.type === "info"    ? "bg-void border-brass/30 text-parchment" : ""}
          `}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className={`text-sm font-semibold uppercase tracking-widest
                ${t.type === "success" ? "text-brass" : ""}
                ${t.type === "error"   ? "text-blood"  : ""}
                ${t.type === "info"    ? "text-brass/70" : ""}
              `}>
                {t.type === "success" && "⚙ "}
                {t.type === "error"   && "☠ "}
                {t.type === "info"    && "✦ "}
                {t.title}
              </p>
              {t.body && <p className="mt-1 text-xs text-parchment/60 leading-relaxed">{t.body}</p>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-parchment/30 hover:text-parchment/70 text-lg leading-none mt-0.5 shrink-0"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Invite Modal ──────────────────────────────────────────────────────────────

interface InviteModalProps {
  campaign: Campaign;
  onClose: () => void;
  onToast: (type: ToastType, title: string, body?: string) => void;
}

function InviteModal({ campaign, onClose, onToast }: InviteModalProps) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [emails, setEmails]   = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const list = emails.split(",").map(e => e.trim()).filter(Boolean);
    if (!list.length) { onToast("error", "No emails entered", "Enter at least one email address."); return; }
    setSending(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Session expired — refresh and try again.");

      // Insert directly into pending_invites
      const rows = list.map(email => ({ campaign_id: campaign.id, email: email.toLowerCase() }));
      const { error } = await supabase.from("pending_invites").insert(rows);
      if (error) throw error;

      onToast("success", "Invites sent", `${list.length} invite${list.length > 1 ? "s" : ""} queued for ${campaign.name}.`);
      onClose();
    } catch (e: any) {
      onToast("error", "Invite failed", e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-md rounded border border-brass/40 bg-void shadow-2xl shadow-black/80 p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-parchment/40 uppercase tracking-widest mb-0.5">Invite Players</p>
            <h3 className="text-brass font-semibold text-lg leading-tight">{campaign.name}</h3>
          </div>
          <button onClick={onClose} className="text-parchment/30 hover:text-parchment/70 text-xl leading-none">×</button>
        </div>

        <div>
          <label className="block text-sm text-parchment/70 mb-1">Email addresses (comma-separated)</label>
          <textarea
            className="w-full px-3 py-2 rounded bg-black/30 border border-brass/30 text-sm text-parchment resize-none h-24 focus:outline-none focus:border-brass/60"
            placeholder="commander@warzone.com, sergeant@forge.world"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            disabled={sending}
          />
          <p className="mt-1 text-xs text-parchment/40">
            Players auto-join when they sign in. Pending invites are stored until accepted.
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={sending}
            className="flex-1 px-4 py-2 rounded border border-brass/25 text-parchment/60 hover:text-parchment/90 hover:border-brass/40 text-sm transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sending}
            className="flex-1 px-4 py-2 rounded bg-brass/20 border border-brass/50 hover:bg-brass/30 text-brass font-semibold text-sm transition-colors disabled:opacity-40"
          >
            {sending ? "Sending…" : "Send Invites"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Layout options ─────────────────────────────────────────────────────────────

const LAYOUT_OPTIONS: { key: LayoutKey; label: string; icon: string; description: string }[] = [
  {
    key: "ring",
    label: "Halo Ring",
    icon: "◎",
    description: "A megastructure ring divided into arc segments. Classic halo layout with evenly spaced zones arranged in a circle.",
  },
  {
    key: "continent",
    label: "Fractured Continent",
    icon: "⬡",
    description: "A shattered landmass of irregular plate-like regions separated by chasms, lava flows, and collapsed terrain.",
  },
  {
    key: "radial",
    label: "Radial Spokes",
    icon: "✦",
    description: "Zones radiating outward from a central objective point. Forces conflict at the hub; outer zones are safer but yield less.",
  },
  {
    key: "ship_line",
    label: "Void Warship",
    icon: "⸸",
    description: "An ancient warship viewed top-down — compartments arranged bow to stern. Tight corridors and strategic chokepoints.",
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

  // ── Data ──────────────────────────────────────────────────────────────────
  const [templates, setTemplates]             = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [memberships, setMemberships]         = useState<Membership[]>([]);
  const [campaignsById, setCampaignsById]     = useState<Record<string, Campaign>>({});
  const [rulesets, setRulesets]               = useState<Ruleset[]>([]);
  const [maps, setMaps]                       = useState<MapRow[]>([]);
  const [selectedRuleset, setSelectedRuleset] = useState<string>("");
  const [loading, setLoading]                 = useState(true);

  // ── Form ──────────────────────────────────────────────────────────────────
  const [campaignName, setCampaignName]   = useState("");
  const [emails, setEmails]               = useState("");
  const [selectedLayout, setSelectedLayout] = useState<LayoutKey>("ring");
  const [zoneCount, setZoneCount]         = useState<number>(8);
  const [rulesOverrides, setRulesOverrides] = useState({
    economy:     { enabled: true,  catchup: { enabled: true, bonus: 1 } },
    fog:         { enabled: true  },
    instability: { enabled: true  },
    missions:    { enabled: true,  mode: "weighted_random_nip" },
    narrative:   { cp_exchange: { enabled: true } },
  });

  // ── Wizard ────────────────────────────────────────────────────────────────
  const [wizardStep, setWizardStep]           = useState<WizardStep>("configure");
  const [previewCampaignId, setPreviewCampaignId] = useState<string | null>(null);
  const [previewMapId, setPreviewMapId]       = useState<string | null>(null);
  const [creating, setCreating]               = useState(false);
  const [regenerating, setRegenerating]       = useState(false);

  // ── Toasts ────────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: ToastType, title: string, body?: string) => {
    const id = ++_toastId;
    setToasts(t => [...t, { id, type, title, body }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);

  // ── Invite modal ──────────────────────────────────────────────────────────
  const [inviteTarget, setInviteTarget] = useState<Campaign | null>(null);

  // ── Layout → zone count sync ──────────────────────────────────────────────
  useEffect(() => {
    const allowed = ZONE_COUNT_OPTIONS[selectedLayout];
    if (!allowed.includes(zoneCount)) setZoneCount(allowed[Math.floor(allowed.length / 2)]);
  }, [selectedLayout]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Accept pending invites on load ────────────────────────────────────────
  const acceptInvites = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      await supabase.functions.invoke("accept-invites", { body: {} });
    } catch { /* non-fatal */ }
  };

  // ── Load page data ────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: userResp } = await supabase.auth.getUser();
      if (!userResp.user) { setTemplates([]); setMemberships([]); setCampaignsById({}); return; }

      await acceptInvites();

      const { data: tpls, error: te } = await supabase
        .from("templates").select("id,name,description").order("created_at", { ascending: false });
      if (te) throw te;
      const tplRows = (tpls ?? []) as Template[];
      setTemplates(tplRows);
      if (!selectedTemplate && tplRows.length) setSelectedTemplate(tplRows[0].id);

      const { data: mem, error: me } = await supabase
        .from("campaign_members").select("campaign_id,role").order("created_at", { ascending: false });
      if (me) throw me;
      const memRows = (mem ?? []) as Membership[];
      setMemberships(memRows);

      const ids = memRows.map(m => m.campaign_id);
      if (ids.length) {
        const { data: camps, error: ce } = await supabase
          .from("campaigns").select("id,name,phase,round_number,instability,created_at").in("id", ids);
        if (ce) throw ce;
        const campMap: Record<string, Campaign> = {};
        (camps ?? []).forEach((c: any) => { campMap[c.id] = c as Campaign; });
        setCampaignsById(campMap);
      } else {
        setCampaignsById({});
      }
    } catch (e: any) {
      addToast("error", "Load failed", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }

    // Non-fatal extras
    const { data: rs } = await supabase.from("rulesets").select("id,key,name,description")
      .eq("is_active", true).order("created_at", { ascending: false });
    setRulesets((rs ?? []) as any);
    if (!selectedRuleset && rs?.length) setSelectedRuleset(rs[0].id);
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Step 1 → 2: Generate map preview ─────────────────────────────────────
  // Creates the campaign + maps row and fires generate-map in the background.
  // Transitions to the preview step so the user can see the map before confirming.
  const generatePreview = async () => {
    if (!selectedTemplate) { addToast("error", "No template", "Ensure the templates table has at least one row."); return; }
    if (!campaignName.trim()) { addToast("error", "Name required", "Enter a campaign name before generating the map."); return; }

    setCreating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { addToast("error", "Session expired", "Refresh the page and try again."); return; }

      const inviteEmails = emails.split(",").map(e => e.trim()).filter(Boolean);

      const { data, error } = await supabase.functions.invoke("create-campaign", {
        body: {
          template_id:     selectedTemplate,
          campaign_name:   campaignName.trim(),
          player_emails:   inviteEmails,
          ruleset_id:      selectedRuleset || null,
          rules_overrides: rulesOverrides,
          layout:          selectedLayout,
          zone_count:      zoneCount,
        },
      });

      if (error) {
        try { const t = await error.context.text(); console.error("fn body:", t); } catch { /* ignore */ }
        throw error;
      }
      if (!data?.ok) throw new Error(data?.error ?? "Unknown error");

      // Campaign + map created — move to preview step
      setPreviewCampaignId(data.campaign_id);
      setPreviewMapId(data.map_id ?? null);
      setWizardStep("previewing");

    } catch (e: any) {
      addToast("error", "Creation failed", e?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  // ── Step 2: Regenerate map ─────────────────────────────────────────────────
  const regenerateMap = async () => {
    if (!previewMapId || !previewCampaignId || regenerating) return;
    setRegenerating(true);
    try {
      const res  = await fetch("/api/map/regenerate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ map_id: previewMapId, campaign_id: previewCampaignId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Regenerate failed");
      addToast("info", "Regenerating", "A new map is being forged. Give it 20–30 seconds.");
    } catch (e: any) {
      addToast("error", "Regenerate failed", e?.message ?? String(e));
    } finally {
      setRegenerating(false);
    }
  };

  // ── Step 2 → 3: Confirm campaign ──────────────────────────────────────────
  const confirmCampaign = async () => {
    setWizardStep("done");
    setCampaignName("");
    setEmails("");
    setSelectedLayout("ring");
    setZoneCount(8);
    setPreviewCampaignId(null);
    setPreviewMapId(null);
    addToast(
      "success",
      "Campaign created",
      "You are the Lead Strategos. Your warzone awaits — open the dashboard to begin.",
    );
    await load();
    // Reset wizard to configure for next creation
    setWizardStep("configure");
  };

  // ── Cancel preview (delete the draft campaign) ────────────────────────────
  const cancelPreview = async () => {
    if (!previewCampaignId) { setWizardStep("configure"); return; }
    // Soft cancel — just go back to configure. Campaign remains but user can
    // delete it from Lead Controls. We don't auto-delete to avoid data loss.
    setWizardStep("configure");
    addToast(
      "info",
      "Preview cancelled",
      "The draft campaign was kept. You can delete it from Lead Controls if needed.",
    );
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const myCampaignRows = memberships
    .map(m => ({ campaign_id: m.campaign_id, role: m.role, campaign: campaignsById[m.campaign_id] }))
    .filter(x => !!x.campaign);

  const currentLayout = LAYOUT_OPTIONS.find(l => l.key === selectedLayout)!;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame title="Campaigns" right={<a className="underline" href="/dashboard">Dashboard</a>}>
      <div className="space-y-6">

        {/* ══════════════════════════════════════════════════════
            STEP 1 — Configure
        ══════════════════════════════════════════════════════ */}
        {wizardStep === "configure" && (
          <Card title="Create Campaign">
            <div className="space-y-5">

              {/* ── Map Layout ── */}
              <div>
                <div className="text-sm text-parchment/70 mb-2">Map Layout</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {LAYOUT_OPTIONS.map((opt) => {
                    const sel = selectedLayout === opt.key;
                    return (
                      <button
                        key={opt.key}
                        onClick={() => setSelectedLayout(opt.key)}
                        disabled={loading || creating}
                        className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded border transition-colors text-center disabled:opacity-40
                          ${sel
                            ? "border-brass bg-brass/15 text-brass"
                            : "border-brass/25 bg-void hover:border-brass/50 hover:bg-brass/5 text-parchment/60 hover:text-parchment/90"
                          }`}
                      >
                        <span className={`text-2xl leading-none ${sel ? "text-brass" : "text-parchment/40"}`}>
                          {opt.icon}
                        </span>
                        <span className="text-xs font-semibold uppercase tracking-wider leading-tight">
                          {opt.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-parchment/50 italic leading-relaxed">
                  {currentLayout.description}
                </p>
              </div>

              {/* ── Zone count ── */}
              <div>
                <div className="text-sm text-parchment/70 mb-1.5">
                  Number of zones <span className="ml-2 text-brass font-semibold">{zoneCount}</span>
                </div>
                <div className="flex gap-2">
                  {ZONE_COUNT_OPTIONS[selectedLayout].map((n) => (
                    <button
                      key={n}
                      onClick={() => setZoneCount(n)}
                      disabled={loading || creating}
                      className={`px-3 py-1.5 rounded border text-sm font-mono transition-colors disabled:opacity-40
                        ${zoneCount === n
                          ? "border-brass bg-brass/20 text-brass"
                          : "border-brass/25 bg-void hover:border-brass/40 text-parchment/55 hover:text-parchment/80"
                        }`}
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
                  className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="e.g. Embers of the Shattered Halo (Season 1)"
                  disabled={loading || creating}
                />
              </div>

              {/* ── Optional rules ── */}
              <div className="rounded border border-brass/25 bg-black/20 p-4">
                <div className="text-xs font-semibold uppercase tracking-widest text-brass/80 mb-3">
                  Optional Rules
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox"
                      checked={!!rulesOverrides.economy?.enabled}
                      onChange={(e) => setRulesOverrides(r => ({ ...r, economy: { ...(r.economy ?? {}), enabled: e.target.checked } }))}
                    />
                    <span className="text-sm">Economy (NIP/NCP)</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox"
                      checked={!!rulesOverrides.fog?.enabled}
                      onChange={(e) => setRulesOverrides(r => ({ ...r, fog: { ...(r.fog ?? {}), enabled: e.target.checked } }))}
                    />
                    <span className="text-sm">Fog of War</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox"
                      checked={!!rulesOverrides.instability?.enabled}
                      onChange={(e) => setRulesOverrides(r => ({ ...r, instability: { ...(r.instability ?? {}), enabled: e.target.checked } }))}
                    />
                    <span className="text-sm">Instability Events</span>
                  </label>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-parchment/60">Mission Selection</span>
                    <select
                      value={rulesOverrides.missions?.mode ?? "weighted_random_nip"}
                      onChange={(e) => setRulesOverrides(r => ({ ...r, missions: { ...(r.missions ?? {}), mode: e.target.value } }))}
                      className="rounded border border-brass/30 bg-black/30 px-3 py-1.5 text-sm"
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
                <div className="text-sm text-parchment/70 mb-1">Invite emails (comma-separated, optional)</div>
                <input
                  className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60"
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="commander@warzone.com, sergeant@forge.world"
                  disabled={loading || creating}
                />
                <p className="mt-1 text-xs text-parchment/45">
                  Players auto-join when they sign in. More can be invited later from each campaign.
                </p>
              </div>

              {/* ── Generate map preview button ── */}
              <button
                className="w-full px-4 py-3 rounded bg-brass/20 border border-brass/50 hover:bg-brass/30 text-brass font-semibold tracking-wider uppercase text-sm transition-colors disabled:opacity-40"
                onClick={generatePreview}
                disabled={creating || loading || !templates.length}
              >
                {creating ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                    Forging campaign…
                  </span>
                ) : (
                  "✦ Generate Map Preview"
                )}
              </button>

              {!loading && !templates.length && (
                <p className="text-xs text-blood/80 text-center">
                  No templates found — campaign creation is disabled.
                </p>
              )}
            </div>
          </Card>
        )}

        {/* ══════════════════════════════════════════════════════
            STEP 2 — Map Preview
        ══════════════════════════════════════════════════════ */}
        {wizardStep === "previewing" && previewCampaignId && (
          <Card title="Map Preview — Review Your Warzone">
            <div className="space-y-4">

              <p className="text-sm text-parchment/60 leading-relaxed">
                Your campaign has been created and the map is generating. Review it below — you can
                regenerate if you&apos;re not happy with the result, or confirm to proceed.
              </p>

              {/* Live map preview — polls until complete */}
              {previewMapId ? (
                <MapImageDisplay
                  mapId={previewMapId}
                  campaignId={previewCampaignId}
                  isLead={true}
                  className="rounded"
                />
              ) : (
                <div className="flex items-center justify-center h-32 text-parchment/40 text-sm animate-pulse">
                  Awaiting map generation…
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-col sm:flex-row gap-3 pt-2">
                <button
                  onClick={cancelPreview}
                  className="flex-1 px-4 py-2.5 rounded border border-brass/25 text-parchment/60 hover:text-parchment/90 hover:border-brass/40 text-sm transition-colors"
                >
                  ← Back to form
                </button>
                <button
                  onClick={regenerateMap}
                  disabled={regenerating}
                  className="flex-1 px-4 py-2.5 rounded border border-brass/40 bg-void hover:bg-brass/10 text-brass text-sm font-semibold transition-colors disabled:opacity-40"
                >
                  {regenerating ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-3.5 h-3.5 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                      Regenerating…
                    </span>
                  ) : (
                    "↺ Regenerate Map"
                  )}
                </button>
                <button
                  onClick={confirmCampaign}
                  className="flex-1 px-4 py-2.5 rounded bg-brass/25 border border-brass/60 hover:bg-brass/40 text-brass font-bold text-sm uppercase tracking-wider transition-colors"
                >
                  ✓ Confirm Campaign
                </button>
              </div>

              <p className="text-xs text-parchment/35 text-center">
                Campaign: <span className="text-brass/60 font-mono">{previewCampaignId}</span>
              </p>
            </div>
          </Card>
        )}

        {/* ══════════════════════════════════════════════════════
            My Campaigns
        ══════════════════════════════════════════════════════ */}
        <Card title="My Campaigns">
          {loading ? (
            <p className="text-parchment/70 animate-pulse">Loading…</p>
          ) : myCampaignRows.length ? (
            <div className="space-y-3">
              {myCampaignRows.map((row) => (
                <div key={row.campaign_id} className="rounded border border-brass/25 bg-void px-4 py-3">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div>
                      <div className="text-brass font-semibold">{row.campaign!.name}</div>
                      <div className="text-xs text-parchment/50 mt-0.5">
                        {row.role === "lead" ? "⚙ Lead" : "✦ Player"} &nbsp;·&nbsp;
                        Phase {row.campaign!.phase} &nbsp;·&nbsp;
                        Round {row.campaign!.round_number} &nbsp;·&nbsp;
                        Instability {row.campaign!.instability}/10
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm transition-colors"
                        href={`/dashboard?campaign=${row.campaign_id}`}>
                        Dashboard
                      </a>
                      <a className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm transition-colors"
                        href={`/map?campaign=${row.campaign_id}`}>
                        Map
                      </a>
                      <a className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm transition-colors"
                        href={`/conflicts?campaign=${row.campaign_id}`}>
                        Conflicts
                      </a>
                      {(row.role === "lead" || row.role === "admin") && (
                        <>
                          <button
                            onClick={() => setInviteTarget(row.campaign!)}
                            className="px-3 py-1.5 rounded bg-brass/10 border border-brass/30 hover:bg-brass/20 text-sm text-brass/80 hover:text-brass transition-colors"
                          >
                            + Invite
                          </button>
                          <a className="px-3 py-1.5 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-sm transition-colors"
                            href={`/lead?campaign=${row.campaign_id}`}>
                            Lead Controls
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-parchment/60 italic">No campaigns yet. Create one above.</p>
          )}
        </Card>

      </div>

      {/* ── Invite modal ── */}
      {inviteTarget && (
        <InviteModal
          campaign={inviteTarget}
          onClose={() => setInviteTarget(null)}
          onToast={addToast}
        />
      )}

      {/* ── Toast notifications ── */}
      <ToastContainer toasts={toasts} dismiss={dismissToast} />
    </Frame>
  );
}
