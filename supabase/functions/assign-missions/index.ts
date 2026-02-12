import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: uErr } = await userClient.auth.getUser();
    if (uErr || !userData.user) return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), { status: 401 });

    const body = await req.json().catch(() => ({}));
    const campaignId = body.campaign_id as string;
    if (!campaignId) return new Response(JSON.stringify({ ok: false, error: "campaign_id required" }), { status: 400 });

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: mem } = await admin.from("campaign_members").select("role").eq("campaign_id", campaignId).eq("user_id", userData.user.id).maybeSingle();
    const role = mem?.role ?? "player";
    if (!(role === "lead" || role === "admin")) return new Response(JSON.stringify({ ok: false, error: "Not authorised" }), { status: 403 });

    const { data: c, error: cErr } = await admin.from("campaigns").select("id,template_id,round_number,phase,instability").eq("id", campaignId).single();
    if (cErr || !c) throw cErr ?? new Error("Campaign not found");

    const { data: conflicts, error: coErr } = await admin
      .from("conflicts")
      .select("id,zone_key,sector_key,mission_id,mission_status")
      .eq("campaign_id", campaignId)
      .eq("round_number", c.round_number);

    if (coErr) throw coErr;

    const { data: missions, error: mErr } = await admin
      .from("missions")
      .select("id,name,description,mission_type,phase_min,zone_tags")
      .eq("template_id", c.template_id)
      .eq("is_active", true);

    if (mErr) throw mErr;
    const pool = (missions ?? []).filter((m: any) => (m.phase_min ?? 1) <= (c.phase ?? 1));

    const results: any[] = [];

    for (const conf of (conflicts ?? [])) {
      if (conf.mission_id) continue;

      const tagged = pool.filter((m: any) => Array.isArray(m.zone_tags) ? m.zone_tags.includes(conf.zone_key) : false);
      let candidates = tagged.length ? tagged : pool;

      const { data: infl } = await admin
        .from("mission_influence")
        .select("influence_type,nip_spent,payload,created_at,user_id")
        .eq("conflict_id", conf.id)
        .order("created_at", { ascending: true });

      const influences = infl ?? [];

      const vetoes = influences.filter((x: any) => x.influence_type === "veto");
      for (const _v of vetoes) {
        if (candidates.length > 1) {
          const drop = rand(candidates);
          candidates = candidates.filter((m: any) => m.id !== drop.id);
        }
      }

      const choose = influences.find((x: any) => x.influence_type === "choose" && x.payload?.mission_id);
      let chosen: any = null;

      if (choose) {
        const wanted = candidates.find((m: any) => m.id === choose.payload.mission_id) || pool.find((m: any) => m.id === choose.payload.mission_id);
        if (wanted) chosen = wanted;
      }

      if (!chosen) {
        const pref = influences.find((x: any) => x.influence_type === "preference");
        if (pref && candidates.length >= 2) {
          const a = rand(candidates);
          let b = rand(candidates);
          if (b.id == a.id && candidates.length > 1) b = candidates.find((m: any) => m.id !== a.id) ?? b;
          chosen = rand([a, b]);
        }
      }

      if (!chosen) chosen = rand(candidates.length ? candidates : pool);

      if (!chosen) continue;

      const { error: upErr } = await admin
        .from("conflicts")
        .update({ mission_id: chosen.id, mission_status: "assigned" })
        .eq("id", conf.id);

      if (upErr) throw upErr;

      const twists = influences.filter((x: any) => x.influence_type === "twist");
      if (twists.length) {
        const tnames = twists.map((t: any) => t.payload?.twist ?? "unknown_twist");
        await admin.from("posts").insert({
          campaign_id: campaignId,
          round_number: c.round_number,
          visibility: "public",
          title: "Mission Twist Declared",
          body: `A battlefield twist has been invoked for this engagement: ${tnames.join(", ")}.`,
          tags: ["twist", "mission"],
          created_by: userData.user.id
        });
      }

      results.push({ conflict_id: conf.id, mission_id: chosen.id, mission_name: chosen.name });
    }

    return new Response(JSON.stringify({ ok: true, assigned: results.length, results }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
});
