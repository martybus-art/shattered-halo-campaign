import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type CreateCampaignBody = {
  template_id: string;
  campaign_name: string;
  player_emails?: string[];
};

const ZONES = [
  "vault_ruins",
  "ash_wastes",
  "halo_spire",
  "sunken_manufactorum",
  "warp_scar_basin",
  "obsidian_fields",
  "signal_crater",
  "xenos_forest",
] as const;

const SECTORS = ["A1", "A2", "B1", "B2"] as const;

function pickUnique<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: uErr } = await userClient.auth.getUser();
    if (uErr || !userData.user) {
      return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), { status: 401 });
    }

    const creatorId = userData.user.id;
    const creatorEmail = (userData.user.email ?? "").toLowerCase().trim();
    if (!creatorEmail) {
      return new Response(JSON.stringify({ ok: false, error: "Creator has no email" }), { status: 400 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const body = (await req.json()) as CreateCampaignBody;
    const templateId = body.template_id;
    const campaignName = body.campaign_name?.trim();
    const playerEmails = (body.player_emails ?? [])
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (!templateId || !campaignName) {
      return new Response(JSON.stringify({ ok: false, error: "template_id and campaign_name required" }), { status: 400 });
    }

    const { data: campaign, error: cErr } = await admin
      .from("campaigns")
      .insert({ template_id: templateId, name: campaignName, phase: 1, round_number: 1, instability: 0, status: "active" })
      .select("*")
      .single();
    if (cErr) throw cErr;

    // Seed sectors (32)
    const sectorRows = [];
    for (const z of ZONES) for (const s of SECTORS) sectorRows.push({ campaign_id: campaign.id, zone_key: z, sector_key: s });
    const { error: sErr } = await admin.from("sectors").insert(sectorRows);
    if (sErr) throw sErr;

    // Create round 1
    const { error: rErr } = await admin.from("rounds").insert({ campaign_id: campaign.id, round_number: 1, stage: "movement" });
    if (rErr) throw rErr;

    // Creator becomes lead
    const { error: mErr } = await admin.from("campaign_members").insert({
      campaign_id: campaign.id,
      user_id: creatorId,
      role: "lead",
    });
    if (mErr) throw mErr;

    // Starting location for creator
    const allStartSlots = [];
    for (const z of ZONES) for (const s of SECTORS) allStartSlots.push({ z, s });
    const picks = pickUnique(allStartSlots, Math.max(1, 1 + playerEmails.length));
    const creatorPick = picks[0] ?? { z: "vault_ruins", s: "A1" };

    const { error: psErr } = await admin.from("player_state").insert({
      campaign_id: campaign.id,
      user_id: creatorId,
      current_zone_key: creatorPick.z,
      current_sector_key: creatorPick.s,
      nip: 3,
      ncp: 0,
      status: "normal",
      last_active_at: new Date().toISOString(),
    });
    if (psErr) throw psErr;

    // Pending invites for others (resolved when they sign in and accept-invites runs)
    const inviteRows = Array.from(new Set(playerEmails))
      .filter((e) => e !== creatorEmail)
      .map((email) => ({
        campaign_id: campaign.id,
        email,
        role: "player",
        created_by: creatorId,
      }));

    if (inviteRows.length) {
      await admin.from("pending_invites").upsert(inviteRows, { onConflict: "campaign_id,email" });
    }

    await admin.from("posts").insert({
      campaign_id: campaign.id,
      round_number: 1,
      visibility: "public",
      title: "The Halo Stirs",
      body: "A new expedition has made planetfall upon the Shattered Halo. Vox-chatter is fractured. Auspex returns lie. The war begins in whispers.",
      tags: ["event", "campaign-start"],
      created_by: creatorId,
    });

    return new Response(JSON.stringify({ ok: true, campaign_id: campaign.id }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
});
