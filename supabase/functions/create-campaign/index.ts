import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json, requireUser, adminClient } from "../_shared/utils.ts";

const REDIRECT_URL = "https://40kcampaigngame.fun";

// ── Map generation ────────────────────────────────────────────────────────────
// 12 zones in order — slice to count based on campaign size.
// small = first 4, medium = first 8, large = all 12.
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

const SIZE_CONFIG: Record<string, { zone_count: number; max_players: number; zone_cols: number; zone_rows: number }> = {
  small:  { zone_count: 4,  max_players: 4,  zone_cols: 2, zone_rows: 2 },
  medium: { zone_count: 8,  max_players: 8,  zone_cols: 4, zone_rows: 2 },
  large:  { zone_count: 12, max_players: 12, zone_cols: 4, zone_rows: 3 },
};

// Sector labels — letters so keys are human-readable (vault_ruins:a, vault_ruins:b, …)
const SECTOR_LABELS = ["a","b","c","d","e","f","g","h","i","j","k","l"];

function generateMapJson(size: "small"|"medium"|"large", sectors_per_zone = 4) {
  const config = SIZE_CONFIG[size];
  const zones  = ALL_ZONES.slice(0, config.zone_count);
  const labels = SECTOR_LABELS.slice(0, sectors_per_zone);

  return {
    size,
    zone_count: config.zone_count,
    sectors_per_zone,
    // Zone grid layout — how zones are arranged on the campaign map
    zone_cols: config.zone_cols,
    zone_rows: config.zone_rows,
    // Sector grid layout within each zone
    sector_cols: 2,
    sector_rows: Math.ceil(sectors_per_zone / 2),
    max_players: config.max_players,
    zones: zones.map((z) => ({
      key: z.key,
      name: z.name,
      sectors: labels.map((s) => ({ key: `${z.key}:${s}` })),
    })),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const result = await requireUser(req);
  if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
  const user = result.user;
  const admin = adminClient();

  const body = await req.json().catch(() => ({}));
  const template_id     = body?.template_id;
  const campaign_name   = body?.campaign_name;
  const player_emails   = Array.isArray(body?.player_emails) ? body.player_emails : [];
  const ruleset_id      = body?.ruleset_id ?? null;
  const rules_overrides = body?.rules_overrides ?? {};
  const invite_message  = typeof body?.invite_message === "string"
    ? body.invite_message.trim() || null : null;

  const campaign_size: "small"|"medium"|"large" =
    ["small","medium","large"].includes(body?.campaign_size) ? body.campaign_size : "medium";
  const sectors_per_zone: number =
    typeof body?.sectors_per_zone === "number" && body.sectors_per_zone > 0
      ? body.sectors_per_zone : 4;

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

  // Generate and insert the map
  const mapJson = generateMapJson(campaign_size, sectors_per_zone);

  const { data: mapRow, error: mapErr } = await admin
    .from("maps")
    .insert({
      name: `${String(campaign_name)} Map (${campaign_size})`,
      description: `Auto-generated ${campaign_size} map — ${mapJson.zone_count} zones, ${sectors_per_zone} sectors/zone`,
      map_json: mapJson,
      is_active: true,
      created_by: user.id,
      version: 1,
    })
    .select("id")
    .single();

  if (mapErr || !mapRow)
    return json(500, { ok: false, error: "Map creation failed", details: mapErr?.message });

  // Create campaign linked to the new map
  const { data: campaign, error: cErr } = await admin
    .from("campaigns")
    .insert({
      template_id,
      name: String(campaign_name),
      phase: 1,
      round_number: 1,
      instability: 0,
      ruleset_id,
      rules_overrides,
      map_id: mapRow.id,
      invite_message,
    })
    .select()
    .single();

  if (cErr || !campaign) {
    await admin.from("maps").delete().eq("id", mapRow.id); // rollback map
    return json(500, { ok: false, error: "Campaign insert failed", details: cErr?.message });
  }

  // Add creator as lead
  const { error: memErr } = await admin.from("campaign_members").insert({
    campaign_id: campaign.id,
    user_id: user.id,
    role: "lead",
  });
  if (memErr)
    return json(500, { ok: false, error: "Lead membership insert failed", details: memErr.message });

  // Handle initial invites
  const emails = player_emails
    .map((e: any) => String(e).trim().toLowerCase())
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
          data: { campaign_id: campaign.id, campaign_name: String(campaign_name), invite_message: invite_message ?? "" },
        });
        if (authErr) {
          const alreadyExists =
            authErr.message.toLowerCase().includes("already") ||
            authErr.message.toLowerCase().includes("registered") ||
            authErr.message.toLowerCase().includes("exists");
          if (alreadyExists) {
            // Existing user — inviteUserByEmail won't email them.
            // Send an OTP magic-link so they receive a notification.
            try {
              const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
              const serviceKey  = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
              await fetch(`${supabaseUrl}/auth/v1/otp`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "apikey": serviceKey,
                  "Authorization": `Bearer ${serviceKey}`,
                },
                body: JSON.stringify({
                  email,
                  create_user: false,
                  options: {
                    redirectTo: `${REDIRECT_URL}?campaign_invite=1`,
                    data: { campaign_id: campaign.id, campaign_name: String(campaign_name), invite_message: invite_message ?? "" },
                  },
                }),
              });
            } catch (otpErr: any) {
              console.warn(`OTP fallback failed for ${email}: ${otpErr?.message}`);
            }
          } else {
            console.warn(`invite email failed for ${email}: ${authErr.message}`);
          }
        }
      } catch (e: any) {
        console.warn(`invite email exception for ${email}: ${e?.message}`);
      }
    }
  }

  return json(200, {
    ok: true,
    campaign_id: campaign.id,
    map_id: mapRow.id,
    map_size: campaign_size,
    zones: mapJson.zone_count,
    sectors_per_zone,
  });
});
