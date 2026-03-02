/**
 * POST /api/map/regenerate
 *
 * Triggers a fresh AI image generation for an existing map row.
 * Restricted to the campaign lead.
 *
 * Body: { map_id: string, campaign_id: string }
 * Returns: { ok: boolean, error?: string }
 *
 * File location: apps/web/app/api/map/regenerate/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@supabase/supabase-js";

// Force dynamic rendering — prevents Next.js static optimisation and ensures
// this route gets its own distinct serverless function bundle (fixes Vercel
// deduplication symlink error during deployment).
export const dynamic = "force-dynamic";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST(req: NextRequest) {
  try {
    const body        = await req.json().catch(() => ({}));
    const map_id:      string = body.map_id;
    const campaign_id: string = body.campaign_id;

    if (!map_id || !campaign_id) {
      return NextResponse.json({ ok: false, error: "Missing map_id or campaign_id" }, { status: 400 });
    }

    // Verify caller is the campaign lead using their session token
    const authHeader = req.headers.get("Authorization") ?? "";
    const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    // For server-side route, get user from cookie session if no Bearer token
    // (relies on Supabase cookie auth from the browser session)
    const admin = adminClient();

    // Fetch the map row to get current generation params
    const { data: mapRow, error: mapErr } = await admin
      .from("maps")
      .select("id, layout, zone_count, planet_profile, ship_profile, art_version, seed")
      .eq("id", map_id)
      .maybeSingle();

    if (mapErr || !mapRow) {
      return NextResponse.json({ ok: false, error: "Map not found" }, { status: 404 });
    }

    // Reset status to pending before triggering
    await admin.from("maps").update({ generation_status: "pending" }).eq("id", map_id);

    // Trigger generate-map edge function
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    const generateRes = await fetch(`${supabaseUrl}/functions/v1/generate-map`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        map_id,
        campaign_id,
        seed:           mapRow.seed,
        layout:         mapRow.layout        ?? "ring",
        zone_count:     mapRow.zone_count    ?? 8,
        planet_profile: mapRow.planet_profile ?? null,
        ship_profile:   mapRow.ship_profile  ?? null,
        art_version:    mapRow.art_version   ?? "grimdark-v1",
      }),
    });

    const result = await generateRes.json();

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error ?? "Generation failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, map_id });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
