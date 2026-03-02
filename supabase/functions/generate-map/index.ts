// supabase/functions/generate-map/index.ts
// Calls OpenAI gpt-image-1 to generate a grimdark campaign map image,
// uploads the result to Supabase Storage, and updates the maps row.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json, adminClient } from "../_shared/utils.ts";

// ── Zone name pools ─────────────────────────────────────────────────────────

/** Fixed zone names for planet-based layouts (ring/continent/radial). */
const PLANET_ZONE_NAMES = [
  "Vault Ruins",
  "Ash Wastes",
  "Halo Spire",
  "Sunken Manufactorum",
  "Warp Scar Basin",
  "Obsidian Fields",
  "Signal Crater",
  "Xenos Forest",
  "Blighted Reach",
  "Iron Sanctum",
  "Null Fields",
  "Ghost Harbor",
];

/** Zone names for ship_line layout — compartments, not terrain. */
const SHIP_ZONE_NAMES = [
  "Command Sanctum",
  "Macro-Battery Deck",
  "Gellar Chapel",
  "Reactor Reliquary",
  "Hangar Crypts",
  "Munitorum Vaults",
  "Vox Spire",
  "Apothecarion",
  "Shrine of Oaths",
  "Plasma Conduits",
  "Enginseer Bay",
  "Breach Corridor",
];

/** Short visual descriptions per biome key — used in prompts only (no text in image). */
const BIOME_DESCS: Record<string, string> = {
  gothic_ruins:           "gothic cathedral ruins, broken arches, shattered stained glass, gargoyles",
  ash_wastes:             "ash wastes, toxic dust storms, desolate grey plains, skeletal trees",
  xenos_forest:           "alien xenos forest, bioluminescent plants, chitinous growths, spore clouds",
  industrial_manufactorum:"industrial manufactorum, forge chimneys, rivers of molten metal, catwalks",
  warp_scar:              "warp scar, reality tears, impossible geometry, purple-black rifts",
  obsidian_fields:        "obsidian fields, black glass plains, volcanic debris, heat shimmer",
  signal_crater:          "signal crater, crashed voidship wreckage, massive antenna arrays",
  ghost_harbor:           "ghost harbor, flooded ruined docks, sunken ships, thick fog",
  blighted_reach:         "blighted reach, corrupted earth, diseased growths, decay and rust",
  null_fields:            "null fields, dead grey static zones, anti-psychic dead zones",
  iron_sanctum:           "iron sanctum, fortress walls, ancient bunkers, adamantium gates",
  halo_spire:             "halo spire, towering megastructure columns, ring architecture, void vistas",
};

// ── Deterministic shuffle ────────────────────────────────────────────────────

function seededShuffle<T>(arr: T[], seed: string): T[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    hash = ((hash << 5) - hash + i) | 0;
    const j = Math.abs(hash) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ── Ship name generation ─────────────────────────────────────────────────────

const SHIP_PREFIXES = ["Vengeful", "Penitent", "Iron", "Eclipsed", "Oathbound", "Saint's"];
const SHIP_CORES    = ["Halo", "Reliquary", "Martyr", "Glaive", "Cathedral", "Cinder"];
const SHIP_SUFFIXES = ["of Kharos", "of the Ninth", "of Silent Ash", "of the Void", "of Twilight"];

function generateShipName(seed: string): string {
  const shuffledPre = seededShuffle(SHIP_PREFIXES, seed + "pre");
  const shuffledCor = seededShuffle(SHIP_CORES,    seed + "cor");
  const shuffledSuf = seededShuffle(SHIP_SUFFIXES,  seed + "suf");
  return `${shuffledPre[0]} ${shuffledCor[0]} ${shuffledSuf[0]}`;
}

// ── Prompt builder ───────────────────────────────────────────────────────────

interface PlanetProfile {
  mode: "uniform" | "mixed";
  uniformBiome?: string;
  biomes?: string[];
}

interface ShipProfile {
  class: "Frigate" | "Cruiser" | "Battleship";
  name: string;
}

function buildPrompt(params: {
  layout: string;
  zoneCount: number;
  zoneNames: string[];
  planetProfile?: PlanetProfile;
  shipProfile?: ShipProfile;
}): string {
  const { layout, zoneCount, zoneNames, planetProfile, shipProfile } = params;

  const LAYOUT_DESCS: Record<string, string> = {
    ring:      `ring megastructure — ${zoneCount} distinct wedge or arc segments arranged in a halo circle`,
    continent: `fractured continent — ${zoneCount} irregular plate-like regions separated by cracks, chasms, and lava flows`,
    radial:    `radial spoke map — ${zoneCount} zones radiating outward from a central objective point like spokes on a wheel`,
    ship_line: `ancient warship viewed top-down — ${zoneCount} compartments arranged linearly along the vessel hull from bow to stern`,
  };
  const layoutDesc = LAYOUT_DESCS[layout] ?? `campaign map with ${zoneCount} distinct regions`;

  let climateBlock = "";
  if (layout !== "ship_line") {
    if (planetProfile?.mode === "uniform" && planetProfile.uniformBiome) {
      const desc = BIOME_DESCS[planetProfile.uniformBiome] ?? planetProfile.uniformBiome;
      climateBlock = `Planet climate (uniform): all regions share a consistent theme of ${desc}.`;
    } else {
      const biomes = planetProfile?.biomes ?? ["gothic_ruins", "ash_wastes", "industrial_manufactorum", "warp_scar"];
      const descs  = biomes.map(b => BIOME_DESCS[b] ?? b).join("; ");
      climateBlock = `Planet climate (mixed biomes): distribute these visual themes across the ${zoneCount} regions — ${descs}.`;
    }
  }

  let shipBlock = "";
  if (layout === "ship_line" && shipProfile) {
    shipBlock = `Warship setting: depict the ${shipProfile.class}-class vessel "${shipProfile.name}" as the map silhouette — gothic buttresses, armored plating, void-blackened metal, interior corridor lighting, NO readable markings.`;
  }

  const zoneFlavor = zoneNames.join(", ");

  return [
    `Create a grimdark gothic sci-fi campaign map background.`,
    `ABSOLUTE RULE: NO text, NO letters, NO numbers, NO words, NO labels, NO UI, NO compass rose, NO readable symbols anywhere in the image.`,
    ``,
    `Art style: Warhammer 40K-inspired top-down map plate, cathedral-gothic industrial ruins, weathered stone and metal, soot, ash, embers, corroded brass fittings, sickly green lumens, painterly illustration.`,
    ``,
    // ── READABILITY DIRECTIVES — replaces old "dark atmospheric tones" ──────
    `Lighting & readability (CRITICAL): lifted midtones, balanced contrast, clearly visible surface detail across every region.`,
    `Do NOT crush the blacks into solid darkness.`,
    `Do NOT use heavy atmospheric fog, smoke, or haze that obscures zone boundaries or makes regions unreadable.`,
    `Do NOT use heavy vignetting that darkens the edges into illegibility.`,
    `Zone boundaries MUST be readable at a distance — use physical dividers: trenches, cracks, lava rivers, ruined walls, bulkheads, or structural fissures. Never use darkness or fog as the divider.`,
    `The overall image should feel dark-toned and grimdark in palette, but NOT muddy — every surface texture must be legible.`,
    ``,
    `Composition: ${layoutDesc}. The ${zoneCount} regions must be clearly separated by visible physical boundaries. Boundaries must remain readable even in the darkest zones.`,
    ``,
    climateBlock,
    shipBlock,
    ``,
    `Zone visual flavor cues (for texture and lighting variety only — NO text in image): ${zoneFlavor}.`,
    ``,
    `Final reminder: absolutely no letters, words, numbers, compass markings, or any readable content. Midtones must be lifted — dark but readable, never muddy.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Cache key builder ────────────────────────────────────────────────────────

function buildCacheKey(params: {
  artVersion: string;
  seed: string;
  layout: string;
  zoneCount: number;
  planetProfile?: PlanetProfile;
  shipProfile?: ShipProfile;
}): string {
  const { artVersion, seed, layout, zoneCount, planetProfile, shipProfile } = params;
  const parts = [artVersion, seed, layout, String(zoneCount)];
  if (planetProfile) parts.push(JSON.stringify(planetProfile));
  if (shipProfile)   parts.push(JSON.stringify(shipProfile));
  return parts.join("|");
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")   return json(405, { ok: false, error: "Method not allowed" });

  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiKey) return json(500, { ok: false, error: "OPENAI_API_KEY not configured" });

  const body = await req.json().catch(() => ({}));

  const map_id:         string                    = body.map_id;
  const campaign_id:    string                    = body.campaign_id;
  const seed:           string                    = body.seed ?? map_id;
  const layout:         string                    = body.layout ?? "ring";
  const zone_count:     number                    = body.zone_count ?? 8;
  // Bumped to grimdark-v2 so old dark cached maps are NOT reused for new generations
  const art_version:    string                    = body.art_version ?? "grimdark-v2";
  const planet_profile: PlanetProfile | undefined = body.planet_profile;
  let   ship_profile:   ShipProfile   | undefined = body.ship_profile;

  if (!map_id)      return json(400, { ok: false, error: "Missing map_id" });
  if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });

  const admin = adminClient();

  if (layout === "ship_line" && ship_profile && !ship_profile.name) {
    ship_profile = { ...ship_profile, name: generateShipName(seed) };
  }

  const cacheKey = buildCacheKey({
    artVersion: art_version,
    seed,
    layout,
    zoneCount:     zone_count,
    planetProfile: planet_profile,
    shipProfile:   ship_profile,
  });

  const { data: cachedMap } = await admin
    .from("maps")
    .select("id, bg_image_path, image_path")
    .eq("cache_key", cacheKey)
    .eq("generation_status", "complete")
    .neq("id", map_id)
    .maybeSingle();

  if (cachedMap?.bg_image_path) {
    await admin.from("maps").update({
      bg_image_path:     cachedMap.bg_image_path,
      image_path:        cachedMap.image_path ?? cachedMap.bg_image_path,
      generation_status: "complete",
      cache_key:         cacheKey,
      art_version,
    }).eq("id", map_id);

    return json(200, { ok: true, map_id, cached: true, image_path: cachedMap.bg_image_path });
  }

  await admin.from("maps").update({
    generation_status: "generating",
    cache_key:         cacheKey,
    art_version,
    layout,
    zone_count,
    planet_profile: planet_profile ?? null,
    ship_profile:   ship_profile   ?? null,
    seed,
  }).eq("id", map_id);

  try {
    const namePool  = layout === "ship_line" ? SHIP_ZONE_NAMES : PLANET_ZONE_NAMES;
    const zoneNames = seededShuffle(namePool, seed).slice(0, zone_count);
    const prompt    = buildPrompt({ layout, zoneCount: zone_count, zoneNames, planetProfile: planet_profile, shipProfile: ship_profile });

    console.log("generate-map: calling OpenAI gpt-image-1");
    console.log("generate-map: layout =", layout, "zones =", zone_count, "art_version =", art_version);

    const aiRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${openAiKey}`,
      },
      body: JSON.stringify({
        model:         "gpt-image-1",
        prompt,
        n:             1,
        size:          "1536x1024",
        quality:       "high",
        output_format: "png",
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`OpenAI API error ${aiRes.status}: ${errText.slice(0, 400)}`);
    }

    const aiData = await aiRes.json();
    const b64 = aiData?.data?.[0]?.b64_json as string | undefined;
    if (!b64) throw new Error("OpenAI returned no image data");

    const binaryStr = atob(b64);
    const bytes     = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const storagePath = `${campaign_id}/maps/${map_id}/bg.png`;
    const { error: uploadErr } = await admin.storage
      .from("campaign-maps")
      .upload(storagePath, bytes, { contentType: "image/png", upsert: true });

    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

    console.log("generate-map: uploaded to", storagePath);

    await admin.from("maps").update({
      bg_image_path:     storagePath,
      image_path:        storagePath,
      generation_status: "complete",
    }).eq("id", map_id);

    return json(200, { ok: true, map_id, cached: false, image_path: storagePath });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("generate-map: FAILED —", message);
    await admin.from("maps").update({ generation_status: "failed" }).eq("id", map_id);
    return json(500, { ok: false, error: message });
  }
});
