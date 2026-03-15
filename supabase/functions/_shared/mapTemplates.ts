// supabase/functions/_shared/mapTemplates.ts
//
// Canonical layout-specific zone definitions.
// Imported by create-campaign to seed map_json at campaign creation time so that
// generate-map and start-campaign always have named zones to work with.
//
// Layout alias handling:
//   create-campaign's normaliseLayout converts for generate-map:
//     "void_ship" → "ship_line"    "spokes" → "radial"
//   So buildMapTemplate receives the generate-map canonical values.
//   Both the generate-map form AND the frontend form are accepted here.
//
// changelog:
//   2026-03-15 — CREATED. Extracted from start-campaign fallbackMap() and
//                extended with layout-specific zone pools. create-campaign now
//                calls buildMapTemplate(layout, zoneCount) to populate map_json
//                at creation time. start-campaign retains its map_json read but
//                drops its own fallbackMap(), using this module as a safety net
//                for legacy campaigns.

export type ZoneDef = {
  key:     string;
  name:    string;
  sectors: { key: string }[];
};

export type MapTemplate = {
  zones: ZoneDef[];
};

const SECTOR_LETTERS = ["a", "b", "c", "d"] as const;

function makeSectors(zoneKey: string): { key: string }[] {
  return SECTOR_LETTERS.map((s) => ({ key: `${zoneKey}:${s}` }));
}

function zone(key: string, name: string): ZoneDef {
  return { key, name, sectors: makeSectors(key) };
}

// ── Layout zone pools ─────────────────────────────────────────────────────────
// Each pool covers 12 zones. buildMapTemplate() slices to zoneCount,
// with a safe overflow fallback for larger counts.

const RING_ZONES: ZoneDef[] = [
  zone("vault_ruins",         "Vault Ruins"),
  zone("ash_wastes",          "Ash Wastes"),
  zone("halo_spire",          "Halo Spire"),
  zone("sunken_manufactorum", "Sunken Manufactorum"),
  zone("warp_scar_basin",     "Warp Scar Basin"),
  zone("obsidian_fields",     "Obsidian Fields"),
  zone("signal_crater",       "Signal Crater"),
  zone("xenos_forest",        "Xenos Forest"),
  zone("iron_delta",          "Iron Delta"),
  zone("shattered_cathedral", "Shattered Cathedral"),
  zone("plague_sprawl",       "Plague Sprawl"),
  zone("smelting_pits",       "Smelting Pits"),
];

// index 0 = hub zone; outer zones follow
const SPOKES_ZONES: ZoneDef[] = [
  zone("central_nexus",       "Central Nexus"),
  zone("vault_ruins",         "Vault Ruins"),
  zone("ash_wastes",          "Ash Wastes"),
  zone("halo_spire",          "Halo Spire"),
  zone("sunken_manufactorum", "Sunken Manufactorum"),
  zone("warp_scar_basin",     "Warp Scar Basin"),
  zone("obsidian_fields",     "Obsidian Fields"),
  zone("signal_crater",       "Signal Crater"),
  zone("xenos_forest",        "Xenos Forest"),
  zone("iron_delta",          "Iron Delta"),
  zone("shattered_cathedral", "Shattered Cathedral"),
  zone("plague_sprawl",       "Plague Sprawl"),
];

const CONTINENT_ZONES: ZoneDef[] = [
  zone("vault_ruins",         "Vault Ruins"),
  zone("ash_wastes",          "Ash Wastes"),
  zone("halo_spire",          "Halo Spire"),
  zone("sunken_manufactorum", "Sunken Manufactorum"),
  zone("warp_scar_basin",     "Warp Scar Basin"),
  zone("obsidian_fields",     "Obsidian Fields"),
  zone("signal_crater",       "Signal Crater"),
  zone("xenos_forest",        "Xenos Forest"),
  zone("iron_delta",          "Iron Delta"),
  zone("shattered_cathedral", "Shattered Cathedral"),
  zone("plague_sprawl",       "Plague Sprawl"),
  zone("smelting_pits",       "Smelting Pits"),
];

// Void ship zones ordered bow→stern
const VOID_SHIP_ZONES: ZoneDef[] = [
  zone("bridge",           "Bridge"),
  zone("command_deck",     "Command Deck"),
  zone("armory",           "Armory"),
  zone("enginarium",       "Enginarium"),
  zone("medicae_bay",      "Medicae Bay"),
  zone("cargo_hold",       "Cargo Hold"),
  zone("crew_quarters",    "Crew Quarters"),
  zone("void_lock",        "Void Lock"),
  zone("plasma_conduits",  "Plasma Conduits"),
  zone("servitor_warrens", "Servitor Warrens"),
  zone("ammo_stores",      "Ammo Stores"),
  zone("stern_battery",    "Stern Battery"),
];

/**
 * Resolves any layout alias to the correct zone pool.
 * Accepts both frontend values (void_ship, spokes) and the generate-map
 * canonical values (ship_line, radial) that create-campaign normalises to.
 */
function resolvePool(layout: string): ZoneDef[] {
  switch (layout) {
    case "void_ship":
    case "ship_line":
      return VOID_SHIP_ZONES;
    case "spokes":
    case "spoke":
    case "radial":
      return SPOKES_ZONES;
    case "continent":
      return CONTINENT_ZONES;
    case "ring":
    default:
      return RING_ZONES;
  }
}

/**
 * Returns a MapTemplate for the given layout and zone count.
 * If zoneCount exceeds the pool size, overflow zones are named "Zone N".
 */
export function buildMapTemplate(layout: string, zoneCount: number): MapTemplate {
  const pool  = resolvePool(layout);
  const zones: ZoneDef[] = [];

  for (let i = 0; i < zoneCount; i++) {
    if (i < pool.length) {
      zones.push(pool[i]);
    } else {
      const key = `zone_${i}`;
      zones.push(zone(key, `Zone ${i}`));
    }
  }

  return { zones };
}
