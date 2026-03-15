// supabase/functions/evaluate-zone-effects/index.ts
// Evaluates sector ownership in every zone of a campaign, determines whether
// each player has crossed a benefit threshold, writes new reveal rows, and
// posts War Bulletin entries for newly-revealed effects.
//
// Called by: advance-round (automatically after each stage advance), OR
//            directly by the lead via the Admin Panel for a manual re-check.
//
// Threshold rules (matches game design spec):
//   MAJOR  = player controls ALL sectors in a zone
//   MINOR  = player controls >= ceil(zoneSize / 2) sectors in a zone
//            (if two players are both at the minor threshold, both get minor)
//   GLOBAL = all OTHER players who do NOT qualify for minor or major in that
//            zone — triggered only once a DIFFERENT player achieves major
//            control (i.e. the global benefit is the "consolation" for players
//            who are locked out of a fully-controlled zone)
//
// Idempotent: zone_effect_reveals has a UNIQUE(campaign_id, zone_key, user_id,
// tier) constraint. Re-running never duplicates reveals or bulletin posts —
// existing reveals are detected before inserting.
//
// Returns: { ok: true, newReveals: number, bulletin_posts: number }
//
// changelog:
//   2026-03-15 -- FIX: Updated ZoneEffectRow type and campaign_zone_effects select
//                 to use real DB column names: minor_charges_used, major_charges_used,
//                 global_charges_used (integers) instead of the boolean/nullable
//                 columns from the original DDL draft. Removed zone_effect_events
//                 writes — charge tracking is done via integer columns on
//                 campaign_zone_effects, not a separate events table.
//   2026-03-15 -- Initial creation. Implements fog-of-war reveal engine for
//                 the zone effects system (migration 009). Reads sector counts
//                 from the sectors table (same RLS-bypassed adminClient used
//                 throughout the codebase). Posts public War Bulletin entries
//                 tagged ["zone_effect"] when a new reveal is written.
//                 Posts a private bulletin to the controlling player when they
//                 are close to (but haven't reached) the major threshold, as an
//                 incentive to expand (major benefit teaser).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ZoneEffectRow = {
  id:                   string;
  zone_key:             string;
  zone_name:            string;
  zone_effect_id:       string;
  minor_charges_used:   number;
  major_charges_used:   number;
  global_charges_used:  number;
  zone_effects: {
    slug:           string;
    name:           string;
    scope:          string;
    minor_benefit:  string;
    major_benefit:  string;
    global_benefit: string;
    lore:           string;
  };
};

type ExistingReveal = {
  zone_key: string;
  user_id:  string;
  tier:     "minor" | "major" | "global";
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    const admin = adminClient();
    const body  = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const campaign_id = body.campaign_id as string | undefined;
    if (!campaign_id) return json(400, { ok: false, error: "Missing campaign_id" });

    // Only lead or admin may trigger this
    const { data: memberRow, error: memErr } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (memErr) return json(500, { ok: false, error: memErr.message });
    if (!memberRow || !["lead", "admin"].includes(memberRow.role as string)) {
      return json(403, { ok: false, error: "Lead or admin role required" });
    }

    // 1. Load all members of this campaign (to know who to award global to)
    const { data: members, error: memListErr } = await admin
      .from("campaign_members")
      .select("user_id")
      .eq("campaign_id", campaign_id);

    if (memListErr) return json(500, { ok: false, error: memListErr.message });
    const allMemberIds: string[] = (members ?? []).map((m: any) => m.user_id as string);

    // 2. Load current round number (for bulletin posts)
    const { data: campRow, error: campErr } = await admin
      .from("campaigns")
      .select("round_number")
      .eq("id", campaign_id)
      .maybeSingle();

    if (campErr) return json(500, { ok: false, error: campErr.message });
    const roundNumber: number = (campRow as any)?.round_number ?? 1;

    // 3. Load all campaign zone effect assignments (joined with effect details)
    const { data: czeRows, error: czeErr } = await admin
      .from("campaign_zone_effects")
      .select("id,zone_key,zone_name,zone_effect_id,minor_charges_used,major_charges_used,global_charges_used,zone_effects(slug,name,scope,minor_benefit,major_benefit,global_benefit,lore)")
      .eq("campaign_id", campaign_id);

    if (czeErr) return json(500, { ok: false, error: czeErr.message });
    if (!czeRows?.length) {
      return json(200, { ok: true, newReveals: 0, bulletin_posts: 0, note: "No zone effects assigned to this campaign." });
    }
    const zoneEffects = czeRows as ZoneEffectRow[];

    // 4. Load all sectors for this campaign (adminClient bypasses RLS)
    const { data: sectorRows, error: secErr } = await admin
      .from("sectors")
      .select("zone_key, sector_key, owner_user_id")
      .eq("campaign_id", campaign_id);

    if (secErr) return json(500, { ok: false, error: secErr.message });

    // 5. Load the map_json to get the canonical sector count per zone.
    //    Falls back to counting sectors in the sectors table if no map is linked.
    const { data: campMapRow } = await admin
      .from("campaigns")
      .select("map_id")
      .eq("id", campaign_id)
      .maybeSingle();

    const zoneSectorCount = new Map<string, number>();

    if ((campMapRow as any)?.map_id) {
      const { data: mapRow } = await admin
        .from("maps")
        .select("map_json")
        .eq("id", (campMapRow as any).map_id)
        .maybeSingle();

      const mapJson = (mapRow as any)?.map_json;
      if (mapJson?.zones?.length) {
        for (const z of mapJson.zones) {
          zoneSectorCount.set(z.key as string, (z.sectors as any[]).length);
        }
      }
    }

    // Fallback: count distinct sector rows per zone_key
    for (const cze of zoneEffects) {
      if (!zoneSectorCount.has(cze.zone_key)) {
        const count = (sectorRows ?? []).filter((s: any) => s.zone_key === cze.zone_key).length;
        zoneSectorCount.set(cze.zone_key, count || 4); // 4-sector default
      }
    }

    // 6. Build sector count per (zone_key, user_id) from current ownership data
    // Map: zone_key -> Map<user_id, sectorCount>
    const ownershipByZone = new Map<string, Map<string, number>>();
    for (const s of sectorRows ?? []) {
      const sec = s as { zone_key: string; owner_user_id: string | null };
      if (!sec.owner_user_id) continue;
      if (!ownershipByZone.has(sec.zone_key)) ownershipByZone.set(sec.zone_key, new Map());
      const m = ownershipByZone.get(sec.zone_key)!;
      m.set(sec.owner_user_id, (m.get(sec.owner_user_id) ?? 0) + 1);
    }

    // 7. Load existing reveals so we never re-reveal (idempotency)
    const { data: existingReveals, error: revErr } = await admin
      .from("zone_effect_reveals")
      .select("zone_key, user_id, tier")
      .eq("campaign_id", campaign_id);

    if (revErr) return json(500, { ok: false, error: revErr.message });

    // Set of "campaign_id:zone_key:user_id:tier" strings for fast lookup
    const alreadyRevealedSet = new Set<string>(
      (existingReveals ?? []).map((r: any) =>
        `${(r as ExistingReveal).zone_key}:${(r as ExistingReveal).user_id}:${(r as ExistingReveal).tier}`
      )
    );

    const revealKey = (zoneKey: string, userId: string, tier: string) =>
      `${zoneKey}:${userId}:${tier}`;

    // 8. Evaluate thresholds for every zone
    type NewReveal = {
      campaign_id:    string;
      zone_key:       string;
      zone_effect_id: string;
      user_id:        string;
      tier:           "minor" | "major" | "global";
    };

    type BulletinPost = {
      campaign_id:      string;
      round_number:     number;
      visibility:       string;
      audience_user_id: string | null;
      title:            string;
      body:             string;
      tags:             string[];
      created_by:       string | null;
    };

    const newRevealRows:   NewReveal[]     = [];
    const bulletinPosts:   BulletinPost[]  = [];

    for (const cze of zoneEffects) {
      const zoneKey      = cze.zone_key;
      const zoneName     = cze.zone_name;
      const effect       = cze.zone_effects;
      const totalSectors = zoneSectorCount.get(zoneKey) ?? 4;
      const minorThresh  = Math.ceil(totalSectors / 2);
      const majorThresh  = totalSectors;

      const ownersInZone = ownershipByZone.get(zoneKey) ?? new Map<string, number>();

      // Determine which players qualify for each tier
      const majorPlayers  = new Set<string>();
      const minorPlayers  = new Set<string>(); // includes players who also qualify for major

      for (const [userId, count] of ownersInZone.entries()) {
        if (count >= majorThresh) majorPlayers.add(userId);
        else if (count >= minorThresh) minorPlayers.add(userId);
      }

      // Global goes to members who don't qualify for minor/major —
      // but ONLY if at least one player has achieved major control
      // (spec: global is the "consolation" when a zone is fully locked out).
      const globalEligible = majorPlayers.size > 0
        ? allMemberIds.filter((uid) => !majorPlayers.has(uid) && !minorPlayers.has(uid))
        : [];

      // Helper: queue a reveal + bulletin if not already revealed
      const queueReveal = (userId: string, tier: "minor" | "major" | "global") => {
        if (alreadyRevealedSet.has(revealKey(zoneKey, userId, tier))) return;
        alreadyRevealedSet.add(revealKey(zoneKey, userId, tier)); // optimistic mark

        newRevealRows.push({
          campaign_id:    campaign_id,
          zone_key:       zoneKey,
          zone_effect_id: cze.zone_effect_id,
          user_id:        userId,
          tier,
        });

        // Determine benefit text and bulletin title for this tier
        let benefitText = "";
        let tierLabel   = "";
        if (tier === "major") {
          benefitText = effect.major_benefit;
          tierLabel   = "★ Major Control";
        } else if (tier === "minor") {
          benefitText = effect.minor_benefit;
          tierLabel   = "◆ Partial Control";
        } else {
          benefitText = effect.global_benefit;
          tierLabel   = "◈ Global Effect";
        }

        // Format timestamp
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const ts  = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

        // Scope label for display
        const scopeLabels: Record<string, string> = {
          permanent:  "Always active",
          per_battle: "Active each battle",
          per_round:  "Active each round",
          one_time:   "One-time use",
        };
        const scopeNote = scopeLabels[effect.scope] ?? effect.scope;

        // Major and global effects are posted publicly so all players can see them.
        // Minor effects are posted privately to the controlling player only
        // (fog of war — other players don't see that you hold partial control).
        const isPublic = tier === "major" || tier === "global";

        bulletinPosts.push({
          campaign_id:      campaign_id,
          round_number:     roundNumber,
          visibility:       isPublic ? "public" : "private",
          audience_user_id: isPublic ? null : userId,
          title:            `Zone Effect Revealed — ${zoneName}`,
          body:             [
            `${tierLabel}: ${effect.name}`,
            ``,
            `Benefit: ${benefitText}`,
            `(${scopeNote})`,
            ``,
            `"${effect.lore.length > 200 ? effect.lore.slice(0, 200) + "…" : effect.lore}"`,
            ``,
            ts,
          ].join("\n"),
          tags:       ["zone_effect"],
          created_by: null,
        });
      };

      // Queue reveals for each qualifying player
      for (const uid of majorPlayers)   queueReveal(uid, "major");
      for (const uid of minorPlayers)   queueReveal(uid, "minor");
      for (const uid of globalEligible) queueReveal(uid, "global");

      // ── Major benefit teaser (private, controlling player only) ──────────────
      // When a player holds the minor threshold but NOT yet the major threshold,
      // AND the major reveal has NOT been sent yet, send a private "teaser" post
      // showing the greyed-out major benefit text as an incentive to expand.
      // Tagged ["zone_effect_teaser"] so the frontend can style it differently.
      // Only sent once (guarded by a separate reveal-key convention: "teaser").
      for (const uid of minorPlayers) {
        const teaserKey = revealKey(zoneKey, uid, "global"); // reuse global slot to avoid extra DB column
        // Only tease if major hasn't been sent AND teaser hasn't been sent before
        const teaserSentKey = `${zoneKey}:${uid}:teaser`;
        if (
          !majorPlayers.has(uid) &&
          !alreadyRevealedSet.has(teaserSentKey)
        ) {
          alreadyRevealedSet.add(teaserSentKey);

          const now = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const ts  = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

          bulletinPosts.push({
            campaign_id:      campaign_id,
            round_number:     roundNumber,
            visibility:       "private",
            audience_user_id: uid,
            title:            `Zone Effect Teaser — ${zoneName}`,
            body:             [
              `◆ ${effect.name} — Partial Control Active`,
              ``,
              `Current benefit: ${effect.minor_benefit}`,
              ``,
              `[LOCKED] Full Control: ${effect.major_benefit}`,
              `Capture all ${totalSectors} sectors in ${zoneName} to unlock the full effect.`,
              ``,
              ts,
            ].join("\n"),
            tags:       ["zone_effect", "zone_effect_teaser"],
            created_by: null,
          });
        }
      }
    }

    // 9. Write new reveals to the DB
    let revealsWritten = 0;
    if (newRevealRows.length > 0) {
      const { error: insertRevErr } = await admin
        .from("zone_effect_reveals")
        .upsert(newRevealRows, {
          onConflict: "campaign_id,zone_key,user_id,tier",
          ignoreDuplicates: true,
        });
      if (insertRevErr) {
        console.error("[evaluate-zone-effects] reveal insert error:", insertRevErr.message);
      } else {
        revealsWritten = newRevealRows.length;
      }
    }

    // 10. Write bulletin posts
    let postsWritten = 0;
    if (bulletinPosts.length > 0) {
      const { error: postErr } = await admin
        .from("posts")
        .insert(bulletinPosts);
      if (postErr) {
        console.error("[evaluate-zone-effects] bulletin post error:", postErr.message);
      } else {
        postsWritten = bulletinPosts.length;
      }
    }

    console.log(`[evaluate-zone-effects] campaign=${campaign_id} newReveals=${revealsWritten} bulletins=${postsWritten}`);

    return json(200, {
      ok:            true,
      newReveals:    revealsWritten,
      bulletin_posts: postsWritten,
    });

  } catch (e) {
    return json(500, { ok: false, error: (e as Error).message ?? "Internal error" });
  }
});
