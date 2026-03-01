import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json, requireUser, adminClient } from "../_shared/utils.ts";

const REDIRECT_URL = "https://40kcampaigngame.fun";

// ── Map zone definitions ─────────────────────────────────────────────────────

// 12 zones in canonical order.
// small = first 4, medium = first 8, large = all 12.
// These keys are the gameplay identifiers (movement, ownership, missions).
// Visual names are generated separately in generate-map.
const ALL_ZONES = [
  { key: "vault_ruins",         name: "Vault Ruins" },
  { key: "ash_wastes",          name: "Ash Wastes" },
  { key: "halo_spire",          name: "Halo Spire" },
  { key: "sunken_manufactorum", name: "Sunken Manufactorum" },
  { key: "warp_scar_basin",     name: "Warp Scar Basin" },
  { key: "obsidian_fields",     name: "Obsidian Fields" },
  { key: "signal_crater",       name: "Signal Crater" },
  { key: "xenos_forest",        name: "Xenos Forest" },
  { key: "blighted_reach",      name: "Blighted Reach" },
  { key: "iron_sanctum",        name: "Iron Sanctum" },
  { key: "null_fields",         name: "Null Fields" },
  { key: "ghost_harbor",        name: "Ghost Harbor" },
];

const SIZE_CONFIG: Record<string, {
  zone_count: number;
  max_players: number;
  zone_cols: number;
  zone_rows: number;
}> = {
  small:  { zone_count: 4,  max_players: 4,  zone_cols: 2, zone_rows: 2 },
  medium: { zone_count: 8,  max_players: 8,  zone_cols: 4, zone_rows: 2 },
  large:  { zone_count: 12, max_players: 12, zone_cols: 4, zone_rows: 3 },
};

// Sector labels — letters so keys are human-readable: vault_ruins:a, etc.
const SECTOR_LABELS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];

// ── Gameplay map generator (unchanged from original) ─────────────────────────

function generateMapJson(size: "small" | "medium" | "large", sectors_per_zone = 4) {
  const config = SIZE_CONFIG[size];
  const zones  = ALL_ZONES.slice(0, config.zone_count);
  const labels = SECTOR_LABELS.slice(0, sectors_per_zone);

  return {
    size,
    zone_count:       config.zone_count,
    sectors_per_zone,
    zone_cols:        config.zone_cols,
    zone_rows:        config.zone_rows,
    sector_cols:      2,
    sector_rows:      Math.ceil(sectors_per_zone / 2),
    max_players:      config.max_players,
    zones: zones.map((z) => ({
      key:  z.key,
      name: z.name,
      sectors: labels.map((s) => ({ key: `${z.key}:${s}` })),
    })),
  };
}

// ── Map generation parameter types ──────────────────────────────────────────

type Layout        = "ring" | "continent" | "radial" | "ship_line";
type PlanetMode    = "uniform" | "mixed";
type ShipClass     = "Frigate" | "Cruiser" | "Battleship";

interface PlanetProfile {
  mode: PlanetMode;
  uniformBiome?: string;
  biomes?: string[];
}

interface ShipProfile {
  class: ShipClass;
  name?: string; // generated server-side if omitted
}

// When layout is ship_line, zone_count is auto-set from ship class
const SHIP_CLASS_ZONES: Record<ShipClass, 4 | 8 | 12> = {
  Frigate:    4,
  Cruiser:    8,
  Battleship: 12,
};

const SIZE_FROM_ZONE_COUNT: Record<4 | 8 | 12, "small" | "medium" | "large"> = {
  4:  "small",
  8:  "medium",
  12: "large",
};

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")   return json(405, { ok: false, error: "Method not allowed" });

  const result = await requireUser(req);
  if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
  const user  = result.user;
  const admin = adminClient();

  const body = await req.json().catch(() => ({}));

  // ── Core campaign params (unchanged) ─────────────────────────────────────
  const template_id:     string = body?.template_id;
  const campaign_name:   string = body?.campaign_name;
  const player_emails:   string[] = Array.isArray(body?.player_emails) ? body.player_emails : [];
  const ruleset_id:      string | null = body?.ruleset_id ?? null;
  const rules_overrides: Record<string, unknown> = body?.rules_overrides ?? {};
  const invite_message:  string | null = typeof body?.invite_message === "string"
    ? body.invite_message.trim() || null : null;

  // ── Map size / layout params (new) ────────────────────────────────────────
  const campaign_size: "small" | "medium" | "large" =
    ["small", "medium", "large"].includes(body?.campaign_size)
      ? body.campaign_size : "medium";
  const sectors_per_zone: number =
    typeof body?.sectors_per_zone === "number" && body.sectors_per_zone > 0
      ? body.sectors_per_zone : 4;

  // Layout: ring | continent | radial | ship_line
  const layout: Layout =
    ["ring", "continent", "radial", "ship_line"].includes(body?.layout)
      ? body.layout : "ring";

  // Planet profile: { mode, uniformBiome?, biomes? }
  const planet_profile: PlanetProfile | undefined =
    body?.planet_profile && typeof body.planet_profile === "object"
      ? body.planet_profile : undefined;

  // Ship profile: { class, name? } — only used when layout is ship_line
  const raw_ship_profile: ShipProfile | undefined =
    body?.ship_profile && typeof body.ship_profile === "object"
      ? body.ship_profile : undefined;

  // For ship_line, zone_count is determined by ship class, not campaign_size
  const effective_zone_count: 4 | 8 | 12 =
    layout === "ship_line" && raw_ship_profile?.class
      ? SHIP_CLASS_ZONES[raw_ship_profile.class]
      : (SIZE_CONFIG[campaign_size]?.zone_count ?? 8) as 4 | 8 | 12;

  const effective_campaign_size: "small" | "medium" | "large" =
    layout === "ship_line"
      ? SIZE_FROM_ZONE_COUNT[effective_zone_count]
      : campaign_size;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!template_id || !campaign_name)
    return json(400, { ok: false, error: "Missing template_id or campaign_name" });
  if (typeof rules_overrides !== "object" || Array.isArray(rules_overrides))
    return json(400, { ok: false, error: "rules_overrides must be an object" });

  const { data: tpl, error: tplErr } = await admin
    .from("templates").select("id").eq("id", template_id).maybeSingle();
  if (tplErr) return json(500, { ok: false, error: "Template lookup failed", details: tplErr.message });
  if (!tpl)   return json(400, { ok: false, error: "Template not found" });

  if (ruleset_id) {
    const { data: rs, error: rsErr } = await admin
      .from("rulesets").select("id").eq("id", ruleset_id).maybeSingle();
    if (rsErr) return json(500, { ok: false, error: "Ruleset lookup failed", details: rsErr.message });
    if (!rs)   return json(400, { ok: false, error: "Ruleset not found" });
  }

  // ── Create gameplay map (zones/sectors) ───────────────────────────────────
  const mapJson = generateMapJson(effective_campaign_size, sectors_per_zone);

  const { data: mapRow, error: mapErr } = await admin
    .from("maps")
    .insert({
      name:              `${String(campaign_name)} Map (${effective_campaign_size})`,
      description:       `Auto-generated ${effective_campaign_size} map — ${mapJson.zone_count} zones, ${sectors_per_zone} sectors/zone`,
      map_json:          mapJson,
      is_active:         true,
      created_by:        user.id,
      version:           1,
      // Map generation metadata (new columns)
      layout,
      zone_count:        effective_zone_count,
      planet_profile:    layout !== "ship_line" ? (planet_profile ?? null) : null,
      ship_profile:      layout === "ship_line"  ? (raw_ship_profile ?? null) : null,
      art_version:       "grimdark-v1",
      generation_status: "pending",
      // Seed = timestamp + campaign_name hash for determinism
      seed: `${Date.now()}_${String(campaign_name).toLowerCase().replace(/\s+/g, "_")}`,
    })
    .select("id, seed")
    .single();

  if (mapErr || !mapRow)
    return json(500, { ok: false, error: "Map creation failed", details: mapErr?.message });

  // ── Create campaign linked to the map ─────────────────────────────────────
  const { data: campaign, error: cErr } = await admin
    .from("campaigns")
    .insert({
      template_id,
      name:            String(campaign_name),
      phase:           1,
      round_number:    1,
      instability:     0,
      ruleset_id,
      rules_overrides,
      map_id:          mapRow.id,
      invite_message,
    })
    .select()
    .single();

  if (cErr || !campaign) {
    await admin.from("maps").delete().eq("id", mapRow.id); // rollback map
    return json(500, { ok: false, error: "Campaign insert failed", details: cErr?.message });
  }

  // ── Add creator as lead ───────────────────────────────────────────────────
  const { error: memErr } = await admin.from("campaign_members").insert({
    campaign_id: campaign.id,
    user_id:     user.id,
    role:        "lead",
  });
  if (memErr)
    return json(500, { ok: false, error: "Lead membership insert failed", details: memErr.message });

  // ── Handle initial player invites ─────────────────────────────────────────
  const emails = player_emails
    .map((e: unknown) => String(e).trim().toLowerCase())
    .filter(Boolean);

  if (emails.length) {
    const { error: invErr } = await admin
      .from("pending_invites")
      .insert(emails.map((email: string) => ({ campaign_id: campaign.id, email })));
    if (invErr)
      return json(500, { ok: false, error: "Invite insert failed", details: invErr.message });

    for (const email of emails) {
      try {
        const { error: authErr } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${REDIRECT_URL}?campaign_invite=1`,
          data: {
            campaign_id:    campaign.id,
            campaign_name:  String(campaign_name),
            invite_message: invite_message ?? "",
          },
        });
        if (authErr) {
          const alreadyExists =
            authErr.message.toLowerCase().includes("already") ||
            authErr.message.toLowerCase().includes("registered") ||
            authErr.message.toLowerCase().includes("exists");

          if (alreadyExists) {
            // Existing user — send OTP magic-link so they get notified
            try {
              const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
              const serviceKey  = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
              await fetch(`${supabaseUrl}/auth/v1/otp`, {
                method:  "POST",
                headers: {
                  "Content-Type":  "application/json",
                  "apikey":        serviceKey,
                  "Authorization": `Bearer ${serviceKey}`,
                },
                body: JSON.stringify({
                  email,
                  create_user: false,
                  options: {
                    redirectTo: `${REDIRECT_URL}?campaign_invite=1`,
                    data: {
                      campaign_id:    campaign.id,
                      campaign_name:  String(campaign_name),
                      invite_message: invite_message ?? "",
                    },
                  },
                }),
              });
            } catch (otpErr: unknown) {
              const msg = otpErr instanceof Error ? otpErr.message : String(otpErr);
              console.warn(`OTP fallback failed for ${email}: ${msg}`);
            }
          } else {
            console.warn(`Invite email failed for ${email}: ${authErr.message}`);
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Invite email exception for ${email}: ${msg}`);
      }
    }
  }

  // ── Trigger AI map image generation (fire-and-forget) ────────────────────
  // We don't await this — it runs in the background after we return.
  // The map page polls generation_status on the maps row to know when it's ready.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey  = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

  const generateMapBody = JSON.stringify({
    map_id:         mapRow.id,
    campaign_id:    campaign.id,
    seed:           mapRow.seed,
    layout,
    zone_count:     effective_zone_count,
    planet_profile: layout !== "ship_line" ? (planet_profile ?? null) : null,
    ship_profile:   layout === "ship_line"  ? (raw_ship_profile ?? null) : null,
    art_version:    "grimdark-v1",
  });

  // EdgeRuntime.waitUntil keeps the background fetch alive after the response is sent
  const generatePromise = fetch(`${supabaseUrl}/functions/v1/generate-map`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: generateMapBody,
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("generate-map trigger failed:", msg);
  });

  try {
    // @ts-ignore — EdgeRuntime is available in Supabase Deno environment
    EdgeRuntime.waitUntil(generatePromise);
  } catch {
    // Fallback: just let the fetch run (may be cut off in local dev — that's ok)
  }

  // ── Return immediately with campaign + map IDs ────────────────────────────
  return json(200, {
    ok:               true,
    campaign_id:      campaign.id,
    map_id:           mapRow.id,
    map_size:         effective_campaign_size,
    layout,
    zones:            effective_zone_count,
    sectors_per_zone,
    generation_status: "pending",  // image is generating in background
  });
});
