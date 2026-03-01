/**
 * MapGenerationFields
 * ───────────────────
 * Drop these UI fields into the campaign creation form (app/campaigns/new/page.tsx).
 *
 * HOW TO INTEGRATE:
 * 1. Add the MapGenerationFields component inside your <form> element,
 *    after the existing campaign_size field.
 * 2. Add the new state variables to your form state.
 * 3. Include the new fields in the payload sent to create-campaign.
 *
 * See the "Form state additions" and "Payload additions" sections below.
 */

"use client";

import { useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export type Layout     = "ring" | "continent" | "radial" | "ship_line";
export type PlanetMode = "uniform" | "mixed";
export type ShipClass  = "Frigate" | "Cruiser" | "Battleship";

export type PlanetProfile =
  | { mode: "uniform"; uniformBiome: string }
  | { mode: "mixed"; biomes: string[] };

export interface ShipProfile {
  class: ShipClass;
  // name is auto-generated server-side
}

export interface MapGenParams {
  layout:         Layout;
  planet_profile: PlanetProfile | null;
  ship_profile:   ShipProfile   | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LAYOUTS: { value: Layout; label: string; description: string }[] = [
  { value: "ring",      label: "Halo Ring",            description: "Zone segments arranged in a ring megastructure" },
  { value: "continent", label: "Fractured Continent",  description: "Irregular zones separated by cracks and chasms" },
  { value: "radial",    label: "Radial Spokes",        description: "Zones radiating from a central objective" },
  { value: "ship_line", label: "Void Warship",         description: "Compartments along a warship hull (auto-sets zone count)" },
];

const BIOMES: { value: string; label: string }[] = [
  { value: "gothic_ruins",           label: "Gothic Ruins" },
  { value: "ash_wastes",             label: "Ash Wastes" },
  { value: "xenos_forest",           label: "Xenos Forest" },
  { value: "industrial_manufactorum",label: "Industrial Manufactorum" },
  { value: "warp_scar",              label: "Warp Scar" },
  { value: "obsidian_fields",        label: "Obsidian Fields" },
  { value: "signal_crater",          label: "Signal Crater" },
  { value: "ghost_harbor",           label: "Ghost Harbor" },
  { value: "blighted_reach",         label: "Blighted Reach" },
  { value: "null_fields",            label: "Null Fields" },
  { value: "iron_sanctum",           label: "Iron Sanctum" },
  { value: "halo_spire",             label: "Halo Spire" },
];

const SHIP_CLASSES: { value: ShipClass; label: string; zones: number }[] = [
  { value: "Frigate",    label: "Frigate",    zones: 4  },
  { value: "Cruiser",    label: "Cruiser",    zones: 8  },
  { value: "Battleship", label: "Battleship", zones: 12 },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface MapGenerationFieldsProps {
  value:    MapGenParams;
  onChange: (params: MapGenParams) => void;
  disabled?: boolean;
}

export function MapGenerationFields({ value, onChange, disabled = false }: MapGenerationFieldsProps) {
  const { layout, planet_profile, ship_profile } = value;

  const setLayout = (l: Layout) => {
    const next: MapGenParams = { ...value, layout: l };
    // Reset ship profile when switching away from ship_line
    if (l !== "ship_line") next.ship_profile = null;
    // Default ship class when switching to ship_line
    if (l === "ship_line" && !value.ship_profile) {
      next.ship_profile  = { class: "Cruiser" };
      next.planet_profile = null;
    }
    onChange(next);
  };

  const setPlanetMode = (mode: PlanetMode) => {
    if (mode === "uniform") {
      onChange({ ...value, planet_profile: { mode: "uniform", uniformBiome: "ash_wastes" } });
    } else {
      onChange({ ...value, planet_profile: { mode: "mixed", biomes: ["gothic_ruins", "ash_wastes", "industrial_manufactorum", "warp_scar"] } });
    }
  };

  const setUniformBiome = (biome: string) => {
    onChange({ ...value, planet_profile: { mode: "uniform", uniformBiome: biome } });
  };

  const toggleMixedBiome = (biome: string) => {
    if (planet_profile?.mode !== "mixed") return;
    const current = planet_profile.biomes ?? [];
    const updated = current.includes(biome)
      ? current.filter(b => b !== biome)
      : [...current, biome];
    // Minimum 2 biomes
    if (updated.length < 2) return;
    onChange({ ...value, planet_profile: { mode: "mixed", biomes: updated } });
  };

  const setShipClass = (cls: ShipClass) => {
    onChange({ ...value, ship_profile: { class: cls } });
  };

  return (
    <fieldset className="border border-zinc-700 rounded-lg p-4 space-y-5" disabled={disabled}>
      <legend className="px-2 text-amber-400 text-sm font-semibold uppercase tracking-widest">
        ⚙ Map Generation
      </legend>

      {/* Layout selection */}
      <div className="space-y-2">
        <label className="text-sm text-zinc-300 font-medium">Map Layout</label>
        <div className="grid grid-cols-2 gap-2">
          {LAYOUTS.map((l) => (
            <button
              key={l.value}
              type="button"
              onClick={() => setLayout(l.value)}
              disabled={disabled}
              className={[
                "text-left p-3 rounded border transition-colors text-sm",
                layout === l.value
                  ? "border-amber-500 bg-amber-950/40 text-amber-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500",
              ].join(" ")}
            >
              <div className="font-semibold">{l.label}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{l.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Ship class (only when layout is ship_line) */}
      {layout === "ship_line" && (
        <div className="space-y-2">
          <label className="text-sm text-zinc-300 font-medium">
            Vessel Class
            <span className="text-zinc-500 ml-2 text-xs">(determines zone count)</span>
          </label>
          <div className="flex gap-2">
            {SHIP_CLASSES.map((sc) => (
              <button
                key={sc.value}
                type="button"
                onClick={() => setShipClass(sc.value)}
                disabled={disabled}
                className={[
                  "flex-1 p-3 rounded border text-sm font-semibold transition-colors",
                  ship_profile?.class === sc.value
                    ? "border-amber-500 bg-amber-950/40 text-amber-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500",
                ].join(" ")}
              >
                {sc.label}
                <span className="block text-xs font-normal text-zinc-500">{sc.zones} zones</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-zinc-600 italic">
            Ship name is generated automatically from the seed.
          </p>
        </div>
      )}

      {/* Planet climate (only when not ship_line) */}
      {layout !== "ship_line" && (
        <div className="space-y-3">
          <label className="text-sm text-zinc-300 font-medium">Planet Climate</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPlanetMode("mixed")}
              disabled={disabled}
              className={[
                "flex-1 p-2 rounded border text-sm transition-colors",
                planet_profile?.mode !== "uniform"
                  ? "border-amber-500 bg-amber-950/40 text-amber-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500",
              ].join(" ")}
            >
              Mixed Biomes
            </button>
            <button
              type="button"
              onClick={() => setPlanetMode("uniform")}
              disabled={disabled}
              className={[
                "flex-1 p-2 rounded border text-sm transition-colors",
                planet_profile?.mode === "uniform"
                  ? "border-amber-500 bg-amber-950/40 text-amber-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500",
              ].join(" ")}
            >
              Uniform Biome
            </button>
          </div>

          {/* Uniform biome picker */}
          {planet_profile?.mode === "uniform" && (
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Biome</label>
              <select
                value={planet_profile.uniformBiome}
                onChange={(e) => setUniformBiome(e.target.value)}
                disabled={disabled}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-amber-500"
              >
                {BIOMES.map(b => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Mixed biome multi-select */}
          {planet_profile?.mode === "mixed" && (
            <div>
              <label className="text-xs text-zinc-400 mb-2 block">
                Select biomes (min 2)
                {" "}<span className="text-zinc-600">— {(planet_profile as { mode: "mixed"; biomes: string[] }).biomes.length} selected</span>
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {BIOMES.map(b => {
                  const selected = (planet_profile as { mode: "mixed"; biomes: string[] }).biomes.includes(b.value);
                  return (
                    <button
                      key={b.value}
                      type="button"
                      onClick={() => toggleMixedBiome(b.value)}
                      disabled={disabled}
                      className={[
                        "px-2 py-1.5 rounded border text-xs transition-colors",
                        selected
                          ? "border-amber-600 bg-amber-950/40 text-amber-300"
                          : "border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-500",
                      ].join(" ")}
                    >
                      {b.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}

// ── Default initial state ─────────────────────────────────────────────────────

export const defaultMapGenParams: MapGenParams = {
  layout:        "ring",
  planet_profile: { mode: "mixed", biomes: ["gothic_ruins", "ash_wastes", "industrial_manufactorum", "warp_scar"] },
  ship_profile:   null,
};

/*
 * ─── HOW TO ADD TO YOUR NEW CAMPAIGN PAGE ─────────────────────────────────────
 *
 * 1. Import at the top of app/campaigns/new/page.tsx:
 *    import { MapGenerationFields, defaultMapGenParams, type MapGenParams } from "@/components/MapGenerationFields";
 *
 * 2. Add state:
 *    const [mapGenParams, setMapGenParams] = useState<MapGenParams>(defaultMapGenParams);
 *
 * 3. Add to JSX (after campaign_size field):
 *    <MapGenerationFields
 *      value={mapGenParams}
 *      onChange={setMapGenParams}
 *      disabled={isSubmitting}
 *    />
 *
 * 4. Add to your fetch payload:
 *    layout:        mapGenParams.layout,
 *    planet_profile: mapGenParams.planet_profile,
 *    ship_profile:  mapGenParams.ship_profile,
 *
 * 5. Note: when layout === "ship_line", the campaign_size is ignored
 *    by the create-campaign function — zone count comes from ship class.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
