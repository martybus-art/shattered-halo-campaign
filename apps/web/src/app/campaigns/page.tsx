"use client";
// apps/web/src/app/campaigns/page.tsx
// Create Campaign -- form only. Map generation happens from the lead page
// after the campaign is created. Fill in form, generate narrative, create
// campaign, redirect to /lead for map generation.
//
// changelog:
//   2026-03-07 -- Added economy sub-settings panel (income tiers, NIP decay,
//                 underdog bonus). These map 1:1 to distribute-income edge
//                 function constants and are stored in rules_overrides JSONB.
//                 Panel is collapsible and only visible when Economy is enabled.
//   2026-03-03 -- Initial implementation with AI narrative generator.
//   2026-03-04 -- Removed map preview step; create campaign redirects directly
//                 to /lead?campaign=xxx. Map params saved in rules_overrides
//                 for the lead page generate-map modal to use.
//   2026-03-04 -- Cancel redirects to / (home page).
//   2026-03-06 -- After create-campaign succeeds, call invite-players edge
//                 function to actually send emails. Previously only pending_invites
//                 rows were inserted; no emails were dispatched.
//   2026-03-06 -- Replaced profiles table query (table does not exist) with
//                 invite-players list_users edge function call. Same data shape.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { setCampaignSession } from "@/lib/campaignSession";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";
import { PLANET_ZONE_NAMES, SHIP_ZONE_NAMES } from "@/lib/zoneNames";

// -- Types ------------------------------------------------------------------

type Template    = { id: string; name: string; description: string | null };
type ExistingPlayer = { id: string; email: string; display_name: string | null };
type LayoutKey   = "ring" | "continent" | "spoke" | "void_ship";
type ZoneSizeKey = "small" | "medium" | "large";

// -- Toast ------------------------------------------------------------------

type ToastType = "success" | "error" | "info";
interface Toast { id: number; type: ToastType; title: string; body?: string }
let _toastId = 0;

function ToastContainer({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed top-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none">
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
    key: "spoke",
    label: "Radial Spokes",
    icon: "+",
    description: "Zones radiating out from a central objective point. Forces conflict at the hub early; outer zones are safer but yield less.",
  },
  {
    key: "void_ship",
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
  if (layout === "void_ship") return Math.min(base, 10);
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

// -- Helpers ----------------------------------------------------------------

const LAYOUT_LABELS: Record<LayoutKey, string> = {
  ring:      "Halo Ring megastructure",
  continent: "Fractured Continent",
  spoke:     "Radial Spoke warzone",
  void_ship: "Void Warship",
};

function getZoneNamesForPrompt(layout: LayoutKey, count: number): string[] {
  const pool = layout === "void_ship"
    ? SHIP_ZONE_NAMES
    : PLANET_ZONE_NAMES;
  return pool.slice(0, count);
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


function RuleToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-brass/15 bg-black/20 px-3 py-3">
      <div className="min-w-0">
        <p className="text-sm text-parchment/80">{label}</p>
        {description && (
          <p className="mt-1 text-xs text-parchment/40 leading-relaxed">{description}</p>
        )}
      </div>
      <div className="shrink-0 pt-0.5">
        <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} />
      </div>
    </div>
  );
}

// -- Economy sub-settings panel --------------------------------------------
// Collapsible panel shown under the Economy toggle when economy is enabled.
// These values feed directly into the distribute-income edge function which
// reads them from campaign.rules_overrides at runtime.

function EconomySubPanel({
  economy,
  onChange,
  disabled,
}: {
  economy: {
    income_tier_1?: number; income_tier_2?: number;
    income_tier_3?: number; income_tier_4?: number;
    decay_threshold?: number; decay_percent?: number;
    underdog_bonus?: number;
  };
  onChange: (patch: Partial<typeof economy>) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  const num = (val: number | undefined, fallback: number) =>
    val !== undefined ? val : fallback;

  const field = (
    label: string,
    hint: string,
    key: keyof typeof economy,
    fallback: number,
    min = 0,
    max = 99,
  ) => (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs text-parchment/70">{label}</p>
        <p className="text-xs text-parchment/35 leading-tight">{hint}</p>
      </div>
      <input
        type="number" min={min} max={max} step={1}
        value={num(economy[key] as number | undefined, fallback)}
        onChange={(e) => onChange({ [key]: Math.max(min, parseInt(e.target.value) || fallback) })}
        disabled={disabled}
        className="w-16 px-2 py-1 rounded bg-void border border-brass/25 text-sm text-center text-parchment/80 focus:outline-none focus:border-brass/50 disabled:opacity-40"
      />
    </div>
  );

  return (
    <div className="rounded-lg border border-brass/15 bg-black/10 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={disabled}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-xs text-parchment/50 uppercase tracking-widest">
          Economy Settings
        </span>
        <span className="text-xs text-brass/60">{open ? "▲ Hide" : "▼ Show"}</span>
      </button>

      {open && (
        <div className="border-t border-brass/10 px-3 py-3 space-y-4">

          {/* Income Tiers */}
          <div className="space-y-2">
            <p className="text-xs text-parchment/45 uppercase tracking-widest">
              Income Tiers (NIP per round)
            </p>
            {field("1–3 Sectors",  "+NIP for holding 1–3 sectors",  "income_tier_1", 2, 0, 20)}
            {field("4–6 Sectors",  "+NIP for holding 4–6 sectors",  "income_tier_2", 3, 0, 20)}
            {field("7–9 Sectors",  "+NIP for holding 7–9 sectors",  "income_tier_3", 4, 0, 20)}
            {field("10+ Sectors",  "+NIP cap — prevents snowball",  "income_tier_4", 5, 0, 20)}
          </div>

          {/* Underdog Bonus */}
          <div className="space-y-2">
            <p className="text-xs text-parchment/45 uppercase tracking-widest">
              Underdog Bonus
            </p>
            {field("Underdog Bonus", "Extra NIP for the player with the fewest sectors", "underdog_bonus", 1, 0, 10)}
          </div>

          {/* NIP Decay */}
          <div className="space-y-2">
            <p className="text-xs text-parchment/45 uppercase tracking-widest">
              NIP Decay (hoarding penalty)
            </p>
            {field("Decay Threshold", "Unspent NIP above this amount decays", "decay_threshold", 10, 1, 50)}
            {field("Decay %",         "% of excess NIP lost per round (rounded down)", "decay_percent", 10, 0, 100)}
          </div>

          <p className="text-xs text-parchment/25 leading-relaxed italic pt-1 border-t border-brass/10">
            Decay example: 12 NIP with threshold 10 → 2 excess → 10% of 2 = 0 NIP lost (rounds down).
            At threshold 10, decay only bites meaningfully when NIP exceeds ~20.
          </p>
        </div>
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
  const [existingPlayers, setExistingPlayers]     = useState<ExistingPlayer[]>([]);
  const [playerPickerOpen, setPlayerPickerOpen]   = useState(false);
  const [selectedLayout, setSelectedLayout]       = useState<LayoutKey>("ring");
  const [selectedSize, setSelectedSize]           = useState<ZoneSizeKey>("medium");
  const [mixedBiomes, setMixedBiomes]             = useState(false);
  const [primaryBiome, setPrimaryBiome]           = useState("ash_wastes");
  const [rulesOverrides, setRulesOverrides]       = useState({
    economy: {
      enabled:         true,
      catchup:         { enabled: true, bonus: 1 },
      // Income tiers: NIP granted per bracket of sectors held
      income_tier_1:   2,   // 1–3 sectors
      income_tier_2:   3,   // 4–6 sectors
      income_tier_3:   4,   // 7–9 sectors
      income_tier_4:   5,   // 10+ sectors (cap)
      // NIP decay: discourages hoarding
      decay_threshold: 10,  // unspent NIP above this threshold decays
      decay_percent:   10,  // % of excess NIP lost per round (rounded down)
      // Underdog bonus applied by distribute-income automatically
      underdog_bonus:  1,
    },
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

  const isShipLayout  = selectedLayout === "void_ship";
  const zoneCount     = getZoneCount(selectedLayout, selectedSize);
  const currentLayout = LAYOUT_OPTIONS.find(l => l.key === selectedLayout)!;
  const selectedInviteEmails = useMemo(
    () => emails.split(",").map(e => e.trim()).filter(Boolean),
    [emails]
  );
  const selectedInviteEmailSet = useMemo(
    () => new Set(selectedInviteEmails.map(e => e.toLowerCase())),
    [selectedInviteEmails]
  );

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

      // Load registered users for the player picker via edge function
      // (profiles table does not exist -- auth user list is the source of truth)
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          const { data: usersResp } = await supabase.functions.invoke("invite-players", {
            body: { mode: "list_users" },
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (usersResp?.ok && Array.isArray(usersResp.users)) {
            setExistingPlayers(usersResp.users as ExistingPlayer[]);
          } else {
            setExistingPlayers([]);
          }
        }
      } catch {
        setExistingPlayers([]);
      }
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

    const zoneNames = getZoneNamesForPrompt(selectedLayout, zoneCount);
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


  const toggleExistingPlayerEmail = (email: string, checked: boolean) => {
    const next = new Set(selectedInviteEmails);
    if (checked) next.add(email);
    else {
      for (const item of Array.from(next)) {
        if (item.toLowerCase() === email.toLowerCase()) next.delete(item);
      }
    }
    setEmails(Array.from(next).join(", "));
  };

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

      // Send invite emails via edge function (non-fatal -- pending_invites rows already inserted)
      const inviteEmails = emails.split(",").map((e: string) => e.trim()).filter(Boolean);
      if (inviteEmails.length) {
        try {
          await supabase.functions.invoke("invite-players", {
            body: { campaign_id: data.campaign_id, player_emails: inviteEmails },
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
        } catch { /* non-fatal: pending_invites rows exist, players see invite on next login */ }
      }

      // Redirect to lead page -- map generation happens there
      setCampaignSession(data.campaign_id);
      window.location.href = "/lead";

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

            {/* -- 1. Campaign Name -- */}
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

            {/* -- 2. Campaign Scale -- */}
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

            {/* -- 3. Map Layout -- */}
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

            {/* -- 4. Narrative + world/rules configuration -- */}
            <div className="grid gap-6 lg:grid-cols-2 items-stretch">
              <div className="rounded-lg border border-brass/20 bg-black/10 p-4 h-full flex flex-col">
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
                  className="w-full flex-1 min-h-[280px] px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm resize-none leading-relaxed"
                  value={campaignNarrative}
                  onChange={(e) => setCampaignNarrative(e.target.value)}
                  placeholder={
                    isShipLayout
                      ? "e.g. The ancient void warship Implacable Wrath drifts cold and silent through the Ghoul Stars..."
                      : "e.g. Three warbands converge on the remnants of a shattered halo ring..."
                  }
                  rows={9}
                  disabled={loading || creating}
                />
              </div>

              <div className="rounded-lg border border-brass/20 bg-black/10 p-4 space-y-5 h-full">
                <div>
                  <p className="text-sm text-parchment/70">World & Rules</p>
                  <p className="mt-1 text-xs text-parchment/40 leading-relaxed">
                    Set the biome theme and switch core campaign systems on or off.
                  </p>
                </div>

                <div className="space-y-3">
                  <p className="text-xs uppercase tracking-widest text-parchment/45">Terrain Biome</p>

                  {!isShipLayout ? (
                    <>
                      <ToggleSwitch
                        checked={mixedBiomes}
                        onChange={setMixedBiomes}
                        disabled={loading || creating}
                        labelLeft="Single Biome"
                        labelRight="Mixed Biomes"
                      />
                      <p className="text-xs text-parchment/35 leading-relaxed">
                        {mixedBiomes
                          ? "Each zone will receive a different terrain type."
                          : "All zones share a single terrain type -- cohesive visual theme."}
                      </p>
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
                    </>
                  ) : (
                    <div className="rounded-lg border border-brass/15 bg-void/40 px-3 py-3">
                      <p className="text-sm text-parchment/65">
                        Void warship campaigns use compartment themes instead of planet biomes.
                      </p>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <p className="text-xs uppercase tracking-widest text-parchment/45">Rules Configuration</p>

                  <RuleToggleRow
                    label="Economy (NIP/NCP)"
                    description="Enable strategic economy systems, including NIP-based mission influence."
                    checked={!!rulesOverrides.economy?.enabled}
                    onChange={(v) => setRulesOverrides(r => ({ ...r, economy: { ...(r.economy ?? {}), enabled: v } }))}
                    disabled={loading || creating}
                  />

                  {/* Economy sub-settings — only shown when economy is enabled */}
                  {rulesOverrides.economy?.enabled && (
                    <EconomySubPanel
                      economy={rulesOverrides.economy}
                      onChange={(patch) =>
                        setRulesOverrides(r => ({
                          ...r,
                          economy: { ...r.economy, ...patch },
                        }))
                      }
                      disabled={loading || creating}
                    />
                  )}

                  <RuleToggleRow
                    label="Fog of War"
                    description="Keep zones hidden until they are revealed through play."
                    checked={!!rulesOverrides.fog?.enabled}
                    onChange={(v) => setRulesOverrides(r => ({ ...r, fog: { ...(r.fog ?? {}), enabled: v } }))}
                    disabled={loading || creating}
                  />

                  <RuleToggleRow
                    label="Instability Events"
                    description="Allow escalating campaign events to alter the battlefield over time."
                    checked={!!rulesOverrides.instability?.enabled}
                    onChange={(v) => setRulesOverrides(r => ({ ...r, instability: { ...(r.instability ?? {}), enabled: v } }))}
                    disabled={loading || creating}
                  />

                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-parchment/60">Mission Selection</span>
                    <select
                      value={rulesOverrides.missions?.mode ?? "weighted_random_nip"}
                      onChange={(e) => setRulesOverrides(r => ({ ...r, missions: { ...(r.missions ?? {}), mode: e.target.value } }))}
                      className="rounded border border-brass/30 bg-black/30 px-3 py-1.5 text-sm focus:outline-none focus:border-brass/60"
                      disabled={loading || creating}
                    >
                      <option value="random">Random</option>
                      <option value="player_choice">Player Choice</option>
                      <option value="player_choice_nip">Player Choice + NIP Influence</option>
                      <option value="weighted_random_nip">Weighted Random + NIP Influence</option>
                    </select>
                  </div>
                </div>
              </div>
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

        <Card title="Invite Players">
          <div className="space-y-4">
            <div>
              <p className="text-sm text-parchment/70 mb-1">Invite Emails</p>
              <input
                className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="commander@warzone.com, sergeant@forge.world"
                disabled={loading || creating}
              />
              <p className="mt-1 text-xs text-parchment/40">
                Selected existing players are added here automatically. Players auto-join when they sign in.
              </p>
            </div>

            <div className="rounded-lg border border-brass/20 bg-black/10">
              <button
                type="button"
                onClick={() => setPlayerPickerOpen((v) => !v)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
                disabled={loading || creating}
              >
                <div>
                  <p className="text-sm text-parchment/75">Existing Player Accounts</p>
                  <p className="mt-1 text-xs text-parchment/40">
                    Quick-add players by ticking their account email.
                  </p>
                </div>
                <span className="text-xs uppercase tracking-widest text-brass/70">
                  {playerPickerOpen ? "Hide" : "Show"}
                </span>
              </button>

              {playerPickerOpen && (
                <div className="border-t border-brass/15 px-4 py-3">
                  {existingPlayers.length ? (
                    <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                      {existingPlayers.map((player) => {
                        const checked = selectedInviteEmailSet.has(player.email.toLowerCase());
                        return (
                          <label
                            key={player.id}
                            className="flex items-start gap-3 rounded-lg border border-brass/10 bg-black/20 px-3 py-2 cursor-pointer hover:border-brass/25 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => toggleExistingPlayerEmail(player.email, e.target.checked)}
                              disabled={loading || creating}
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block text-sm text-parchment/80">
                                {player.display_name?.trim() || player.email}
                              </span>
                              <span className="block text-xs text-parchment/45 break-all">
                                {player.email}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-parchment/40 leading-relaxed">
                      No existing player accounts were found in the profiles table.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </Card>

      </div>

      <ToastContainer toasts={toasts} dismiss={dismissToast} />
    </Frame>
  );
}
