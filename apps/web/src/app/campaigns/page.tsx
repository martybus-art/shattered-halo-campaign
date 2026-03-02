// apps/web/src/app/campaigns/page.tsx
// Create Campaign wizard — map layout, S/M/L zone size, biome, rules config,
// map preview with approve/regenerate, then activate. My Campaigns is on the home page.
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";
import { MapImageDisplay } from "@/components/MapImageDisplay";

// ── Types ─────────────────────────────────────────────────────────────────────

type Template = { id: string; name: string; description: string | null };

type LayoutKey  = "ring" | "continent" | "radial" | "ship_line";
type ZoneSizeKey = "small" | "medium" | "large";
type WizardStep  = "configure" | "previewing";

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
          className={`pointer-events-auto rounded border px-4 py-3 shadow-2xl shadow-black/60 backdrop-blur-sm
            ${t.type === "success" ? "bg-void border-brass/60" : ""}
            ${t.type === "error"   ? "bg-void border-blood/60" : ""}
            ${t.type === "info"    ? "bg-void border-brass/30" : ""}
          `}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className={`text-sm font-semibold uppercase tracking-widest
                ${t.type === "success" ? "text-brass"    : ""}
                ${t.type === "error"   ? "text-blood"    : ""}
                ${t.type === "info"    ? "text-brass/70" : ""}
              `}>
                {t.type === "success" && "⚙ "}
                {t.type === "error"   && "☠ "}
                {t.type === "info"    && "✦ "}
                {t.title}
              </p>
              {t.body && <p className="mt-1 text-xs text-parchment/60 leading-relaxed">{t.body}</p>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-parchment/30 hover:text-parchment/70 text-lg leading-none mt-0.5 shrink-0">×</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Layout options ─────────────────────────────────────────────────────────────

const LAYOUT_OPTIONS: { key: LayoutKey; label: string; icon: string; description: string }[] = [
  {
    key: "ring",
    label: "Halo Ring",
    icon: "◎",
    description: "Arc segments of a megastructure ring. Classic halo layout — evenly spaced zones arranged in a circle around a central void.",
  },
  {
    key: "continent",
    label: "Fractured Continent",
    icon: "⬡",
    description: "A shattered landmass of irregular plate-like regions divided by chasms, lava flows, and collapsed terrain.",
  },
  {
    key: "radial",
    label: "Radial Spokes",
    icon: "✦",
    description: "Zones radiating out from a central objective point. Forces conflict at the hub early; outer zones are safer but yield less.",
  },
  {
    key: "ship_line",
    label: "Void Warship",
    icon: "⸸",
    description: "An ancient warship viewed top-down — compartments arranged bow to stern. Tight corridors and strategic chokepoints.",
  },
];

// ── Zone sizes ────────────────────────────────────────────────────────────────
// Each size maps to a zone count per layout type.

const ZONE_SIZES: { key: ZoneSizeKey; label: string; description: string }[] = [
  { key: "small",  label: "Small",  description: "4 zones — fast, brutal campaign" },
  { key: "medium", label: "Medium", description: "8 zones — balanced campaign"      },
  { key: "large",  label: "Large",  description: "12 zones — epic campaign"          },
];

const ZONE_COUNT: Record<LayoutKey, Record<ZoneSizeKey, number>> = {
  ring:      { small: 5,  medium: 8,  large: 10 },
  continent: { small: 6,  medium: 9,  large: 12 },
  radial:    { small: 5,  medium: 7,  large: 9  },
  ship_line: { small: 5,  medium: 8,  large: 10 },
};

// ── Biome options (for ring/continent/radial — not ship) ──────────────────────

const BIOME_OPTIONS = [
  { value: "ash_wastes",    label: "Ash Wastes"      },
  { value: "ice_world",     label: "Ice World"       },
  { value: "jungle",        label: "Death World Jungle" },
  { value: "desert",        label: "Desert / Dust"   },
  { value: "hive_ruins",    label: "Hive Ruins"      },
  { value: "void_station",  label: "Void Station"    },
  { value: "forge_world",   label: "Forge World"     },
  { value: "death_world",   label: "Daemon World"    },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // Template (hidden from UI — auto-selected)
  const [templates, setTemplates]             = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [selectedRuleset, setSelectedRuleset] = useState<string>("");
  const [loading, setLoading]                 = useState(true);

  // Form
  const [campaignName, setCampaignName]         = useState("");
  const [emails, setEmails]                     = useState("");
  const [selectedLayout, setSelectedLayout]     = useState<LayoutKey>("ring");
  const [selectedSize, setSelectedSize]         = useState<ZoneSizeKey>("medium");
  const [mixedBiomes, setMixedBiomes]           = useState(false);
  const [primaryBiome, setPrimaryBiome]         = useState("ash_wastes");
  const [rulesOverrides, setRulesOverrides]     = useState({
    economy:     { enabled: true,  catchup: { enabled: true, bonus: 1 } },
    fog:         { enabled: true  },
    instability: { enabled: true  },
    missions:    { enabled: true,  mode: "weighted_random_nip" },
    narrative:   { cp_exchange: { enabled: true } },
  });

  // Wizard
  const [wizardStep, setWizardStep]               = useState<WizardStep>("configure");
  const [previewCampaignId, setPreviewCampaignId] = useState<string | null>(null);
  const [previewMapId, setPreviewMapId]           = useState<string | null>(null);
  const [creating, setCreating]                   = useState(false);
  const [regenerating, setRegenerating]           = useState(false);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: ToastType, title: string, body?: string) => {
    const id = ++_toastId;
    setToasts(t => [...t, { id, type, title, body }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);

  // ── Load ──────────────────────────────────────────────────────────────────

  const acceptInvites = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      await supabase.functions.invoke("accept-invites", { body: {} });
    } catch { /* non-fatal */ }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: userResp } = await supabase.auth.getUser();
      if (!userResp.user) return;
      await acceptInvites();

      const { data: tpls, error: te } = await supabase
        .from("templates").select("id,name,description").order("created_at", { ascending: false });
      if (te) throw te;
      const tplRows = (tpls ?? []) as Template[];
      setTemplates(tplRows);
      if (!selectedTemplate && tplRows.length) setSelectedTemplate(tplRows[0].id);

    } catch (e: any) {
      addToast("error", "Load failed", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }

    const { data: rs } = await supabase.from("rulesets").select("id,key,name,description")
      .eq("is_active", true).order("created_at", { ascending: false });
    if (!selectedRuleset && rs?.length) setSelectedRuleset(rs[0].id);
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived zone count ────────────────────────────────────────────────────

  const zoneCount = ZONE_COUNT[selectedLayout][selectedSize];

  // ── Step 1 → preview: create campaign + trigger map generation ───────────

  const generatePreview = async () => {
    if (!selectedTemplate) { addToast("error", "No template", "Ensure the templates table has at least one row."); return; }
    if (!campaignName.trim()) { addToast("error", "Name required", "Enter a campaign name before generating the map."); return; }

    setCreating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { addToast("error", "Session expired", "Refresh and try again."); return; }

      const { data, error } = await supabase.functions.invoke("create-campaign", {
        body: {
          template_id:     selectedTemplate,
          campaign_name:   campaignName.trim(),
          player_emails:   emails.split(",").map(e => e.trim()).filter(Boolean),
          ruleset_id:      selectedRuleset || null,
          rules_overrides: rulesOverrides,
          layout:          selectedLayout,
          zone_count:      zoneCount,
          biome:           primaryBiome,
          mixed_biomes:    mixedBiomes,
        },
      });

      if (error) {
        try { console.error("fn body:", await error.context.text()); } catch { /* ignore */ }
        throw error;
      }
      if (!data?.ok) throw new Error(data?.error ?? "Unknown error");

      setPreviewCampaignId(data.campaign_id);
      setPreviewMapId(data.map_id ?? null);
      setWizardStep("previewing");

    } catch (e: any) {
      addToast("error", "Creation failed", e?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  // ── Regenerate map ────────────────────────────────────────────────────────

  const regenerateMap = async () => {
    if (!previewMapId || !previewCampaignId || regenerating) return;
    setRegenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-map", {
        body: {
          map_id:       previewMapId,
          campaign_id:  previewCampaignId,
          layout:       selectedLayout,
          zone_count:   zoneCount,
          biome:        primaryBiome,
          mixed_biomes: mixedBiomes,
          art_version:  "grimdark-v2",
        },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Regenerate failed");
      addToast("info", "Regenerating", "A new map is being forged. Allow 20–30 seconds.");
    } catch (e: any) {
      addToast("error", "Regenerate failed", e?.message ?? String(e));
    } finally {
      setRegenerating(false);
    }
  };

  // ── Confirm campaign ──────────────────────────────────────────────────────

  const confirmCampaign = () => {
    addToast("success", "Campaign created", "You are the Lead Strategos. Open the dashboard to begin.");
    // Reset form
    setCampaignName("");
    setEmails("");
    setSelectedLayout("ring");
    setSelectedSize("medium");
    setMixedBiomes(false);
    setPrimaryBiome("ash_wastes");
    setPreviewCampaignId(null);
    setPreviewMapId(null);
    setWizardStep("configure");
  };

  // ── Cancel preview ────────────────────────────────────────────────────────

  const cancelPreview = () => {
    setWizardStep("configure");
    addToast("info", "Preview cancelled", "Draft campaign kept. Delete it via Lead Controls if needed.");
  };

  const currentLayout = LAYOUT_OPTIONS.find(l => l.key === selectedLayout)!;
  const isShipLayout  = selectedLayout === "ship_line";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame title="Campaigns" right={<a className="underline" href="/dashboard">Dashboard</a>}>
      <div className="space-y-6">

        {/* ══ STEP 1 — Configure ══════════════════════════════════════════ */}
        {wizardStep === "configure" && (
          <Card title="Create Campaign">
            <div className="space-y-5">

              {/* ── Map Layout ── */}
              <div>
                <p className="text-sm text-parchment/70 mb-2">Map Layout</p>
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

              {/* ── Zone size ── */}
              <div>
                <p className="text-sm text-parchment/70 mb-1.5">Campaign Scale</p>
                <div className="grid grid-cols-3 gap-2">
                  {ZONE_SIZES.map((sz) => {
                    const sel = selectedSize === sz.key;
                    return (
                      <button
                        key={sz.key}
                        onClick={() => setSelectedSize(sz.key)}
                        disabled={loading || creating}
                        className={`flex flex-col items-center gap-0.5 px-3 py-3 rounded border transition-colors disabled:opacity-40
                          ${sel
                            ? "border-brass bg-brass/15"
                            : "border-brass/25 bg-void hover:border-brass/40 hover:bg-brass/5"
                          }`}
                      >
                        <span className={`text-sm font-bold uppercase tracking-wider ${sel ? "text-brass" : "text-parchment/60"}`}>
                          {sz.label}
                        </span>
                        <span className={`text-xs ${sel ? "text-brass/70" : "text-parchment/40"}`}>
                          {sz.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-xs text-parchment/40">
                  {selectedLayout !== "ship_line"
                    ? `${ZONE_COUNT[selectedLayout][selectedSize]} zones for this layout`
                    : `${ZONE_COUNT[selectedLayout][selectedSize]} compartments`
                  }
                </p>
              </div>

              {/* ── Biome (planetary layouts only) ── */}
              {!isShipLayout && (
                <div>
                  <p className="text-sm text-parchment/70 mb-1.5">Terrain Biome</p>
                  <div className="flex flex-col gap-3">
                    <select
                      value={primaryBiome}
                      onChange={(e) => setPrimaryBiome(e.target.value)}
                      disabled={loading || creating}
                      className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm focus:outline-none focus:border-brass/60"
                    >
                      {BIOME_OPTIONS.map(b => (
                        <option key={b.value} value={b.value}>{b.label}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={mixedBiomes}
                        onChange={(e) => setMixedBiomes(e.target.checked)}
                        disabled={loading || creating}
                      />
                      <div>
                        <span className="text-sm text-parchment/80">Mixed biomes</span>
                        <p className="text-xs text-parchment/40 leading-tight">
                          Each zone uses a different terrain type — more varied but chaotic.
                          Off = single biome across all zones.
                        </p>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {/* ── Campaign name ── */}
              <div>
                <p className="text-sm text-parchment/70 mb-1">Campaign name</p>
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
                <p className="text-xs font-semibold uppercase tracking-widest text-brass/80 mb-3">
                  Optional Rules
                </p>
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
                <p className="text-sm text-parchment/70 mb-1">Invite emails (comma-separated, optional)</p>
                <input
                  className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60"
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="commander@warzone.com, sergeant@forge.world"
                  disabled={loading || creating}
                />
                <p className="mt-1 text-xs text-parchment/40">
                  Players auto-join when they sign in. More invites available from the home page.
                </p>
              </div>

              {/* ── Generate preview button ── */}
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
                ) : "✦ Generate Map Preview"}
              </button>

              {!loading && !templates.length && (
                <p className="text-xs text-blood/80 text-center">
                  No templates found — campaign creation is disabled.
                </p>
              )}
            </div>
          </Card>
        )}

        {/* ══ STEP 2 — Map Preview ════════════════════════════════════════ */}
        {wizardStep === "previewing" && previewCampaignId && (
          <Card title="Map Preview — Review Your Warzone">
            <div className="space-y-4">
              <p className="text-sm text-parchment/60 leading-relaxed">
                Your campaign has been created and the map is generating.
                Review it below — regenerate if needed, then confirm to activate.
              </p>

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
                  ) : "↺ Regenerate Map"}
                </button>
                <button
                  onClick={confirmCampaign}
                  className="flex-1 px-4 py-2.5 rounded bg-brass/25 border border-brass/60 hover:bg-brass/40 text-brass font-bold text-sm uppercase tracking-wider transition-colors"
                >
                  ✓ Confirm Campaign
                </button>
              </div>

              <p className="text-xs text-parchment/30 text-center font-mono">
                {previewCampaignId}
              </p>
            </div>
          </Card>
        )}

      </div>

      <ToastContainer toasts={toasts} dismiss={dismissToast} />
    </Frame>
  );
}
