// supabase/functions/generate-map/index.ts
// Generates a campaign map image via OpenAI gpt-image-1 and stores it in
// Supabase Storage. Called from the lead page Generate Map modal.
//
// changelog:
//   2026-03-03 -- Completely rewrote image prompts to produce top-down tactical
//                map imagery. Each layout has a dedicated prompt emphasising 2D
//                overhead game-map aesthetic, zone delineation, and 40K grimdark.
//                Added campaign_name and campaign_narrative params.
//                Biome-specific prompt modifiers added for all 12 biomes.
//   2026-03-05 -- Reworded prompts to be more cinematic and aligned with 40K universe.
//   2026-03-05 -- map_id now optional: self-creates map record when not provided
//                (new lead-page Generate Map modal flow). Fixed DB column names:
//                generation_status (not status), writes both bg_image_path and
//                image_path for MapImageDisplay compatibility.
//   2026-03-14 -- ship_line prompt completely rewritten to fix terrain-blob output.
//                Root causes fixed: (1) removed sharedShotLock (forced orbital/top-down
//                perspective), (2) removed sharedStyle (planetary terrain map language),
//                (3) replaced biomeMod with ship-interior zone descriptions (biomeMod
//                was defaulting to "ash_wastes" outdoor terrain, directly causing the
//                coloured terrain blobs), (4) changed "top-down" to explicit SIDE-ON
//                LONGITUDINAL CUTAWAY perspective with strong negative prompting.
//                Other layout prompts (ring/continent/radial) unchanged.
//   2026-03-10 -- Ring prompt updated with SVG overlay alignment guidance.
//                The ring's playable band (inner radius ~50%, outer ~86% of frame)
//                is now specified so terrain colouring harmonises with the
//                CampaignMapOverlay SVG sector geometry. Medium-toned playable
//                surface requested so semi-transparent coloured overlays stay
//                legible. Aspect ratio standardised to 1:1 (1024×1024) for ring
//                layout to match the overlay's square aspect-square viewport.


import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type Layout = "ring" | "continent" | "radial" | "ship_line";

// ── Biome visual descriptors ──────────────────────────────────────────────────

const BIOME_DESCRIPTORS: Record<string, string> = {
  gothic_ruins:            "crumbling Gothic cathedral spires, shattered arches, collapsed nave vaults, pale dust and ash, Imperial eagles half-buried in rubble",
  ash_wastes:              "grey volcanic ash plains, toxic dust dunes, half-buried machinery, acid rain craters, choking particulate haze",
  xenos_forest:            "bioluminescent alien vegetation, towering xenos tree-forms with glowing amber sap, phosphorescent spore clouds, fleshy twisted root networks",
  industrial_manufactorum: "vast forge-works, cooling towers belching black smoke, rail-lines, cogitator banks, iron walkways over molten metal vats",
  warp_scar:               "purple-black warp energy tears splitting the ground, daemonic faces in the rock, reality-bending geometry, floating debris and inverted terrain",
  obsidian_fields:         "fields of razor-sharp black volcanic glass, mirror-like flat obsidian plains reflecting a sickly sky, scattered with cracked geode formations",
  signal_crater:           "enormous meteorite impact craters, twisted metal antenna arrays, anomalous energy readings visible as glowing ground fissures",
  ghost_harbor:            "flooded hab-blocks, rusting iron hulls of sunken ships, dark silty water reflecting a pale moon, spectral fog banks",
  blighted_reach:          "diseased earth, Nurgle corruption spreading like rot across the terrain, bloated trees, pools of sickly green ichor, plague flies",
  null_fields:             "dead grey earth where the warp cannot touch, flat featureless plains broken only by iron obelisks, oppressive silence, no shadows",
  iron_sanctum:            "ancient iron fortress walls, buttressed ramparts, siege artillery emplacements, scarred blast walls, votive skulls on pikes",
  halo_spire:              "the soaring needle-like structures of the megastructure's core, vertiginous views down through glass floors to the void below, ancient cogitator pylons",
};

// ── Layout prompts ────────────────────────────────────────────────────────────

function buildPrompt(params: {
  layout:             Layout;
  zone_count:         number;
  biome:              string;
  mixed_biomes:       boolean;
  campaign_name:      string;
  campaign_narrative: string;
}): string {
  const { layout, zone_count, biome, mixed_biomes, campaign_name, campaign_narrative } = params;

  const biomeMod = mixed_biomes
    ? "Each zone features a distinct terrain type — mix of ash wastes, gothic ruins, xenos forest, warp scars, and obsidian fields, each zone visually unique."
    : (BIOME_DESCRIPTORS[biome] ?? "blasted industrial wasteland, corroded metal and scorched earth");

  const narrativeContext = campaign_narrative.trim()
    ? `The campaign setting: "${campaign_narrative.trim()}". `
    : "";

  const campaignNameContext = campaign_name.trim()
    ? `This warzone is known as "${campaign_name}". `
    : "";

  const sharedStyle = [
    "Warhammer 40,000 official art style.",
    "Epic grimdark sci-fi environment concept art.",
    "Hand-painted illustrated campaign map aesthetic — rich ink wash textures and painterly terrain detail.",
    "Grimdark palette for the core of the image: black, stone, dark iron grey, deep crimson, tarnished gold, sickly green warp energy.",
    "Vibrant colours to contrast zone territories: Toxic Orange, rich royal Purple, Deep majestic Blue, Forest Green, Heroic Yellow and Gold.",
    "Zones should feel like physical regions carved into the megastructure terrain, not diagram segments.",
    "Each region has distinct environmental storytelling — ruins, war damage, alien growth, manufactorum structures.",
    "Battle damage visible — craters, scorch marks, ruined buildings, shattered infrastructure.",
    "Cinematic lighting, atmospheric haze, volumetric glow from plasma conduits",
    "Light sources such as a nearby star, or nearby gas cloud Nebulae, or Neutron star in the background softly illuminate the image",
    "Designed as a strategic theatre map used by a commander planning a planetary campaign.",
    "No text overlays. No UI elements. No radial diagram layout.",
    "Painterly, highly detailed, cinematic sci-fi concept art.",
    "Massive sci-fi megastructure strategic campaign map",
    "Massive scale environments — structures feel kilometers large, not room-sized.",
    "avoid segmented wheels, radial wedges, pie charts, infographics, UI, menus, blueprints, floor plans, grid lines, clean diagrams, labels, text",
  ].join(" ");

  const sharedShotLock = [
    "Single image, cinematic environment concept art used as a strategic campaign map.",
    "Orbital / high-altitude perspective: the subject is a real physical place or megastructure, not a UI diagram.",
    "Readable territories emerge from terrain and structural breaks (fractures, walls, ridgelines, chasms, ruined seams), not clean geometric wedges.",
    "Large-scale sense of depth: shadows, atmospheric haze, volumetric light, drifting debris, smoke, ash clouds.",
    "Composition is wide and dramatic, with a clear focal point and secondary points of interest.",
    "Avoid infographic styling: no radial wedges, no pie slices, no schematic floor plan, no blueprint lines, no grid overlay, no menu UI.",
  ].join(" ");

  const sharedLighting = [
    "Strategic map readability lighting — terrain and structures must remain clearly visible.",
    "Global soft illumination across the entire scene so no major areas disappear into darkness.",
    "Multiple light sources reveal terrain: lava glow, reactor glow, city lights, atmospheric haze, reflected starlight.",
    "Rim lighting and ambient light outlining structures and terrain edges.",
    "High contrast between territories while maintaining a dark grimdark palette.",
    "Important terrain features clearly visible from the orbital perspective.",
    "The scene should feel like a commander's war map — dramatic but readable.",
  ].join(" ");

  switch (layout) {
    case "ring": {
      // ── SVG overlay alignment note ─────────────────────────────────────────
      // The CampaignMapOverlay component renders a square SVG (viewBox 0 0 1000
      // 1000) over this image. The ring's playable band is drawn between inner
      // radius 250 (25% from centre) and outer radius 430 (43% from centre), so
      // the ring occupies roughly the middle annular region of the square frame.
      // The image should match these proportions so terrain detail aligns with
      // the sector grid lines.
      //
      // Brightness target for the playable ring surface: mid-tone (not pitch
      // black, not bright white) so that semi-transparent coloured SVG fills
      // (yellow/red/blue/green at 20–45% opacity) remain legible on top.
      // The central void should be distinctly dark. The outer frame (space/void
      // beyond the ring) should also be dark.

      const ringOverlayNote = [
        `COMPOSITION REQUIREMENT: The image must be square (1:1 aspect ratio).`,
        `The ring megastructure should be centred in the frame as a complete circular band,`,
        `with the inner void (empty space) occupying roughly the central 50% of the frame width,`,
        `and the ring's outer edge occupying roughly 86% of the frame width.`,
        `The outer void (space beyond the ring) fills the corners.`,
        `The ring's playable surface (the annular band between inner and outer edge) should be`,
        `medium-toned — not pitch black, not brilliant white — so that coloured semi-transparent`,
        `zone overlays placed on top remain clearly visible.`,
        `The central void and outer space should be distinctly darker than the ring surface.`,
        `The ring is divided into ${zone_count} approximately equal zones arranged clockwise.`,
        `Each zone can be subtly distinguished by its terrain colour or biome character,`,
        `though zone boundaries should emerge from terrain breaks rather than painted lines.`,
      ].join(" ");

      return [
        `Cinematic orbital view of a colossal Ringworld or Halo megastructure in Warhammer 40K, seen from space.`,
        `${narrativeContext}${campaignNameContext}`,
        sharedShotLock,
        ringOverlayNote,
        `The ring forms a vast broken halo around a central abyss, ancient and partially ruined.`,
        `${zone_count} major war-torn regions spread organically across the ring structure, each territory emerging naturally from the terrain rather than forming radial segments.`,
        `Terrain across the ring: ${biomeMod}`,
        `Each region shows environmental identity and faction influence — ruined imperial strongholds, corrupted chaos landscapes, alien xenos ecosystems.`,
        `The inner edge of the ring opens into a deep black void at the center.`,
        `The outer edge exposes the megastructure frame — colossal iron girders, plasma conduits, shattered armor plating, atmospheric vents.`,
        `The ring shows signs of ancient Golden Age engineering, far older than the current factions fighting over it.`,
        `Zones are separated by natural breaks: collapsed superstructure seams, fractured causeways, river-chasms, trench lines, energy barriers, and debris fields — not clean painted wedges.`,
        `The zones represent competing influences from Imperium, Chaos, and Xenos factions.`,
        `Debris fields, shattered structures, and floating wreckage surround sections of the ring.`,
        `Glowing plasma conduits run through the megastructure, casting amber light along the inner edge.`,
        `Atmospheric haze, dust storms, warp glow, and burning ruins across the surface.`,
        `balanced cinematic lighting, not overly dark, details visible - subtle atmospheric glow from the planet or megastructure providing soft fill light across terrain`,
        sharedStyle,
        sharedLighting,
      ].join(" ");
    }

    case "continent": {
      return [
        `Cinematic orbital view of a war-torn Warhammer 40K planet with fractured continents and catastrophic geological damage, seen from space.`,
        `${narrativeContext}${campaignNameContext}`,
        sharedShotLock,
        `${zone_count} major war zones spread across the planet's broken continents and tectonic plates, each territory emerging naturally from the terrain rather than forming neat or symmetrical regions.`,
        `Terrain across the continents: ${biomeMod}`,
        `The planetary crust is shattered — continents split apart by colossal chasms, tectonic fractures, magma seas, toxic sludge oceans, and collapsed hive-city ruins.`,
        `Ragged coastlines, void-cliffs, and shattered landmasses drift apart across boiling oceans or exposed mantle.`,
        `Zone boundaries appear through environmental breaks: mountain chains, crater fields, fortress walls, canyon systems, toxic seas, lava rivers, and ancient defense lines — not drawn borders.`,
        `Evidence of ancient wars scars the landscape: orbital bombardment craters, shattered hive cities, broken manufactorum complexes, trench networks, and abandoned fortresses.`,
        `The continents show the lingering influence of many factions — Imperial bastions, Chaos-corrupted wastelands, and alien Xenos ecosystems — layered across millennia of warfare.`,
        `Storm systems, ash clouds, warp anomalies, and atmospheric haze swirl across the planet, illuminated by distant sunlight and fires from ongoing conflict.`,
        `Floating debris fields and fragments of shattered moons orbit nearby.`,
        `epic sci-fi planetary campaign map environment concept art`,
        `No text overlays. No UI elements. Avoid infographic or boardgame map layouts.`,
        `balanced cinematic lighting, not overly dark, details visible - subtle atmospheric glow from the planet or megastructure providing soft fill light across terrain`,
        sharedStyle,
        sharedLighting,
      ].join(" ");
    }

    case "radial": {
      return [
        `Cinematic orbital view of a colossal disc-shaped megastructure floating in space in the Warhammer 40K universe, engineered as a hub-and-spoke radial fortress-world.`,
        `${narrativeContext}${campaignNameContext}`,
        sharedShotLock,
        `${zone_count} distinct war zones laid out as a central hub objective with massive spoke corridors radiating outward to perimeter territories — the spokes are physical land-bridges and superstructure causeways, not clean diagram wedges.`,
        `Terrain across the disc and spokes: ${biomeMod}`,
        `The central hub is the primary objective: an ancient pre-Imperial tower or spire older than the Warhammer 40K era, heavily fortified, scarred by sieges, partially abandoned yet still powered by failing archeotech.`,
        `Each spoke corridor is its own battle theatre: shattered transit arteries lined with ruined bastions, collapsed manufactorum gantries, barricades, crater fields, and broken defense pylons.`,
        `The spoke corridors show heavy bombardment, void-exposure fractures, and sections patched with brutalist 40K fortifications.`,
        `The outer perimeter territories are more wild and unstable — fractured habitats, alien overgrowth, ash deserts, warp-tainted scars, and forgotten outposts.`,
        `Zones are separated by natural breaks: collapsed superstructure seams, fractured causeways, river-chasms, trench lines, energy barriers, and debris fields — not clean painted wedges.`,
        `Visible superstructure on the underside edges: iron ribs, plasma conduits, exposed deck plating, vents, cables, and broken docking pylons; floating debris and wreckage in the surrounding void.`,
        `Atmospheric haze and smoke pockets cling to surviving terrain; intermittent amber plasma glow runs through conduits; occasional sickly green warp-light bleeds from ruptures.`,
        `No text overlays. No UI elements. Avoid boardgame wheel or infographic styling — this is a physical environment seen from space.`,
        `balanced cinematic lighting, not overly dark, details visible - subtle atmospheric glow from the planet or megastructure providing soft fill light across terrain`,
        sharedStyle,
        sharedLighting,
      ].join(" ");
    }

    case "ship_line": {
      // ── ship_line does NOT use sharedShotLock (orbital perspective) or sharedStyle
      // (planetary terrain map language) — those blocks actively fight the cutaway
      // ship aesthetic and were the primary cause of terrain-blob output.
      //
      // biomeMod is also intentionally NOT used here: planet_profile is null for
      // ship_line, so biomeMod defaults to "ash_wastes" outdoor terrain descriptors
      // which contaminate the interior imagery. Ship interior zones are described
      // explicitly below instead.

      const shipShotLock = [
        `CRITICAL PERSPECTIVE REQUIREMENT: This is a SIDE-ON LONGITUDINAL CUTAWAY ILLUSTRATION of a warship — NOT a top-down orbital map, NOT a terrain zone layout, NOT overhead blobs of land.`,
        `The entire warship runs horizontally across the full width of the image from bow (left) to stern (right), viewed from the side or a slight low three-quarter angle.`,
        `The upper hull plating is removed or shown as transparent, revealing the vast interior compartments in cross-section, like a technical cutaway illustration rendered as grimdark concept art.`,
        `The exterior gothic hull silhouette — with its towers, lance batteries, prow ram, and engine cowlings — frames the top and bottom of the composition.`,
        `This is a SHIP CROSS-SECTION viewed from the side. The interior zones are stacked chambers arranged left-to-right along the ship's length, NOT blobs of outdoor terrain seen from above.`,
      ].join(" ");

      const shipZoneDescriptions = [
        `${zone_count} major interior battle zones are distributed along the ship's length as distinct structural compartments, separated by colossal armoured bulkheads and structural ribs — thick dark iron barriers visible spanning the full interior height.`,
        `Each zone is a unique cavernous interior space: gothic cathedral vaults, industrial machinery halls, plasma reactor chambers, weapon loading bays, crew labyrinth districts, and shrine complexes.`,
        `Bow zones: the command bridge spire rising above the hull, filled with tactical hololiths and cogitator banks glowing amber; Navigator's sanctum and astropathic choir glowing with eerie psychic purple-blue light.`,
        `Midship zones: vast weapon decks with macro cannon batteries and lance arrays embedded in the hull walls; crew districts as dense industrial labyrinths of barracks, manufactorums, and gothic shrines.`,
        `Stern zones: the plasma reactors and warp drive — colossal cathedral-like machinery chambers glowing with intense blue-white plasma energy; the main engines visible as massive glowing exhausts at the far right.`,
        `Interior aesthetic throughout: corroded iron deck plates, gothic arches, vaulted ceilings, amber cogitator light, incense braziers, servo skull stations, purity seals, devotional statues.`,
      ].join(" ");

      const shipStyle = [
        `Warhammer 40K Battlefleet Gothic official concept art style — grimdark Gothic warship cutaway cross-section illustration.`,
        `The ship silhouette is magnificent and massive: gothic spires, prow-mounted lance arrays, armoured flanks bristling with weapon batteries, towering superstructure.`,
        `Rich mechanical detail on the hull exterior: riveted iron plating, cathedral buttresses, turrets, gothic spires, venting plasma exhausts, prow ram.`,
        `Battle damage throughout: breached decks exposing the void, plasma fires, collapsed corridors, shattered statues, explosive decompression, blast marks.`,
        `Stars, nebula glow, and void visible beyond the hull where armour plates have been torn away.`,
        `Grimdark palette: corroded iron, dark stone, deep crimson, tarnished gold, with blue-white plasma glow from the stern engines and amber mechanical light within.`,
        `Vibrant zone identity colours tinting each interior compartment — Orange, Purple, Blue, Green, Gold — distinguishing battle zones without replacing the mechanical aesthetic.`,
        `Epic scale: the ship feels kilometres long; individual figures and vehicles implied by architectural scale alone.`,
        `Cinematic lighting: blue-white plasma reactor glow from the stern, amber cogitator light in command areas, warp energy glow in the navigator's sanctum, fire and battle damage throughout.`,
        `NO top-down terrain view. NO outdoor landscapes. NO blob zones. NO volcanic plains. NO alien forests. NO planetary surface. NO overhead map. NO floor plan grid. NO text. NO UI.`,
        `This is a side-on warship cross-section concept art illustration, not a planetary map.`,
      ].join(" ");

      return [
        `Warhammer 40K Gothic warship cutaway concept art: a colossal Imperial warship seen from the side with the hull cut away to reveal the vast interior battle zones arranged along its full length.`,
        `${narrativeContext}${campaignNameContext}`,
        shipShotLock,
        shipZoneDescriptions,
        shipStyle,
        sharedLighting,
      ].join(" ");
    }

    default: {
      return [
        `Top-down cinematic and tactical Warhammer 40K campaign map with ${zone_count} distinct battle zones.`,
        `${narrativeContext}`,
        `Terrain: ${biomeMod}`,
        sharedStyle,
      ].join(" ");
    }
  }
}

// ── Image size per layout ────────────────────────────────────────────────────
// Ring uses 1024×1024 (square) so the aspect-square SVG overlay aligns 1:1.
// Other layouts use 1536×1024 (landscape) for a wider cinematic feel.

function imageSizeForLayout(layout: Layout): string {
  return layout === "ring" ? "1024x1024" : "1536x1024";
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    // Auth -- allow both authenticated user calls and service-role background calls
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");

    if (authHeader) {
      const result = await requireUser(req).catch(() => null);
      if (result?.user) userId = result.user.id;
    }

    const admin = adminClient();

    const body = await req.json().catch(() => ({}));
    const {
      map_id,
      campaign_id,
      layout             = "ring",
      zone_count         = 8,
      biome              = "ash_wastes",
      mixed_biomes       = false,
      campaign_name      = "",
      campaign_narrative = "",
    } = body as {
      map_id?:             string;
      campaign_id?:        string;
      layout?:             Layout;
      zone_count?:         number;
      biome?:              string;
      mixed_biomes?:       boolean;
      campaign_name?:      string;
      campaign_narrative?: string;
    };

    if (!campaign_id) return json(400, { ok: false, error: "campaign_id required" });

    // Verify caller is lead/admin if this is an authenticated user call
    if (userId) {
      const { data: mem } = await admin
        .from("campaign_members")
        .select("role")
        .eq("campaign_id", campaign_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!mem || !["lead", "admin"].includes(mem.role)) {
        return json(403, { ok: false, error: "Only the campaign Lead can generate or regenerate the map." });
      }
    }

    // -- Create or reuse map record ------------------------------------------

    let activeMapId = map_id ?? null;

    if (!activeMapId) {
      const { data: newMap, error: mapInsertErr } = await admin
        .from("maps")
        .insert({
          name:              `${String(campaign_name)} Map`,
          description:       campaign_narrative ? String(campaign_narrative).slice(0, 200) : null,
          map_json:          {},
          created_by:        userId,
          layout,
          zone_count,
          art_version:       "grimdark-v2",
          generation_status: "generating",
        })
        .select("id")
        .single();

      if (mapInsertErr || !newMap) {
        console.error("[generate-map] Map record insert failed:", mapInsertErr?.message);
        return json(500, { ok: false, error: "Failed to create map record" });
      }
      activeMapId = newMap.id;
      console.log(`[generate-map] Created new map record: ${activeMapId}`);
    } else {
      // Mark existing map as regenerating
      await admin.from("maps").update({ generation_status: "generating" }).eq("id", activeMapId);
    }

    // Build the OpenAI prompt
    const prompt = buildPrompt({
      layout:             layout as Layout,
      zone_count,
      biome,
      mixed_biomes,
      campaign_name,
      campaign_narrative,
    });

    console.log(`[generate-map] campaign=${campaign_id} map=${activeMapId} layout=${layout} zones=${zone_count}`);
    console.log(`[generate-map] prompt length=${prompt.length}`);

    // Call OpenAI gpt-image-1
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      await admin.from("maps").update({ generation_status: "failed" }).eq("id", activeMapId);
      return json(500, { ok: false, error: "OpenAI API key not configured" });
    }

    const imageSize = imageSizeForLayout(layout as Layout);

    const imageResp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model:   "gpt-image-1",
        prompt,
        n:       1,
        size:    imageSize,
        quality: "high",
      }),
    });

    if (!imageResp.ok) {
      const errText = await imageResp.text().catch(() => "unknown");
      console.error("[generate-map] OpenAI error:", errText);
      await admin.from("maps").update({ generation_status: "failed" }).eq("id", activeMapId);
      return json(500, { ok: false, error: `OpenAI error: ${imageResp.status}` });
    }

    const imageData = await imageResp.json();
    const b64 = imageData?.data?.[0]?.b64_json as string | undefined;

    if (!b64) {
      await admin.from("maps").update({ generation_status: "failed" }).eq("id", activeMapId);
      return json(500, { ok: false, error: "No image data returned from OpenAI" });
    }

    // Decode base64 to Uint8Array
    const raw   = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    // Upload to Supabase Storage
    // Path: campaign-maps/{campaign_id}/maps/{map_id}/bg.png
    const storagePath = `${campaign_id}/maps/${activeMapId}/bg.png`;

    const { error: uploadErr } = await admin.storage
      .from("campaign-maps")
      .upload(storagePath, bytes, {
        contentType: "image/png",
        upsert:      true,
      });

    if (uploadErr) {
      console.error("[generate-map] Storage upload error:", uploadErr.message);
      await admin.from("maps").update({ generation_status: "failed" }).eq("id", activeMapId);
      return json(500, { ok: false, error: `Storage upload failed: ${uploadErr.message}` });
    }

    // Update map record
    const { error: updateErr } = await admin
      .from("maps")
      .update({
        bg_image_path:     storagePath,
        image_path:        storagePath,
        generation_status: "complete",
      })
      .eq("id", activeMapId);

    if (updateErr) {
      console.error("[generate-map] Map update error:", updateErr.message);
      return json(500, { ok: false, error: `Map update failed: ${updateErr.message}` });
    }

    console.log(`[generate-map] Complete. map=${activeMapId} path=${storagePath} size=${imageSize}`);
    return json(200, { ok: true, map_id: activeMapId, image_path: storagePath });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[generate-map] Unexpected error:", msg);
    return json(500, { ok: false, error: msg ?? "Server error" });
  }
});
