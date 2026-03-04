// supabase/functions/generate-map/index.ts
// Generates a campaign map image via OpenAI gpt-image-1 and stores it in
// Supabase Storage. Called by create-campaign (background) and directly for
// regeneration requests.
//
// changelog:
//   2026-03-03 — Completely rewrote image prompts to produce top-down tactical
//                map imagery instead of 3D rendered scenes. Each layout now has
//                a dedicated prompt that emphasises 2D overhead game-map aesthetic,
//                zone delineation, and Warhammer 40K grimdark visual style.
//                Added campaign_name and campaign_narrative params — these are
//                injected into the OpenAI prompt for thematic image generation.
//                Biome-specific prompt modifiers added for all 12 biomes.
//   2026-03-05 — Reworded the prompts to be more cinematic and aligned with the warhammer 40K universe
//                


import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type Layout = "ring" | "continent" | "radial" | "ship_line";

// ── Biome visual descriptors ──────────────────────────────────────────────────
// These are injected into the layout prompt to flavour terrain appearance.

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
// All prompts are written to produce top-down 2D tactical map imagery.

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
    "Hand-painted illustrated campaign map aesthetic — rich ink wash textures, painted borders between zones.",
    "Dark and grimdark colour palette for the core of the image:black, stone, dark iron grey, deep crimson, tarnished gold, sickly green warp energy.",
    "Vibrant colours to contrast zone territories: Toxic Orange, rich royal Purple, Deep magestic blue, Forrest Green, Heroic Yellow and Gold",
    "Clearly delineated zone territories separated by visible borders — roads, walls, rivers, energy barriers, or terrain breaks.",
    "The feel of the art should be for a faction commander strategically planning and directing a battle.",
    "Battle damage visible — craters, scorch marks, ruined buildings.",
    "No text overlays. No UI elements.",
    "Overhead Illustrated map — painterly, detailed, Cinematic.",
  ].join(" ");

  switch (layout) {
    case "ring": {
      return [
        `Top-down campaign map of a complete Ring or Halo World or part of a former Dyson Sphere set in Warhammer 40K as a megastructure, viewed from space.`,
        `${narrativeContext}${campaignNameContext}`,
        `${zone_count} clearly separated battle zones arranged around the ring, each zone visible as a distinct territory from directly above.`,
        `Terrain: ${biomeMod}`,
        `The ring is complete as a barely intact structure. The inner edge faces the central void — visible as a black abyss.`,
        `The outer edge shows the megastructure's superstructure frame — iron girders, plasma conduits, atmospheric vents.`,
        `The zones of the ring represent many of the 40K factions that have had influence of the the terrain (Imperium, Chaos, Xenos) but the age of the ring is much older indicating the presence of relics from the golden age of humanity.`,
        `Atmospheric haze, plasma glow from the ring's power conduits visible as amber light along the inner edge.`,
        sharedStyle,
      ].join(" ");
    }

    case "continent": {
      return [
        `Top-down campaign map of a Warhammer 40K planet with shattered continents, viewed from space.`,
        `${narrativeContext}${campaignNameContext}`,
        `${zone_count} clearly delineated territorial zones, each zone a distinct landmass plate separated from its neighbours by chasms, lava channels, collapsed terrain, or fortification lines.`,
        `Terrain: ${biomeMod}`,
        `The continent has a ragged coastlines or void-cliffs edge on their perimeter. or Rivers of lava or toxic sludge from long ago natural disasters.`,
        `Zone borders are marked by terrain features — not drawn lines. Natural breaks in terrain delineate each territory.`,
        `The continents of the planet represent many of the 40K factions that have had influence of the the terrain (Imperium, Chaos, Xenos) from wars long past and of the wars yet to come to fracture the contenents even more.`,
        sharedStyle,
      ].join(" ");
    }

    case "radial": {
      return [
        `Top-down campaign map of a disc floting in space that formed in a radial spoke pattern, viewed from above in space.`,
        `${narrativeContext}${campaignNameContext}`,
        `${zone_count} zones arranged radially — a central hub objective zone surrounded by spoke corridors extending outward to outer ring zones.`,
        `Terrain: ${biomeMod}`,
        `The central objective zone is the most heavily fortified and contested — a tower much older than the setting of the Warhammer 40K timeline still stands fortified yet abandond in the exact centre of the disc.`,
        `Each spoke corridor is a distinct battle zone flanked by ruins and terrain obstacles.`,
        `The outer zones are more wild and less fortified but equally dangerous and represent many of the 40K factions that have battled here in the past.`,
        sharedStyle,
      ].join(" ");
    }

    case "ship_line": {
      return [
        `Top-down tactical map of the interior of a colossal Warhammer 40K Gothic warship, viewed from above — like a building floor plan.`,
        `${narrativeContext}${campaignNameContext}`,
        `The warship hull is arranged bow (left) to stern (right) across the full width of the image.`,
        `${zone_count} clearly distinct interior combat zones along the hull — each zone is a major ship compartment: Command Bridge, Navigators Sanctum,  Astropathic Choir, Crew Quarters & Shrines, Plasma Drive & Reactors, Warp Drive, Geller Fields, Augur Arrays, Void Shields, Armoured Hull & Prow, Macro Cannons, High Energy Lances, Nova CAnnons, Torpedo Tubes, Launch Bays.`,
        `Plasma Drive & Reactors: These occupy up to a third of the ship's length, usually in the aft section. The reactors are massive enough to power entire hive cities.`,
        `Warp Drive: Essential for interstellar travel, this allows the ship to breach the barrier into the Immaterium.`,
        `Geller Field: A vital protective bubble that shields the ship and its crew from the predations of daemons while in the Warp.`,
        `Augur Arrays: The ship's primary sensory and scanning equipment for detecting enemies across the vastness of space. `,
        `Void Shields: Multiple layers of energy barriers that absorb incoming fire before it can reach the hull.`,
        `Armoured Hull: Often composed of meters-thick layers of adamantium and plasteel.`,
        `Armoured Prow: A massive slab of reinforced metal at the front, often used for ramming enemy vessels.`,
        `Macrocannons: Gigantic broadside batteries that fire building-sized shells at a significant fraction of the speed of light.`,
        `Lances: High-powered energy beams (lasers or plasma) designed to burn through the thickest enemy armour.`,
        `Nova Cannon: A rare and devastating prow-mounted weapon that fires a projectile capable of obliterating entire fleets.`,
        `Torpedo Tubes: Large tubes in the prow that launch massive self-propelled munitions.`,
        `Launch Bays: Hangar spaces housing squadrons of Fury Interceptors and Starhawk Bombers`,
        `The Bridge: The command centre, often located in a towering spire, from which the Captain and senior officers control the vessel.`,
        `Navigator’s Sanctum: A specialized chamber for the Navis Nobilite who steer the ship through the Warp.`,
        `Astropathic Choir: A dedicated area for psykers to send and receive interstellar communications.`,
        `Crew Quarters & Shrines: Living spaces for tens of thousands of personnel, ranging from opulent officer staterooms to squalid holds for press-ganged bondsmen, often interspersed with massive gothic cathedrals and shrines to the Emperor. `,
        `Each compartment is separated by thick armoured bulkheads and blast doors, clearly visible as thick dark walls.`,
        `Interior aesthetic: dark corroded iron deckplates, cathedral vaulted ceilings seen from above, glowing amber cogitator console banks, servo-skull stations, hanging incense braziers, purity scroll dispensers, weapon lockers.`,
        `The ship exterior hull outline is visible as a massive iron silhouette against the void of space — stars and nebula glow visible around the hull outline.`,
        `Battle damage within compartments: blast scorches, breached hull sections showing stars through holes, blood smears, toppled statues.`,
        `Each combat zone has multiple entry/exit points — corridors, access hatches, blast doors.`,
        `Engine plasma glow (deep blue-white) visible at stern end.`,
        sharedStyle,
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

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    // Auth — allow both authenticated calls and service-role background calls
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");

    if (authHeader) {
      const result = await requireUser(req);
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

    if (!map_id)      return json(400, { ok: false, error: "map_id required" });
    if (!campaign_id) return json(400, { ok: false, error: "campaign_id required" });

    // If authenticated user, verify they are lead/admin of this campaign
    if (userId) {
      const { data: mem } = await admin
        .from("campaign_members")
        .select("role")
        .eq("campaign_id", campaign_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!mem || !["lead", "admin"].includes(mem.role)) {
        return json(403, { ok: false, error: "Only the campaign Lead can regenerate the map." });
      }
    }

    // Mark map as generating
    await admin.from("maps").update({ status: "generating" }).eq("id", map_id);

    // Build the OpenAI prompt
    const prompt = buildPrompt({
      layout:             layout as Layout,
      zone_count,
      biome,
      mixed_biomes,
      campaign_name,
      campaign_narrative,
    });

    console.log(`[generate-map] campaign=${campaign_id} map=${map_id} layout=${layout} zones=${zone_count}`);
    console.log(`[generate-map] prompt length=${prompt.length}`);

    // Call OpenAI gpt-image-1
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      await admin.from("maps").update({ status: "failed" }).eq("id", map_id);
      return json(500, { ok: false, error: "OpenAI API key not configured" });
    }

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
        size:    "1536x1024",
        quality: "high",
      }),
    });

    if (!imageResp.ok) {
      const errText = await imageResp.text().catch(() => "unknown");
      console.error("[generate-map] OpenAI error:", errText);
      await admin.from("maps").update({ status: "failed" }).eq("id", map_id);
      return json(500, { ok: false, error: `OpenAI error: ${imageResp.status}` });
    }

    const imageData = await imageResp.json();
    const b64 = imageData?.data?.[0]?.b64_json as string | undefined;

    if (!b64) {
      await admin.from("maps").update({ status: "failed" }).eq("id", map_id);
      return json(500, { ok: false, error: "No image data returned from OpenAI" });
    }

    // Decode base64 to Uint8Array
    const raw    = atob(b64);
    const bytes  = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    // Upload to Supabase Storage
    // Path: campaign-maps/{campaign_id}/maps/{map_id}/bg.png
    const storagePath = `${campaign_id}/maps/${map_id}/bg.png`;

    const { error: uploadErr } = await admin.storage
      .from("campaign-maps")
      .upload(storagePath, bytes, {
        contentType: "image/png",
        upsert:      true,
      });

    if (uploadErr) {
      console.error("[generate-map] Storage upload error:", uploadErr.message);
      await admin.from("maps").update({ status: "failed" }).eq("id", map_id);
      return json(500, { ok: false, error: `Storage upload failed: ${uploadErr.message}` });
    }

    // Update map record with path and status
    const { error: updateErr } = await admin
      .from("maps")
      .update({
        image_path: storagePath,
        status:     "complete",
      })
      .eq("id", map_id);

    if (updateErr) {
      console.error("[generate-map] Map update error:", updateErr.message);
      return json(500, { ok: false, error: `Map update failed: ${updateErr.message}` });
    }

    console.log(`[generate-map] Complete. path=${storagePath}`);
    return json(200, { ok: true, map_id, image_path: storagePath });

  } catch (e: any) {
    console.error("[generate-map] Unexpected error:", e?.message ?? String(e));
    return json(500, { ok: false, error: e?.message ?? "Server error" });
  }
});
