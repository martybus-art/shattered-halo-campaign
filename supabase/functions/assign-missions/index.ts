import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { campaign_id } = (await req.json()) as { campaign_id: string };

    const { data: campaign, error: cErr } = await supabase
      .from("campaigns")
      .select("id, template_id, round_number, phase")
      .eq("id", campaign_id)
      .single();
    if (cErr) throw cErr;

    // Fetch conflicts needing mission assignment
    const { data: conflicts, error: confErr } = await supabase
      .from("conflicts")
      .select("id, zone_key, sector_key, mission_status")
      .eq("campaign_id", campaign_id)
      .eq("round_number", campaign.round_number)
      .in("mission_status", ["unassigned", "pending_influence"]);
    if (confErr) throw confErr;

    // Pull active missions for this phase
    const { data: missions, error: mErr } = await supabase
      .from("missions")
      .select("id, name, phase_min, zone_tags, mission_type, description")
      .eq("template_id", campaign.template_id)
      .eq("is_active", true);
    if (mErr) throw mErr;

    const phaseMissions = missions.filter((m) => (m.phase_min ?? 1) <= campaign.phase);

    const chooseRandom = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

    for (const conf of conflicts ?? []) {
      // If players used influence, read influence rows and apply the highest priority rule:
      // choose (3 NIP) > preference (2 NIP) > veto (2 NIP) > none
      const { data: infl } = await supabase
        .from("mission_influence")
        .select("influence_type, payload, nip_spent, user_id")
        .eq("conflict_id", conf.id);

      let missionId: string | null = null;
      const inflArr = infl ?? [];

      const choose = inflArr.find((x) => x.influence_type === "choose" && (x.payload as any)?.mission_id);
      if (choose) missionId = (choose.payload as any).mission_id;

      if (!missionId) {
        // preference expects payload: {mission_ids:[...]} already drawn client-side or via helper; fallback:
        const pref = inflArr.find((x) => x.influence_type === "preference");
        if (pref && (pref.payload as any)?.mission_id) missionId = (pref.payload as any).mission_id;
      }

      if (!missionId) {
        // veto just forces reroll - handled by client; if present, we still randomize here once.
        const candidates = phaseMissions;
        missionId = candidates.length ? chooseRandom(candidates).id : null;
      }

      if (!missionId) continue;

      await supabase
        .from("conflicts")
        .update({ mission_id: missionId, mission_status: "assigned" })
        .eq("id", conf.id);
    }

    return new Response(JSON.stringify({ ok: true, assigned: (conflicts ?? []).length }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
});
