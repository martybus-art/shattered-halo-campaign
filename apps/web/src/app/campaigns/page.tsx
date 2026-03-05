"use client";
// apps/web/src/app/campaigns/page.tsx
// Create Campaign -- form only. Map generation happens from the lead page
// after the campaign is created. Fill in form, generate narrative, create
// campaign, redirect to /lead for map generation.
//
// changelog:
//   2026-03-03 -- Initial implementation with AI narrative generator.
//   2026-03-04 -- Removed map preview step; create campaign redirects directly
//                 to /lead?campaign=xxx. Map params saved in rules_overrides
//                 for the lead page generate-map modal to use.
//   2026-03-04 -- Cancel redirects to / (home page).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// -- Types ------------------------------------------------------------------

type Template    = { id: string; name: string; description: string | null };
type LayoutKey   = "ring" | "continent" | "radial" | "ship_line";
type ZoneSizeKey = "small" | "medium" | "large";

// -- Toast ------------------------------------------------------------------

type ToastType = "success" | "error" | "info";
interface Toast { id: number; type: ToastType; title: string; body?: string }
let _toastId = 0;

function ToastContainer({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto rounded border px-4 py-3 shadow-2xl shadow-black/60 backdrop-blur-sm
            ${t.type === "success" ? "bg-void border-brass/60" : ""}
            ${t.type === "error"   ? "bg-void border-blood/60" : ""}
            ${t.type === "info"    ? "bg-void border-brass/30" : ""}
          `}>
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

// -- Layout options ---------------------------------------------------------

const LAYOUT_OPTIONS: { key: LayoutKey; label: string; icon: string; description: string }[] = [
  {
    key: "ring",
    label: "Halo Ring",
    icon: "O",
    description: "Arc segments of a megastructure ring. Classic halo layout -- evenly spaced zones arranged in a circle around a central void.",
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
    description: "An ancient warship viewed top-down -- compartments arranged bow to stern. Tight corridors and strategic chokepoints. Maximum 10 players.",
  },
];

// -- Zone sizes -------------------------------------------------------------

const ZONE_SIZES: { key: ZoneSizeKey; label: string; subLabel: string }[] = [
  { key: "small",  label: "Small",  subLabel: "4 zones -- fast, brutal campaign"  },
  { key: "medium", label: "Medium", subLabel: "8 zones -- balanced campaign"       },
  { key: "large",  label: "Large",  subLabel: "12 zones -- epic campaign"           },
];

const BASE_ZONE_COUNT: Record<ZoneSizeKey, number> = { small: 4, medium: 8, large: 12 };

function getZoneCount(layout: LayoutKey, size: ZoneSizeKey): number {
  const base = BASE_ZONE_COUNT[size];
  if (layout === "ship_line") return Math.min(base, 10);
  return base;
}

// -- Biome options ----------------------------------------------------------

const BIOME_OPTIONS = [
  { value: "gothic_ruins",            label: "Gothic Ruins"            },
  { value: "ash_wastes",              label: "Ash Wastes"              },
  { value: "xenos_forest",            label: "Xenos Forest"            },
  { value: "industrial_manufactorum", label: "Industrial Manufactorum"  },
  { value: "warp_scar",               label: "Warp Scar"               },
  { value: "obsidian_fields",         label: "Obsidian Fields"         },
  { value: "signal_crater",           label: "Signal Crater"           },
  { value: "ghost_harbor",            label: "Ghost Harbor"            },
  { value: "blighted_reach",          label: "Blighted Reach"          },
  { value: "null_fields",             label: "Null Fields"             },
  { value: "iron_sanctum",            label: "Iron Sanctum"            },
  { value: "halo_spire",              label: "Halo Spire"              },
];

// -- Zone names per biome (12 each, used for AI narrative prompt) -----------

const ZONE_NAMES_BY_BIOME: Record<string, string[]> = {
  gothic_ruins:            ["Shattered Nave", "The Ossuary Vaults", "Collapsed Bell Tower", "Iron Reliquary", "The Penitent Quarter", "Archway of Screams", "The Burning Transept", "Catacombs Below", "The Blessed Ruin", "Sanctum of Dust", "The Fallen Spire", "Gate of the Damned"],
  ash_wastes:              ["Cinder Flats", "The Smouldering Reach", "Ashen Maw", "Dust Shelf Primus", "Toxic Plume Ridge", "The Grey Expanse", "Slag Heap Delta", "Ember Dunes", "Acid Rain Basin", "Soot Columns", "The Choking Fields", "Ruin of Hive Tertius"],
  xenos_forest:            ["The Amber Canopy", "Bioluminescent Hollow", "Spore Cloud Thicket", "The Grasping Root-Web", "Glowing Mire", "Xenos Nest Site Alpha", "Pheromone Ridge", "The Sap Rivers", "Hive-Organism Scar", "Crystal Fungus Grove", "Alien Spawning Pools", "The Deep Verdance"],
  industrial_manufactorum: ["Forge Deck Alpha", "Smelting Basin", "Conveyor Line Seven", "The Cooling Towers", "Cogitator Hive", "Plasma Conduit Junction", "Iron Foundry", "The Slag Yards", "Machine Spirit Shrine", "Manufactory Floor Sigma", "Promethium Storage", "The Great Press"],
  warp_scar:               ["The First Tear", "Daemon Bridge", "Reality Inversion Point", "Screaming Void Rift", "Corruption Epicentre", "The Bleeding Ground", "Warp-Crystal Formation", "Inverted Spire", "The Maddening Corridor", "Chaos Incursion Site", "Eye of the Wound", "Abyssal Threshold"],
  obsidian_fields:         ["The Mirror Plain", "Black Glass Plateau", "Obsidian Razor Ridge", "The Shard Forest", "Volcanic Vent Cluster", "Geode Caverns", "Reflective Salt Flats", "The Glass Labyrinth", "Magma Blister Fields", "Obsidian Spire", "The Black Shore", "Vitrified Ruins"],
  signal_crater:           ["Impact Zone Alpha", "The Antenna Array", "Anomaly Site Seven", "Signal Processing Core", "The Crater Lip", "Debris Field Omega", "Interference Zone", "The Transmission Bunker", "Electromagnetic Null Zone", "Seismic Fracture Line", "The Buried Signal", "Crater Lake Secundus"],
  ghost_harbor:            ["The Sunken Fleet", "Fog Bank Crossing", "Rusted Iron Docks", "The Drowned Quarter", "Silted Shipping Lane", "Spectral Lighthouse", "Hab-Block Ruins", "The Black Water", "Tidal Surge Basin", "Wreck of the Iron Faith", "The Murky Shallows", "Harbor Gate Ruins"],
  blighted_reach:          ["Nurgle's Garden", "The Plague Pools", "Rotting Arbour", "Infected Hive Sump", "Bloat Fly Nesting Ground", "The Festering Mire", "Corruption Bloom", "Diseased Hab Ring", "The Pox Fields", "Bile River Delta", "Blighted Croplands", "Gangrene Reach"],
  null_fields:             ["The Dead Plain", "Null Obelisk Field", "Iron Monolith Circle", "The Silent Reach", "Psychic Void Zone", "Blank Expanse Alpha", "The Oppression Fields", "Emptied Hab Ruins", "Anti-Warp Boundary", "The Soulless Ground", "Null Shrine", "The Featureless Dark"],
  iron_sanctum:            ["The Outer Ramparts", "Gate House Alpha", "The Inner Courtyard", "Siege Artillery Mount", "The Barracks", "Trophy Hall", "Armoury Vault", "The Great Keep", "Chapel of the Skull", "The Undercroft", "Outer Gatehouse", "The Command Bastion"],
  halo_spire:              ["The Viewing Gallery", "Cogitator Pylon Array", "Void-Glass Walkway", "The Spire Summit", "Gravitational Lock Chamber", "Ancient Data-Core", "The Crystalline Shaft", "Service Conduit Level", "The Observation Deck", "Long Range Sensor Array", "Power Relay Hub", "The Outer Spire"],
};

// -- Void warship compartments (10 max) ------------------------------------

const VOID_WARSHIP_COMPARTMENTS = [
  "Gothic Superstructure", "Adamantium-Reinforced Prow", "Torpedo Tubes", "Launch Bays",
  "Macro-Cannon Decks", "Lance Batteries", "Void Shield Generators", "Nova Cannon",
  "Warp Drive", "Plasma Reactors",
];

// -- Helpers ----------------------------------------------------------------

const LAYOUT_LABELS: Record<LayoutKey, string> = {
  ring:      "Halo Ring megastructure",
  continent: "Fractured Continent",
  radial:    "Radial Spoke warzone",
  ship_line: "Void Warship",
};

function getZoneNamesForPrompt(layout: LayoutKey, biome: string, count: number): string[] {
  if (layout === "ship_line") return VOID_WARSHIP_COMPARTMENTS.slice(0, count);
  const names = ZONE_NAMES_BY_BIOME[biome] ?? ZONE_NAMES_BY_BIOME["ash_wastes"];
  return names.slice(0, count);
}

// -- Toggle switch ----------------------------------------------------------

function ToggleSwitch({
  checked, onChange, disabled, labelLeft, labelRight,
}: {
  checked: boolean; onChange: (v: boolean) => void;
  disabled?: boolean; labelLeft?: string; labelRight?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      {labelLeft && (
        <span className={`text-sm select-none ${!checked ? "text-parchment/80" : "text-parchment/40"}`}>
          {labelLeft}
        </span>
      )}
      <button
        type="button" role="switch" aria-checked={checked} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors duration-200 focus:outline-none disabled:opacity-40 ${
          checked ? "bg-brass/50 border-brass/70" : "bg-void border-brass/30"
        }`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-brass transition-transform duration-200 shadow-sm ${
          checked ? "translate-x-6" : "translate-x-1"
        }`} />
      </button>
      {labelRight && (
        <span className={`text-sm select-none ${checked ? "text-parchment/80" : "text-parchment/40"}`}>
          {labelRight}
        </span>
      )}
    </div>
  );
}

// -- Component --------------------------------------------------------------

export default function CampaignsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [templates, setTemplates]               = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [selectedRuleset, setSelectedRuleset]   = useState<string>("");
  const [loading, setLoading]                   = useState(true);

  // Form fields
  const [campaignName, setCampaignName]           = useState("");
  const [campaignNarrative, setCampaignNarrative] = useState("");
  const [emails, setEmails]                       = useState("");
  const [selectedLayout, setSelectedLayout]       = useState<LayoutKey>("ring");
  const [selectedSize, setSelectedSize]           = useState<ZoneSizeKey>("medium");
  const [mixedBiomes, setMixedBiomes]             = useState(false);
  const [primaryBiome, setPrimaryBiome]           = useState("ash_wastes");
  const [rulesOverrides, setRulesOverrides]       = useState({
    economy:     { enabled: true,  catchup: { enabled: true, bonus: 1 } },
    fog:         { enabled: true  },
    instability: { enabled: true  },
    missions:    { enabled: true,  mode: "weighted_random_nip" },
    narrative:   { cp_exchange: { enabled: true } },
  });

  const [generatingNarrative, setGeneratingNarrative] = useState(false);
  const [creating, setCreating]                       = useState(false);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: ToastType, title: string, body?: string) => {
    const id = ++_toastId;
    setToasts(t => [...t, { id, type, title, body }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);

  // -- Derived ---------------------------------------------------------------

  const isShipLayout  = selectedLayout === "ship_line";
  const zoneCount     = getZoneCount(selectedLayout, selectedSize);
  const currentLayout = LAYOUT_OPTIONS.find(l => l.key === selectedLayout)!;

  // -- Load ------------------------------------------------------------------

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

  // -- AI Narrative Generator ------------------------------------------------

  const generateNarrative = async () => {
    setGeneratingNarrative(true);
    setCampaignNarrative("");

    const zoneNames = getZoneNamesForPrompt(selectedLayout, primaryBiome, zoneCount);
    const layoutLabel = LAYOUT_LABELS[selectedLayout];
    const biomeLabel = BIOME_OPTIONS.find(b => b.value === primaryBiome)?.label ?? primaryBiome;
    const terrainDescription = isShipLayout
      ? "a colossal void warship lost to the ages"
      : mixedBiomes
        ? "a world of mixed and varied terrain types"
        : `a world dominated by ${biomeLabel} terrain`;

    const prompt = [
      `Please create a short campaign narrative paragraph (100-150 words) for a Warhammer 40,000 skirmish campaign.`,
      ``,
      `The campaign setting is a ${layoutLabel} that has just been rediscovered by multiple Warhammer 40K factions after being lost to time for millennia.`,
      `The terrain is ${terrainDescription}.`,
      `The campaign is ${selectedSize} scale with ${zoneCount} ${isShipLayout ? "compartments" : "zones"}.`,
      ``,
      `The ${isShipLayout ? "compartments" : "locations"} players will fight over are:`,
      zoneNames.map((n, i) => `${i + 1}. ${n}`).join("\n"),
      ``,
      `The narrative should:`,
      `- Capture the grimdark Warhammer 40K tone`,
      `- Explain why this ${isShipLayout ? "vessel" : "location"} was lost and why it matters now`,
      `- Reference several of the specific location names above`,
      `- Leave room for multiple factions to have conflicting reasons to fight here`,
      `- Be written as flavour text, not instructions`,
      ``,
      `Output only the narrative paragraph, no title or preamble.`,
    ].join("\n");

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Session expired -- please refresh.");

      const { data, error } = await supabase.functions.invoke("generate-narrative", {
        body: { prompt },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "No narrative returned");
      setCampaignNarrative(data.text ?? "");
    } catch (e: any) {
      addToast("error", "Narrative generation failed", e?.message ?? String(e));
    } finally {
      setGeneratingNarrative(false);
    }
  };

  // -- Create Campaign -------------------------------------------------------
  // Creates the campaign record with map params saved in rules_overrides,
  // then redirects to /lead?campaign=xxx where the user can generate the map.

  const createCampaign = async () => {
    if (!selectedTemplate) { addToast("error", "No template", "Ensure the templates table has at least one row."); return; }
    if (!campaignName.trim()) { addToast("error", "Name required", "Enter a campaign name before creating."); return; }

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

      // Redirect to lead page -- map generation happens there
      window.location.href = `/lead?campaign=${data.campaign_id}`;

    } catch (e: any) {
      addToast("error", "Creation failed", e?.message ?? String(e));
      setCreating(false);
    }
  };

  // -- Render ----------------------------------------------------------------

  return (
    <Frame title="Create Campaign" currentPage="campaigns">
      <div className="space-y-6">

        <div className="flex items-center justify-between">
          <a href="/" className="text-xs text-parchment/40 hover:text-parchment/70 transition-colors">
            &larr; Back to Home
          </a>
        </div>

        <Card title="Create Campaign">
          <div className="space-y-6">

            {/* -- 1. Campaign Scale -- */}
            <div>
              <p className="text-sm text-parchment/70 mb-1.5">Campaign Scale</p>
              <div className="grid grid-cols-3 gap-2">
                {ZONE_SIZES.map((sz) => {
                  const sel = selectedSize === sz.key;
                  const count = getZoneCount(selectedLayout, sz.key);
                  return (
                    <button key={sz.key} onClick={() => setSelectedSize(sz.key)}
                      disabled={loading || creating}
                      className={`flex flex-col items-center gap-0.5 px-3 py-3 rounded border transition-colors disabled:opacity-40
                        ${sel ? "border-brass bg-brass/15" : "border-brass/25 bg-void hover:border-brass/40 hover:bg-brass/5"}`}
                    >
                      <span className={`text-sm font-bold uppercase tracking-wider ${sel ? "text-brass" : "text-parchment/60"}`}>
                        {sz.label}
                      </span>
                      <span className={`text-xs leading-tight text-center ${sel ? "text-brass/70" : "text-parchment/40"}`}>
                        {count} {isShipLayout ? "compartments" : "zones"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-parchment/35">
                {zoneCount} {isShipLayout ? "compartments" : "zones"} for this configuration
                {isShipLayout && selectedSize === "large" && (
                  <span className="text-blood/60"> -- void warship maximum</span>
                )}
              </p>
            </div>

            {/* -- 2. Map Layout -- */}
            <div>
              <p className="text-sm text-parchment/70 mb-2">Map Layout</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {LAYOUT_OPTIONS.map((opt) => {
                  const sel = selectedLayout === opt.key;
                  return (
                    <button key={opt.key} onClick={() => setSelectedLayout(opt.key)}
                      disabled={loading || creating}
                      className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded border transition-colors text-center disabled:opacity-40
                        ${sel ? "border-brass bg-brass/15 text-brass" : "border-brass/25 bg-void hover:border-brass/50 hover:bg-brass/5 text-parchment/60 hover:text-parchment/90"}`}
                    >
                      <span className={`text-2xl leading-none font-mono ${sel ? "text-brass" : "text-parchment/40"}`}>{opt.icon}</span>
                      <span className="text-xs font-semibold uppercase tracking-wider leading-tight">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-parchment/50 italic leading-relaxed">{currentLayout.description}</p>
            </div>

            {/* -- 3. Terrain Biome (non-ship only) -- */}
            {!isShipLayout && (
              <div>
                <p className="text-sm text-parchment/70 mb-2">Terrain Biome</p>
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
                      ? "Each zone will receive a different terrain type."
                      : "All zones share a single terrain type -- cohesive visual theme."}
                  </p>
                </div>
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

            {/* -- 4. Campaign Name -- */}
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

            {/* -- 5. Campaign Narrative + AI generator -- */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm text-parchment/70">Campaign Narrative</p>
                <button
                  onClick={generateNarrative}
                  disabled={generatingNarrative || creating || loading}
                  className="flex items-center gap-1.5 px-3 py-1 rounded border border-brass/30 bg-brass/10 hover:bg-brass/20 text-xs text-brass disabled:opacity-40 transition-colors"
                >
                  {generatingNarrative ? (
                    <>
                      <span className="w-3 h-3 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>&#10022; Generate with AI</>
                  )}
                </button>
              </div>
              <p className="text-xs text-parchment/40 mb-2 leading-relaxed">
                Describe the setting, factions, and tone -- or use the AI generator above.
                This narrative feeds into the AI map image generation on the lead page.
              </p>
              <textarea
                className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm resize-none leading-relaxed"
                value={campaignNarrative}
                onChange={(e) => setCampaignNarrative(e.target.value)}
                placeholder={
                  isShipLayout
                    ? "e.g. The ancient void warship Implacable Wrath drifts cold and silent through the Ghoul Stars..."
                    : "e.g. Three warbands converge on the remnants of a shattered halo ring..."
                }
                rows={5}
                disabled={loading || creating}
              />
              {/* Zone names preview */}
              {campaignNarrative && (
                <div className="mt-2">
                  <p className="text-xs text-parchment/35 mb-1.5">
                    {isShipLayout ? "Compartments" : "Locations"} ({zoneCount}):
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {getZoneNamesForPrompt(selectedLayout, primaryBiome, zoneCount).map((name, i) => (
                      <span key={i} className="px-2 py-0.5 rounded bg-brass/10 border border-brass/20 text-xs text-brass/70">
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* -- 6. Rules configuration -- */}
            <div>
              <p className="text-sm text-parchment/70 mb-2">Rules Configuration</p>
              <div className="space-y-2.5 text-parchment/70">
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

            {/* -- 7. Invite emails -- */}
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

            {/* -- Create Campaign button -- */}
            <button
              className="w-full px-4 py-3 rounded bg-brass/20 border border-brass/50 hover:bg-brass/30 text-brass font-semibold tracking-wider uppercase text-sm transition-colors disabled:opacity-40"
              onClick={createCampaign}
              disabled={creating || loading || !templates.length}
            >
              {creating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                  Creating campaign...
                </span>
              ) : "Create Campaign"}
            </button>

            {!loading && !templates.length && (
              <p className="text-xs text-blood/80 text-center">No templates found -- campaign creation is disabled.</p>
            )}

          </div>
        </Card>

      </div>

      <ToastContainer toasts={toasts} dismiss={dismissToast} />
    </Frame>
  );
}
