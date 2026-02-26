import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

const FACTIONS: Record<string, string> = {
  space_marines: "Space Marines",
  adeptus_mechanicus: "Adeptus Mechanicus",
  astra_militarum: "Astra Militarum",
  adeptus_custodes: "Adeptus Custodes",
  sisters_of_battle: "Adepta Sororitas",
  imperial_knights: "Imperial Knights",
  grey_knights: "Grey Knights",
  chaos_space_marines: "Chaos Space Marines",
  death_guard: "Death Guard",
  thousand_sons: "Thousand Sons",
  world_eaters: "World Eaters",
  chaos_daemons: "Chaos Daemons",
  chaos_knights: "Chaos Knights",
  aeldari: "Aeldari",
  drukhari: "Drukhari",
  necrons: "Necrons",
  orks: "Orks",
  tau_empire: "T'au Empire",
  tyranids: "Tyranids",
  genestealer_cults: "Genestealer Cults",
  leagues_of_votann: "Leagues of Votann",
};



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const { userId } = await requireUser(req);
  if (!userId) return json(401, { ok: false, error: "Unauthorized" });

  const admin = adminClient();
  const body = await req.json().catch(() => ({}));

  const campaign_id = body?.campaign_id;
  const faction_key = String(body?.faction_key ?? "").trim();

  if (!campaign_id || !faction_key) return json(400, { ok: false, error: "Missing campaign_id or faction_key" });
  const faction_name = FACTIONS[faction_key];
  if (!faction_name) return json(400, { ok: false, error: "Unknown faction_key" });

  const { data: mem, error: mErr } = await admin
    .from("campaign_members")
    .select("campaign_id,user_id,faction_key,faction_locked")
    .eq("campaign_id", campaign_id)
    .eq("user_id", userId.id)
    .maybeSingle();

  if (mErr) return json(500, { ok: false, error: "Membership lookup failed", details: mErr.message });
  if (!mem) return json(403, { ok: false, error: "Not a campaign member" });

  if (mem.faction_locked || mem.faction_key) {
    return json(409, { ok: false, error: "Faction is locked. Ask the lead player to change it." });
  }

  const { error: uErr } = await admin
    .from("campaign_members")
    .update({ faction_key, faction_name, faction_locked: true, faction_set_at: new Date().toISOString() })
    .eq("campaign_id", campaign_id)
    .eq("user_id", userId.id);

  if (uErr) return json(500, { ok: false, error: "Update failed", details: uErr.message });

  return json(200, { ok: true, faction_key, faction_name });
});
