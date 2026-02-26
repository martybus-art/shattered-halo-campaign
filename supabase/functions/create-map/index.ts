import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

type MapJson = {
  zones: Array<{ id: string; name: string; sectors: Array<{ id: string; name?: string }> }>;
  [k: string]: unknown;
};

function validateMap(map: MapJson, maxPlayers: number) {
  if (!map || !Array.isArray(map.zones)) throw new Error("map_json must include zones[]");
  for (const z of map.zones) {
    if (!z?.id) throw new Error("Each zone needs an id");
    if (!Array.isArray(z.sectors)) throw new Error(`Zone ${z.id} missing sectors[]`);
    if (z.sectors.length !== 4) throw new Error(`Zone ${z.id} must have exactly 4 sectors (2x2)`);
    for (const s of z.sectors) if (!s?.id) throw new Error(`Zone ${z.id} has a sector without id`);
  }
  const totalSectors = map.zones.reduce((n, z) => n + z.sectors.length, 0);
  if (totalSectors < maxPlayers * 3) throw new Error(`Map too small: sectors=${totalSectors} (need >= ${maxPlayers * 3})`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    // ✅ moved inside handler, correct auth pattern
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorised" });
    const user = result.user;

    const admin = adminClient(); // ✅ moved inside handler

    const body = await req.json().catch(() => ({}));
    const campaign_id = body.campaign_id as string | undefined;
    const name = (body.name ?? "Custom Map") as string;
    const description = (body.description ?? null) as string | null;
    const map_json = body.map_json as MapJson | undefined;
    const image_path = (body.image_path ?? null) as string | null;

    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });
    if (!map_json) return json(400, { ok: false, error: "Missing map_json" });

    const { data: mem } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)      // ✅ user.id
      .maybeSingle();

    if (!mem) return json(403, { ok: false, error: "Not a member" });
    if (mem.role !== "lead") return json(403, { ok: false, error: "Only lead can upload/attach maps" });

    const maxPlayers = 8;
    validateMap(map_json, maxPlayers);

    const { data: mapRow, error: mErr } = await admin
      .from("maps")
      .insert({
        name,
        description,
        map_json,
        image_path,
        visibility: "private",
        recommended_players: maxPlayers,
        max_players: maxPlayers,
        created_by: user.id,       // ✅ user.id
      })
      .select("id")
      .single();

    if (mErr) return json(500, { ok: false, error: mErr.message });

    const { error: uErr } = await admin.from("campaigns").update({ map_id: mapRow.id }).eq("id", campaign_id);
    if (uErr) return json(500, { ok: false, error: uErr.message });

    return json(200, { ok: true, map_id: mapRow.id });
  } catch (e) {
    return json(400, { ok: false, error: (e as Error).message });
  }
});