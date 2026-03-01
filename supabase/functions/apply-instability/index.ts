import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EffectJson {
  type: string;
  amount?: number;
  nip?: number;
  ncp?: number;
  count?: number;
  cost?: number;
  rule?: string;
  instruction?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function d10(): number {
  return Math.floor(Math.random() * 10) + 1;
}

function thresholdBand(instability: number): number {
  if (instability >= 8) return 8;
  if (instability >= 4) return 4;
  return 0;
}

function buildAutoEffects(effect: EffectJson, playerCount: number): string[] {
  switch (effect.type) {
    case "nip_penalty_all":
      return [`All ${playerCount} players lose ${effect.amount} NIP`];
    case "nip_gain_all":
      return [`All ${playerCount} players gain ${effect.amount} NIP`];
    case "nip_gain_last":
      return [`The last-place player gains ${effect.nip} NIP and ${effect.ncp} NCP`];
    case "recon_cancel":
      return ["Recon phase cancelled — all purchased recon tokens refunded (1 NIP each)"];
    case "deep_strike_cost":
      return [`Deep strike NIP cost increased to ${effect.cost} for the rest of the campaign`];
    case "relic_nip_gain":
      return [`Each relic holder gains ${effect.amount} NIP`];
    case "campaign_end_trigger":
      return ["Campaign ending conditions triggered — concludes at end of round if instability reaches 10"];
    default:
      return [];
  }
}

function needsZoneSelection(effect: EffectJson): boolean {
  return ["zone_battle_hazard", "zone_nip_penalty", "zone_impassable", "zone_sensor_blind"].includes(
    effect.type
  );
}

function needsZoneDestroy(effect: EffectJson): boolean {
  return effect.type === "sector_remove";
}

// ── Main handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorised" });
    const user = result.user;

    const admin = adminClient();
    const body = await req.json().catch(() => ({}));
    const campaignId = body.campaign_id as string;
    const mode = (body.mode as string) || "roll";

    if (!campaignId) return json(400, { ok: false, error: "campaign_id required" });

    // Verify lead/admin role
    const { data: mem } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaignId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!["lead", "admin"].includes(mem?.role ?? "")) {
      return json(403, { ok: false, error: "Not authorised" });
    }

    // Load campaign
    const { data: c, error: cErr } = await admin
      .from("campaigns")
      .select("id,name,template_id,round_number,instability,phase,rules_overrides")
      .eq("id", campaignId)
      .single();

    if (cErr || !c) throw cErr ?? new Error("Campaign not found");

    // Load active players
    const { data: playerRows } = await admin
      .from("player_state")
      .select("user_id,nip,ncp,current_zone_key")
      .eq("campaign_id", campaignId)
      .eq("status", "normal");

    const players = playerRows ?? [];

    // ── ROLL MODE ─────────────────────────────────────────────────────────
    if (mode === "roll") {
      const newInstability = Math.min(10, (c.instability ?? 0) + 1);
      const band = thresholdBand(newInstability);
      const roll = d10();

      const { data: ev } = await admin
        .from("instability_events")
        .select("name,public_text,effect_json")
        .eq("template_id", c.template_id)
        .eq("threshold_min", band)
        .eq("d10", roll)
        .eq("is_active", true)
        .maybeSingle();

      const eventName = ev?.name ?? "Unlogged Disturbance";
      const publicText =
        ev?.public_text ??
        "The Halo shudders. Something changes, though no one agrees how.";
      const effect: EffectJson =
        (ev?.effect_json as EffectJson) ?? { type: "narrative_only" };

      return json(200, {
        ok: true,
        d10: roll,
        threshold_band: band,
        current_instability: c.instability ?? 0,
        new_instability: newInstability,
        event_name: eventName,
        public_text: publicText,
        effect,
        auto_effects: buildAutoEffects(effect, players.length),
        needs_zone_selection: needsZoneSelection(effect),
        needs_zone_destroy: needsZoneDestroy(effect),
        destroy_count: (effect as any).count ?? 1,
      });
    }

    // ── CONFIRM MODE ──────────────────────────────────────────────────────
    if (mode === "confirm") {
      const d10Result = body.d10_result as number;
      const expectedInstability = body.expected_instability as number;
      const selectedZones = (body.selected_zones as string[]) ?? [];
      const selectedZone = (body.selected_zone as string) ?? "";

      // Prevent double-apply
      if (c.instability !== expectedInstability) {
        return json(409, {
          ok: false,
          error: `Instability changed since roll (expected ${expectedInstability}, current ${c.instability}). Please re-roll.`,
        });
      }

      const newInstability = Math.min(10, (c.instability ?? 0) + 1);
      const band = thresholdBand(newInstability);

      const { data: ev } = await admin
        .from("instability_events")
        .select("name,public_text,effect_json")
        .eq("template_id", c.template_id)
        .eq("threshold_min", band)
        .eq("d10", d10Result)
        .eq("is_active", true)
        .maybeSingle();

      const eventName = ev?.name ?? "Unlogged Disturbance";
      const publicText =
        ev?.public_text ??
        "The Halo shudders. Something changes, though no one agrees how.";
      const effect: EffectJson =
        (ev?.effect_json as EffectJson) ?? { type: "narrative_only" };

      const rulesOverrides: Record<string, unknown> =
        (c.rules_overrides as Record<string, unknown>) ?? {};
      const updatedRules: Record<string, unknown> = { ...rulesOverrides };

      const ledgerEntries: Array<{
        campaign_id: string;
        user_id: string;
        round_number: number;
        entry_type: string;
        currency: string;
        amount: number;
        reason: string;
      }> = [];

      const playerStateUpdates: Array<{
        user_id: string;
        nip?: number;
        ncp?: number;
      }> = [];

      const effectSummaryParts: string[] = [];

      switch (effect.type) {

        case "nip_penalty_all": {
          const amount = effect.amount ?? 1;
          for (const p of players) {
            const newNip = Math.max(0, (p.nip ?? 0) - amount);
            const actual = (p.nip ?? 0) - newNip;
            if (actual > 0) {
              playerStateUpdates.push({ user_id: p.user_id, nip: newNip });
              ledgerEntries.push({
                campaign_id: campaignId,
                user_id: p.user_id,
                round_number: c.round_number,
                entry_type: "spend",
                currency: "NIP",
                amount: -actual,
                reason: `Instability event: ${eventName}`,
              });
            }
          }
          effectSummaryParts.push(
            `${players.length} player(s) penalised ${amount} NIP each`
          );
          break;
        }

        case "nip_gain_all": {
          const amount = effect.amount ?? 1;
          for (const p of players) {
            playerStateUpdates.push({
              user_id: p.user_id,
              nip: (p.nip ?? 0) + amount,
            });
            ledgerEntries.push({
              campaign_id: campaignId,
              user_id: p.user_id,
              round_number: c.round_number,
              entry_type: "earn",
              currency: "NIP",
              amount,
              reason: `Instability event: ${eventName}`,
            });
          }
          effectSummaryParts.push(
            `${players.length} player(s) each received ${amount} NIP`
          );
          break;
        }

        case "nip_gain_last": {
          const nipGain = effect.nip ?? 3;
          const ncpGain = effect.ncp ?? 1;
          const sorted = [...players].sort(
            (a, b) => (a.ncp ?? 0) - (b.ncp ?? 0)
          );
          const last = sorted[0];
          if (last) {
            playerStateUpdates.push({
              user_id: last.user_id,
              nip: (last.nip ?? 0) + nipGain,
              ncp: (last.ncp ?? 0) + ncpGain,
            });
            ledgerEntries.push(
              {
                campaign_id: campaignId,
                user_id: last.user_id,
                round_number: c.round_number,
                entry_type: "earn",
                currency: "NIP",
                amount: nipGain,
                reason: `Instability event: ${eventName}`,
              },
              {
                campaign_id: campaignId,
                user_id: last.user_id,
                round_number: c.round_number,
                entry_type: "earn",
                currency: "NCP",
                amount: ncpGain,
                reason: `Instability event: ${eventName}`,
              }
            );
            effectSummaryParts.push(
              `Last-place player received ${nipGain} NIP and ${ncpGain} NCP`
            );
          }
          break;
        }

        case "recon_cancel": {
          const { data: recons } = await admin
            .from("round_spends")
            .select("user_id, nip_spent")
            .eq("campaign_id", campaignId)
            .eq("round_number", c.round_number)
            .eq("spend_type", "recon");

          let refunded = 0;
          for (const r of recons ?? []) {
            const p = players.find((x) => x.user_id === r.user_id);
            if (p) {
              playerStateUpdates.push({
                user_id: p.user_id,
                nip: (p.nip ?? 0) + (r.nip_spent ?? 1),
              });
              ledgerEntries.push({
                campaign_id: campaignId,
                user_id: p.user_id,
                round_number: c.round_number,
                entry_type: "earn",
                currency: "NIP",
                amount: r.nip_spent ?? 1,
                reason: `Instability event: ${eventName} — recon refunded`,
              });
              refunded++;
            }
          }
          await admin
            .from("round_spends")
            .delete()
            .eq("campaign_id", campaignId)
            .eq("round_number", c.round_number)
            .eq("spend_type", "recon");

          effectSummaryParts.push(`${refunded} recon token(s) refunded`);
          break;
        }

        case "deep_strike_cost": {
          const cost = effect.cost ?? 5;
          updatedRules.deep_strike_nip_cost = cost;
          effectSummaryParts.push(`Deep strike NIP cost changed to ${cost}`);
          break;
        }

        case "relic_nip_gain": {
          const amount = effect.amount ?? 1;
          const { data: relicRows } = await admin
            .from("campaign_relics")
            .select("controller_user_id")
            .eq("campaign_id", campaignId)
            .not("controller_user_id", "is", null);

          const holders = new Set(
            (relicRows ?? []).map((r: any) => r.controller_user_id as string)
          );
          for (const uid of holders) {
            const p = players.find((x) => x.user_id === uid);
            if (p) {
              playerStateUpdates.push({
                user_id: uid,
                nip: (p.nip ?? 0) + amount,
              });
              ledgerEntries.push({
                campaign_id: campaignId,
                user_id: uid,
                round_number: c.round_number,
                entry_type: "earn",
                currency: "NIP",
                amount,
                reason: `Instability event: ${eventName} — relic resonance`,
              });
            }
          }
          effectSummaryParts.push(
            `${holders.size} relic holder(s) each received ${amount} NIP`
          );
          break;
        }

        case "campaign_end_trigger": {
          updatedRules.ending_triggered = true;
          effectSummaryParts.push("Campaign ending conditions triggered");
          break;
        }

        case "sector_remove": {
          if (selectedZones.length > 0) {
            const existing =
              (rulesOverrides.destroyed_zones as string[]) ?? [];
            updatedRules.destroyed_zones = Array.from(
              new Set([...existing, ...selectedZones])
            );
            effectSummaryParts.push(
              `Zone(s) destroyed: ${selectedZones.join(", ")}`
            );
          }
          break;
        }

        case "zone_battle_hazard": {
          if (selectedZone) {
            const rc =
              ((updatedRules.round_conditions as Record<string, unknown>) ??
                {});
            rc[String(c.round_number)] = {
              ...((rc[String(c.round_number)] as Record<string, unknown>) ??
                {}),
              zone_battle_hazard: selectedZone,
              zone_battle_hazard_rule:
                effect.instruction ?? "Units in this zone suffer d3 mortal wounds on their warlord at battle start.",
            };
            updatedRules.round_conditions = rc;
            effectSummaryParts.push(`Battle hazard zone: ${selectedZone}`);
          }
          break;
        }

        case "zone_impassable": {
          if (selectedZone) {
            const rc =
              ((updatedRules.round_conditions as Record<string, unknown>) ??
                {});
            rc[String(c.round_number)] = {
              ...((rc[String(c.round_number)] as Record<string, unknown>) ??
                {}),
              zone_impassable: selectedZone,
            };
            updatedRules.round_conditions = rc;
            effectSummaryParts.push(`Zone impassable this round: ${selectedZone}`);
          }
          break;
        }

        case "zone_sensor_blind": {
          if (selectedZone) {
            const rc =
              ((updatedRules.round_conditions as Record<string, unknown>) ??
                {});
            rc[String(c.round_number)] = {
              ...((rc[String(c.round_number)] as Record<string, unknown>) ??
                {}),
              zone_sensor_blind: selectedZone,
            };
            updatedRules.round_conditions = rc;
            effectSummaryParts.push(`Recon blind zone this round: ${selectedZone}`);
          }
          break;
        }

        case "zone_nip_penalty": {
          if (selectedZone) {
            const amount = effect.amount ?? 1;
            const inZone = players.filter(
              (p) => p.current_zone_key === selectedZone
            );
            for (const p of inZone) {
              const newNip = Math.max(0, (p.nip ?? 0) - amount);
              const actual = (p.nip ?? 0) - newNip;
              if (actual > 0) {
                playerStateUpdates.push({ user_id: p.user_id, nip: newNip });
                ledgerEntries.push({
                  campaign_id: campaignId,
                  user_id: p.user_id,
                  round_number: c.round_number,
                  entry_type: "spend",
                  currency: "NIP",
                  amount: -actual,
                  reason: `Instability event: ${eventName} — zone penalty (${selectedZone})`,
                });
              }
            }
            effectSummaryParts.push(
              `${inZone.length} player(s) in ${selectedZone} penalised ${amount} NIP`
            );
          }
          break;
        }

        default:
          break;
      }

      // ── Apply player_state updates (merge per user) ──────────────────────
      const mergedUpdates = new Map<
        string,
        { nip?: number; ncp?: number }
      >();
      for (const u of playerStateUpdates) {
        const prev = mergedUpdates.get(u.user_id) ?? {};
        mergedUpdates.set(u.user_id, {
          nip: u.nip !== undefined ? u.nip : prev.nip,
          ncp: u.ncp !== undefined ? u.ncp : prev.ncp,
        });
      }
      for (const [uid, vals] of mergedUpdates) {
        await admin
          .from("player_state")
          .update(vals)
          .eq("campaign_id", campaignId)
          .eq("user_id", uid);
      }

      if (ledgerEntries.length > 0) {
        await admin.from("ledger").insert(ledgerEntries);
      }

      // ── Increment instability + update rules_overrides ───────────────────
      await admin
        .from("campaigns")
        .update({ instability: newInstability, rules_overrides: updatedRules })
        .eq("id", campaignId);

      // ── Phase advancement ────────────────────────────────────────────────
      let newPhase = c.phase ?? 1;
      let phaseChanged = false;
      if (newInstability >= 8) newPhase = Math.max(newPhase, 3);
      else if (newInstability >= 4) newPhase = Math.max(newPhase, 2);

      if (newPhase !== (c.phase ?? 1)) {
        phaseChanged = true;
        await admin
          .from("campaigns")
          .update({ phase: newPhase })
          .eq("id", campaignId);
        await admin.from("posts").insert({
          campaign_id: campaignId,
          round_number: c.round_number,
          visibility: "public",
          title: `Phase Shift: Phase ${newPhase}`,
          body:
            newPhase === 2
              ? "The Halo's war becomes overt. Relics flare. Retreat becomes a luxury no one can afford."
              : "Collapse approaches. The Halo itself begins to choose who may live long enough to flee.",
          tags: ["phase", `phase_${newPhase}`],
          created_by: user.id,
        });
      }

      // ── Campaign events log ──────────────────────────────────────────────
      await admin.from("campaign_events").insert({
        campaign_id: campaignId,
        round_number: c.round_number,
        instability_after: newInstability,
        event_name: eventName,
        event_roll: d10Result,
        visibility: "public",
        effect_json: effect,
      });

      // ── War bulletin post ────────────────────────────────────────────────
      const bulletinParts = [publicText];
      if (effectSummaryParts.length > 0) {
        bulletinParts.push(`\nEffects applied: ${effectSummaryParts.join("; ")}.`);
      }
      if (effect.type === "battle_rule" && effect.rule) {
        bulletinParts.push(`\nBattle condition this round: ${effect.rule}`);
      }
      if (effect.type === "manual" && effect.instruction) {
        bulletinParts.push(`\nLead action required: ${effect.instruction}`);
      }
      bulletinParts.push(`\n(Instability now ${newInstability}/10.)`);

      await admin.from("posts").insert({
        campaign_id: campaignId,
        round_number: c.round_number,
        visibility: "public",
        title: `Halo Instability: ${eventName}`,
        body: bulletinParts.filter(Boolean).join(""),
        tags: ["instability", `t${band}`, `d10_${d10Result}`],
        created_by: user.id,
      });

      return json(200, {
        ok: true,
        instability: newInstability,
        event_name: eventName,
        phase_changed: phaseChanged,
        new_phase: newPhase,
        effects_applied: effectSummaryParts,
      });
    }

    return json(400, { ok: false, error: `Unknown mode: ${mode}` });
  } catch (e) {
    console.error("apply-instability error:", e);
    return json(500, { ok: false, error: (e as Error).message });
  }
});
