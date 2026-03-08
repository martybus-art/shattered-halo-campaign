// supabase/functions/form-alliance/index.ts
//
// changelog:
//   2026-03-08 — Created. Called by the accepting player to finalise a ceasefire.
//                Validates the active proposal, sets conflict.status = 'allied',
//                clears alliance_proposed_by, and inserts a public War Bulletin
//                post announcing the pact.
//
// Body: { conflict_id: string }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const body = await req.json().catch(() => ({}));
    const conflict_id: string | undefined = body?.conflict_id;

    if (!conflict_id) return json(400, { ok: false, error: "Missing conflict_id" });

    const admin = adminClient();

    // ── Load conflict ────────────────────────────────────────────────────────
    const { data: conflict, error: confErr } = await admin
      .from("conflicts")
      .select("id, campaign_id, round_number, zone_key, sector_key, player_a, player_b, status, alliance_proposed_by")
      .eq("id", conflict_id)
      .single();

    if (confErr || !conflict) return json(404, { ok: false, error: "Conflict not found" });

    if (conflict.status !== "scheduled") {
      return json(400, { ok: false, error: "Conflict is not in a negotiable state" });
    }

    const isPlayerA = conflict.player_a === user.id;
    const isPlayerB = conflict.player_b === user.id;

    if (!isPlayerA && !isPlayerB) {
      return json(403, { ok: false, error: "Not a participant of this conflict" });
    }

    // The caller must be the OPPONENT — i.e. they are accepting, not self-accepting
    if (conflict.alliance_proposed_by === null) {
      return json(400, { ok: false, error: "No active proposal for this conflict" });
    }
    if (conflict.alliance_proposed_by === user.id) {
      return json(400, { ok: false, error: "Cannot accept your own proposal" });
    }

    const campaign_id   = conflict.campaign_id;
    const round_number  = conflict.round_number;

    // ── Load member faction names for the bulletin post ──────────────────────
    const { data: members } = await admin
      .from("campaign_members")
      .select("user_id, faction_name, commander_name")
      .eq("campaign_id", campaign_id)
      .in("user_id", [conflict.player_a, conflict.player_b]);

    const memberLabel = (uid: string): string => {
      const m = (members ?? []).find((x: any) => x.user_id === uid);
      return m?.faction_name ?? m?.commander_name ?? uid.slice(0, 8) + "…";
    };

    const factionA = memberLabel(conflict.player_a);
    const factionB = memberLabel(conflict.player_b);
    const zoneDisplay = conflict.zone_key.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase());
    const sectorDisplay = conflict.sector_key.toUpperCase();

    // ── Mark conflict as allied ──────────────────────────────────────────────
    const { error: updateErr } = await admin
      .from("conflicts")
      .update({ status: "allied", alliance_proposed_by: null })
      .eq("id", conflict_id);

    if (updateErr) {
      console.error("form-alliance: update error:", updateErr.message);
      return json(500, { ok: false, error: updateErr.message });
    }

    // ── Post announcement to War Bulletin ────────────────────────────────────
    const title = `Ceasefire Pact — ${zoneDisplay} : ${sectorDisplay}`;
    const body_text = [
      `In the shadow of ruin and gunsmoke, the commanders of ${factionA} and ${factionB} have reached across the battlefield with the sign of parley.`,
      "",
      `Rather than shed further blood in ${zoneDisplay} — Sector ${sectorDisplay} — the two factions have declared a ceasefire pact. No shots were fired. No ground changed hands. The engagement scheduled for Round ${round_number} has been stood down by mutual accord.`,
      "",
      `Whether this alliance holds or fractures in the campaigns ahead remains to be seen. The war continues — but for now, two warbands walk away from the brink.`,
      "",
      `⚔ Pact signatories: ${factionA}  ·  ${factionB}`,
    ].join("\n");

    const { error: postErr } = await admin.from("posts").insert({
      campaign_id,
      round_number,
      visibility: "public",
      title,
      body: body_text,
      tags: ["alliance"],
      created_by: user.id,
    });

    if (postErr) {
      // Non-fatal: the conflict is already allied, just log the bulletin failure
      console.error("form-alliance: bulletin post failed:", postErr.message);
    }

    console.log(`form-alliance: conflict=${conflict_id} allied by=${user.id} proposer=${conflict.alliance_proposed_by}`);

    return json(200, {
      ok: true,
      status: "allied",
      message: "Ceasefire pact formed — announcement posted to the War Bulletin.",
    });

  } catch (e: any) {
    console.error("form-alliance error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
