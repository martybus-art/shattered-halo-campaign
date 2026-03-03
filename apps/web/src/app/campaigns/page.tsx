// apps/web/src/app/campaigns/page.tsx
// Create Campaign wizard — map layout, S/M/L zone size, biome toggle, narrative,
// rules config, map preview with approve/regenerate/cancel, then redirect to lead.
// changelog:
//   2026-03-03 — swapped Campaign Scale above Map Layout; biome section is now a
//                toggle switch (single/mixed) visible only for non-ship layouts;
//                biome dropdown only visible when single-biome mode is active;
//                updated BIOME_OPTIONS to 12 biomes matching MapGenerationFields.tsx;
//                zone counts fixed to flat 4/8/12 for all layouts;
//                AI narrative field restored; Frame navigation shows home only;
//                preview cancel now deletes the temp campaign + storage and returns home;
//                confirm redirects to /lead?campaign=<id> not back to form;
//                campaign ID hidden from preview UI;
//                campaign_narrative passed to generate-map for better OpenAI prompts.
"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";
import { MapImageDisplay } from "@/components/MapImageDisplay";

// ── Types ─────────────────────────────────────────────────────────────────────

type Template    = { id: string; name: string; description: string | null };
type LayoutKey   = "ring" | "continent" | "radial" | "ship_line";
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
                {t.type === "success" && "* "}
                {t.type === "error"   && "X "}
                {t.type === "info"    && "- "}
                {t.title}
              </p>
              {t.body && <p className="mt-1 text-xs text-parchment/60 leading-relaxed">{t.body}</p>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-parchment/30 hover:text-parchment/70 text-lg leading-none mt-0.5 shrink-0">x</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Layout options ────────────────────────────────────────────────────────────

const LAYOUT_OPTIONS: { key: LayoutKey; label: string; icon: string; description: string }[] = [
  {
    key: "ring",
    label: "Halo Ring",
    icon: "O",
    description: "Arc segments of a megastructure ring. Classic halo layout — evenly spaced zones arranged in a circle around a central void.",
  },
  {
    key: "continent",
    label: "Fractured Continent",
    icon: "H",
    description: "A shattered landmass of irregular plate-like regions divided by chasms, lava flows, and collapsed terrain.",
  },
  {
    key: "radial",
    label: "Radial Spokes",
    icon: "+",
    description: "Zones radiating out from a central objective point. Forces conflict at the hub early; outer zones are safer but yield less.",
  },
  {
    key: "ship_line",
    label: "Void Warship",
    icon: ">",
    description: "An ancient warship viewed top-down — compartments arranged bow to stern. Tight corridors and strategic chokepoints.",
  },
];

// ── Zone sizes — flat 4 / 8 / 12 across all layouts ──────────────────────────

const ZONE_SIZES: { key: ZoneSizeKey; label: string; subLabel: string }[] = [
  { key: "small",  label: "Small",  subLabel: "4 zones — fast, brutal campaign" },
  { key: "medium", label: "Medium", subLabel: "8 zones — balanced campaign"      },
  { key: "large",  label: "Large",  subLabel: "12 zones — epic campaign"          },
];

const ZONE_COUNT: Record<ZoneSizeKey, number> = {
  small:  4,
  medium: 8,
  large:  12,
};

// ── Biome options — 12 biomes matching MapGenerationFields.tsx ────────────────

const BIOME_OPTIONS = [
  { value: "gothic_ruins",            label: "Gothic Ruins"             },
  { value: "ash_wastes",              label: "Ash Wastes"               },
  { value: "xenos_forest",            label: "Xenos Forest"             },
  { value: "industrial_manufactorum", label: "Industrial Manufactorum"   },
  { value: "warp_scar",               label: "Warp Scar"                },
  { value: "obsidian_fields",         label: "Obsidian Fields"          },
  { value: "signal_crater",           label: "Signal Crater"            },
  { value: "ghost_harbor",            label: "Ghost Harbor"             },
  { value: "blighted_reach",          label: "Blighted Reach"           },
  { value: "null_fields",             label: "Null Fields"              },
  { value: "iron_sanctum",            label: "Iron Sanctum"             },
  { value: "halo_spire",              label: "Halo Spire"               },
];

// ── Toggle switch component ───────────────────────────────────────────────────

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  labelLeft,
  labelRight,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  labelLeft?: string;
  labelRight?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      {labelLeft && (
        <span className={`text-sm select-none ${!checked ? "text-parchment/80" : "text-parchment/40"}`}>
          {labelLeft}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors duration-200 focus:outline-none disabled:opacity-40 ${
          checked
            ? "bg-brass/50 border-brass/70"
            : "bg-void border-brass/30"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-brass transition-transform duration-200 shadow-sm ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      {labelRight && (
        <span className={`text-sm select-none ${checked ? "text-parchment/80" : "text-parchment/40"}`}>
          {labelRight}
        </span>
      )}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [templates, setTemplates]               = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [selectedRuleset, setSelectedRuleset]   = useState<string>("");
  const [loading, setLoading]                   = useState(true);

  // Form fields
  const [campaignName, setCampaignName]     = useState("");
  const [campaignNarrative, setCampaignNarrative] = useState("");
  const [emails, setEmails]                 = useState("");
  const [selectedLayout, setSelectedLayout] = useState<LayoutKey>("ring");
  const [selectedSize, setSelectedSize]     = useState<ZoneSizeKey>("medium");
  const [mixedBiomes, setMixedBiomes]       = useState(false);
  const [primaryBiome, setPrimaryBiome]     = useState("ash_wastes");
  const [rulesOverrides, setRulesOverrides] = useState({
    economy:     { enabled: true,  catchup: { enabled: true, bonus: 1 } },
    fog:         { enabled: true  },
    instability: { enabled: true  },
    missions:    { enabled: true,  mode: "weighted_random_nip" },
    narrative:   { cp_exchange: { enabled: true } },
  });

  // Wizard state
  const [wizardStep, setWizardStep]               = useState<WizardStep>("configure");
  const [previewCampaignId, setPreviewCampaignId] = useState<string | null>(null);
  const [previewMapId, setPreviewMapId]           = useState<string | null>(null);
  const [creating, setCreating]                   = useState(false);
  const [regenerating, setRegenerating]           = useState(false);
  const [cancelling, setCancelling]               = useState(false);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: ToastType, title: string, body?: string) => {
    const id = ++_toastId;
    setToasts(t => [...t, { id, type, title, body }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);

  // ── Load templates ────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: userResp } = await supabase.auth.getUser();
      if (!userResp.user) return;

      const { data: tpls, error: te } = await supabase
        .from("templates").select("id,name,description").order("created_at", { ascending: false });
      if (te) throw te;
      const tplRows = (tpls ?? []) as Template[];
      setTemplates(tplRows);
      if (!selectedTemplate && tplRows.length) setSelectedTemplate(tplRows[0].id);

      const { data: rs } = await supabase.from("rulesets").select("id,key,name,description")
        .eq("is_active", true).order("created_at", { ascending: false });
      if (!selectedRuleset && rs?.length) setSelectedRuleset(rs[0].id);
    } catch (e: any) {
      addToast("error", "Load failed", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived ───────────────────────────────────────────────────────────────

  const zoneCount    = ZONE_COUNT[selectedSize];
  const isShipLayout = selectedLayout === "ship_line";

  // ── Step 1: Generate preview ──────────────────────────────────────────────

  const generatePreview = async () => {
    if (!selectedTemplate) { addToast("error", "No template", "Ensure the templates table has at least one row."); return; }
    if (!campaignName.trim()) { addToast("error", "Name required", "Enter a campaign name before generating the map."); return; }

    setCreating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { addToast("error", "Session expired", "Refresh and try again."); return; }

      const { data, error } = await supabase.functions.invoke("create-campaign", {
        body: {
          template_id:        selectedTemplate,
          campaign_name:      campaignName.trim(),
          campaign_narrative: campaignNarrative.trim(),
          player_emails:      emails.split(",").map(e => e.trim()).filter(Boolean),
          ruleset_id:         selectedRuleset || null,
          rules_overrides:    rulesOverrides,
          layout:             selectedLayout,
          zone_count:         zoneCount,
          biome:              primaryBiome,
          mixed_biomes:       mixedBiomes,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) {
        try { console.error("fn body:", await (error as any).context?.text()); } catch { /* ignore */ }
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
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Session expired");

      const { data, error } = await supabase.functions.invoke("generate-map", {
        body: {
          map_id:             previewMapId,
          campaign_id:        previewCampaignId,
          layout:             selectedLayout,
          zone_count:         zoneCount,
          biome:              primaryBiome,
          mixed_biomes:       mixedBiomes,
          campaign_name:      campaignName.trim(),
          campaign_narrative: campaignNarrative.trim(),
          art_version:        "grimdark-v2",
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Regenerate failed");
      addToast("info", "Regenerating", "A new warzone is being forged. Allow 20-30 seconds.");
    } catch (e: any) {
      addToast("error", "Regenerate failed", e?.message ?? String(e));
    } finally {
      setRegenerating(false);
    }
  };

  // ── Cancel preview — delete campaign + storage, return home ──────────────

  const cancelPreview = async () => {
    if (!previewCampaignId) {
      setWizardStep("configure");
      window.location.href = "/";
      return;
    }
    setCancelling(true);
    try {
      // Delete storage file (best-effort — may fail due to RLS, which is fine)
      if (previewMapId) {
        await supabase.storage
          .from("campaign-maps")
          .remove([`${previewCampaignId}/maps/${previewMapId}/bg.png`]);
      }
      // Delete campaign record (cascades to maps table)
      await supabase.from("campaigns").delete().eq("id", previewCampaignId);
    } catch {
      // Non-fatal — navigate home regardless
    } finally {
      setCancelling(false);
    }
    window.location.href = "/";
  };

  // ── Confirm campaign — redirect to lead controls ──────────────────────────

  const confirmCampaign = () => {
    if (previewCampaignId) {
      window.location.href = `/lead?campaign=${previewCampaignId}`;
    }
  };

  const currentLayout = LAYOUT_OPTIONS.find(l => l.key === selectedLayout)!;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame
      title="Create Campaign"
      currentPage="campaigns"
    >
      <div className="space-y-6">

        {/* ══ STEP 1: Configure ═══════════════════════════════════════════ */}
        {wizardStep === "configure" && (
          <>
            {/* Back to home link */}
            <div className="flex items-center justify-between">
              <a
                href="/"
                className="text-xs text-parchment/40 hover:text-parchment/70 transition-colors flex items-center gap-1.5"
              >
                &larr; Back to Home
              </a>
            </div>

            <Card title="Create Campaign">
              <div className="space-y-6">

                {/* ── 1. Campaign Scale — first ── */}
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
                          <span className={`text-xs leading-tight text-center ${sel ? "text-brass/70" : "text-parchment/40"}`}>
                            {sz.subLabel}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-xs text-parchment/40">
                    {zoneCount} {isShipLayout ? "compartments" : "zones"} for this configuration
                  </p>
                </div>

                {/* ── 2. Map Layout ── */}
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
                          <span className={`text-2xl leading-none font-mono ${sel ? "text-brass" : "text-parchment/40"}`}>
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

                {/* ── 3. Terrain Biome — only for non-ship layouts ── */}
                {!isShipLayout && (
                  <div>
                    <p className="text-sm text-parchment/70 mb-2">Terrain Biome</p>

                    {/* Toggle: Single Biome / Mixed Biomes */}
                    <div className="mb-3">
                      <ToggleSwitch
                        checked={mixedBiomes}
                        onChange={setMixedBiomes}
                        disabled={loading || creating}
                        labelLeft="Single Biome"
                        labelRight="Mixed Biomes"
                      />
                      <p className="mt-1.5 text-xs text-parchment/35 leading-relaxed">
                        {mixedBiomes
                          ? "Each zone will receive a different terrain type — more varied visual output."
                          : "All zones share a single terrain type — cohesive visual theme."}
                      </p>
                    </div>

                    {/* Biome dropdown — only shown in single-biome mode */}
                    {!mixedBiomes && (
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
                    )}
                  </div>
                )}

                {/* ── 4. Campaign name ── */}
                <div>
                  <p className="text-sm text-parchment/70 mb-1">Campaign Name</p>
                  <input
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    placeholder="e.g. Embers of the Shattered Halo (Season 1)"
                    disabled={loading || creating}
                  />
                </div>

                {/* ── 5. Campaign Narrative (feeds into AI image generation) ── */}
                <div>
                  <p className="text-sm text-parchment/70 mb-1">Campaign Narrative</p>
                  <p className="text-xs text-parchment/40 mb-2 leading-relaxed">
                    Describe the setting, factions, and tone. This context is used to generate your campaign map image — more detail produces more thematic results.
                  </p>
                  <textarea
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm resize-none leading-relaxed"
                    value={campaignNarrative}
                    onChange={(e) => setCampaignNarrative(e.target.value)}
                    placeholder="e.g. Three warbands converge on the remnants of a shattered halo ring — the Ashen King stirs beneath the Obsidian Fields, Chaos corruption bleeds into the manufactorum districts, and a loyalist Iron Hands company races to secure the Halo Spire before the warp tears it apart..."
                    rows={4}
                    disabled={loading || creating}
                  />
                </div>

                {/* ── 6. Optional rules ── */}
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

                {/* ── 7. Invite emails ── */}
                <div>
                  <p className="text-sm text-parchment/70 mb-1">Invite Emails (optional, comma-separated)</p>
                  <input
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60"
                    value={emails}
                    onChange={(e) => setEmails(e.target.value)}
                    placeholder="commander@warzone.com, sergeant@forge.world"
                    disabled={loading || creating}
                  />
                  <p className="mt-1 text-xs text-parchment/40">
                    Players auto-join when they sign in. More invites available from Lead Controls.
                  </p>
                </div>

                {/* ── Generate button ── */}
                <button
                  className="w-full px-4 py-3 rounded bg-brass/20 border border-brass/50 hover:bg-brass/30 text-brass font-semibold tracking-wider uppercase text-sm transition-colors disabled:opacity-40"
                  onClick={generatePreview}
                  disabled={creating || loading || !templates.length}
                >
                  {creating ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                      Forging campaign...
                    </span>
                  ) : "Generate Map Preview"}
                </button>

                {!loading && !templates.length && (
                  <p className="text-xs text-blood/80 text-center">
                    No templates found — campaign creation is disabled.
                  </p>
                )}
              </div>
            </Card>
          </>
        )}

        {/* ══ STEP 2: Map Preview ══════════════════════════════════════════ */}
        {wizardStep === "previewing" && previewCampaignId && (
          <Card title="Map Preview — Review Your Warzone">
            <div className="space-y-4">
              <div>
                <p className="text-sm text-parchment/60 leading-relaxed">
                  Your warzone is being rendered by the Adeptus Mechanicus. Regenerate until satisfied,
                  then confirm to take command.
                </p>
                <p className="mt-1 text-xs text-parchment/35 leading-relaxed">
                  Layout: <span className="font-mono text-brass/60 uppercase">{selectedLayout}</span>
                  &nbsp;&middot;&nbsp;
                  Scale: <span className="font-mono text-brass/60 uppercase">{selectedSize}</span>
                  &nbsp;&middot;&nbsp;
                  {zoneCount} {isShipLayout ? "compartments" : "zones"}
                  {!isShipLayout && !mixedBiomes && (
                    <>&nbsp;&middot;&nbsp;{BIOME_OPTIONS.find(b => b.value === primaryBiome)?.label}</>
                  )}
                  {!isShipLayout && mixedBiomes && <>&nbsp;&middot;&nbsp;Mixed biomes</>}
                </p>
              </div>

              {previewMapId ? (
                <MapImageDisplay
                  mapId={previewMapId}
                  campaignId={previewCampaignId}
                  isLead={true}
                  className="rounded"
                />
              ) : (
                <div className="flex items-center justify-center h-32 text-parchment/40 text-sm animate-pulse">
                  Awaiting map generation...
                </div>
              )}

              {/* Action buttons */}
              <div className="grid grid-cols-3 gap-3 pt-1">
                {/* Cancel — deletes the campaign and returns home */}
                <button
                  onClick={cancelPreview}
                  disabled={cancelling}
                  className="px-4 py-2.5 rounded border border-blood/30 bg-blood/5 hover:bg-blood/15 text-blood/80 hover:text-blood text-sm transition-colors disabled:opacity-40"
                >
                  {cancelling ? (
                    <span className="flex items-center justify-center gap-1.5">
                      <span className="w-3.5 h-3.5 border-2 border-blood/30 border-t-blood rounded-full animate-spin" />
                      Cancelling...
                    </span>
                  ) : "Cancel"}
                </button>

                {/* Regenerate */}
                <button
                  onClick={regenerateMap}
                  disabled={regenerating}
                  className="px-4 py-2.5 rounded border border-brass/40 bg-void hover:bg-brass/10 text-brass text-sm font-semibold transition-colors disabled:opacity-40"
                >
                  {regenerating ? (
                    <span className="flex items-center justify-center gap-1.5">
                      <span className="w-3.5 h-3.5 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                      Regenerating...
                    </span>
                  ) : "Regenerate Map"}
                </button>

                {/* Confirm — redirects to /lead */}
                <button
                  onClick={confirmCampaign}
                  className="px-4 py-2.5 rounded bg-brass/25 border border-brass/60 hover:bg-brass/40 text-brass font-bold text-sm uppercase tracking-wider transition-colors"
                >
                  Confirm Campaign
                </button>
              </div>

              <p className="text-xs text-parchment/25 text-center italic">
                Cancelling will permanently delete this campaign and its map artwork.
              </p>
            </div>
          </Card>
        )}

      </div>

      <ToastContainer toasts={toasts} dismiss={dismissToast} />
    </Frame>
  );
}
