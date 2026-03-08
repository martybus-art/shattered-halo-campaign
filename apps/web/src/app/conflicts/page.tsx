"use client";
// src/app/conflicts/page.tsx
//
// changelog:
//   2026-03-09 — FEATURE: Dual Battle Chronicles. "Pre-Battle Dispatch" is always
//                available and generates a dramatic hype narrative (factions, stakes,
//                grimdark flavour, no outcome). Post-battle "Generate Chronicle"
//                remains but is now only visible during the Results phase or for
//                past rounds, and generates a result-based narrative.
//   2026-03-09 — FEATURE: SVG BattlefieldLayout component. Each conflict card shows
//                a deterministic 20"×44" 40K tactical board with deployment zones,
//                3 objectives (home base A, mission objective, home base B), and
//                terrain features (ruins, craters, barricades) seeded from the
//                conflict ID. No API cost or extra storage required.
//   2026-03-09 — BEHAVIOUR: "Report Result" button is now hidden until the round
//                enters the "results" stage. Past-round conflicts always show it.
//   2026-03-09 — LAYOUT: Cards redesigned to a 2-column grid.
//                Left:  Combatants → Mission Influence → Ceasefire negotiation.
//                Right: Mission info → Battlefield SVG → Pre-Battle Dispatch →
//                       Battle Result (results phase only) → Battle Chronicle.
//   2026-03-08 — SECURITY: authChecked state, redirects, no-campaign fallback.
//   2026-03-08 — FEATURE: Alliance / Ceasefire system.
//   2026-03-08 — FEATURE: Chronicles published to War Bulletin.
//   2026-03-08 — SECURITY: sessionStorage campaign ID pattern.

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { bootstrapCampaignId } from "@/lib/campaignSession";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// ── Types ─────────────────────────────────────────────────────────────────────

type Conflict = {
  id: string;
  campaign_id: string;
  round_number: number;
  zone_key: string;
  sector_key: string;
  player_a: string;
  player_b: string;
  mission_id: string | null;
  mission_status: string;
  twist_tags: string[];
  status: string;
  alliance_proposed_by: string | null;
};

type Mission = {
  id: string;
  name: string;
  description: string;
  mission_type: string;
};

type BattleResult = {
  id: string;
  conflict_id: string;
  reported_by: string;
  winner_user_id: string | null;
  outcome_json: Record<string, unknown>;
  confirmed: boolean;
};

type Member = {
  user_id: string;
  faction_name: string | null;
  faction_key: string | null;
  commander_name: string | null;
  role: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function memberLabel(members: Member[], userId: string): string {
  const m = members.find((x) => x.user_id === userId);
  if (!m) return userId.slice(0, 8) + "\u2026";
  return m.faction_name ?? m.commander_name ?? userId.slice(0, 8) + "\u2026";
}

// ── Seeded PRNG (xorshift32) ──────────────────────────────────────────────────
// Produces consistent terrain placement from a conflict ID string.

function seededPRNG(seed: string): () => number {
  let s = seed
    .split("")
    .reduce((acc, c) => (Math.imul(31, acc) + c.charCodeAt(0)) | 0, 0x9f2ec3a1);
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

// ── Battlefield Layout SVG ────────────────────────────────────────────────────
//
// Renders a 20" x 44" 40K tactical board (portrait).
// viewBox: 0 0 200 440  (10 SVG units = 1 inch)
//
// Deployment zones:
//   Zone A (player_a) : y =   0 – 90   (0" – 9")
//   No man's land     : y =  90 – 350  (9" – 35")
//   Zone B (player_b) : y = 350 – 440  (35" – 44")
//
// Objectives:
//   HOME BASE A  cx=100  cy= 45   brass
//   OBJECTIVE    cx=100  cy=220   gold   (mission objective)
//   HOME BASE B  cx=100  cy=395   blood

type TerrainPiece = {
  x: number;
  y: number;
  type: "ruin" | "crater" | "barricade";
  w: number;
  h: number;
  rot: number;
};

const OBJ_CENTERS = [
  { cx: 100, cy: 45 },
  { cx: 100, cy: 220 },
  { cx: 100, cy: 395 },
];
const OBJ_CLEAR = 30;

function buildTerrain(seed: string): TerrainPiece[] {
  const rand   = seededPRNG(seed);
  const pieces: TerrainPiece[] = [];

  function isClear(x: number, y: number): boolean {
    if (OBJ_CENTERS.some((o) => Math.hypot(x - o.cx, y - o.cy) < OBJ_CLEAR))
      return false;
    if (pieces.some((p) => Math.hypot(x - p.x, y - p.y) < 20))
      return false;
    return true;
  }

  function tryAdd(
    x: number,
    y: number,
    type: "ruin" | "crater" | "barricade",
    w: number,
    h: number,
    rot: number
  ) {
    const m = type === "barricade" ? 4 : 9;
    if (x - w / 2 < m || x + w / 2 > 200 - m) return;
    if (y - h / 2 < m || y + h / 2 > 440 - m) return;
    if (!isClear(x, y)) return;
    pieces.push({ x, y, type, w, h, rot });
  }

  function scatter(yMin: number, yMax: number, target: number) {
    for (let attempt = 0; attempt < target * 4; attempt++) {
      const inZone = pieces.filter((p) => p.y >= yMin && p.y <= yMax).length;
      if (inZone >= target) break;
      const x = 14 + rand() * 172;
      const y = yMin + rand() * (yMax - yMin);
      const r = rand();
      if (r < 0.48) {
        tryAdd(x, y, "ruin",      13 + rand() * 14, 8 + rand() * 10, rand() * 55);
      } else if (r < 0.78) {
        const d = 9 + rand() * 9;
        tryAdd(x, y, "crater",    d,  d,  0);
      } else {
        tryAdd(x, y, "barricade", 20 + rand() * 14, 4, rand() * 85);
      }
    }
  }

  scatter(10,  80,  3);   // Zone A
  scatter(360, 430, 3);   // Zone B
  scatter(100, 340, 7);   // No man's land

  return pieces;
}

function BattlefieldLayout({
  conflictId,
  factionA,
  factionB,
}: {
  conflictId: string;
  factionA: string;
  factionB: string;
}) {
  const terrain = useMemo(() => buildTerrain(conflictId), [conflictId]);

  const BRASS = "#c9a84c";
  const BLOOD = "#7a1515";
  const GOLD  = "#f5c842";

  return (
    <div>
      <div className="text-xs text-parchment/40 uppercase tracking-widest mb-2">
        Battlefield Layout &mdash; 20&Prime; &times; 44&Prime;
      </div>
      <div
        className="rounded border border-brass/20 overflow-hidden"
        style={{ background: "#12100d" }}
      >
        <svg
          viewBox="0 0 200 440"
          style={{ display: "block", width: "100%" }}
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Board background */}
          <rect x="0" y="0" width="200" height="440" fill="#12100d" />

          {/* Subtle 1" grid */}
          {Array.from({ length: 21 }, (_, i) => (
            <line key={"gx" + i}
              x1={i * 10} y1="0" x2={i * 10} y2="440"
              stroke="#ffffff07" strokeWidth="0.3"
            />
          ))}
          {Array.from({ length: 45 }, (_, i) => (
            <line key={"gy" + i}
              x1="0" y1={i * 10} x2="200" y2={i * 10}
              stroke="#ffffff07" strokeWidth="0.3"
            />
          ))}

          {/* Deployment zone A (top) */}
          <rect x="0" y="0" width="200" height="90"
            fill="rgba(201,168,76,0.045)" />
          <rect x="0.5" y="0.5" width="199" height="89"
            fill="none" stroke={BRASS} strokeWidth="0.7"
            strokeDasharray="5,3" opacity="0.45" />

          {/* Deployment zone B (bottom) */}
          <rect x="0" y="350" width="200" height="90"
            fill="rgba(122,21,21,0.045)" />
          <rect x="0.5" y="350.5" width="199" height="89"
            fill="none" stroke={BLOOD} strokeWidth="0.7"
            strokeDasharray="5,3" opacity="0.45" />

          {/* Zone boundary lines */}
          <line x1="0" y1="90"  x2="200" y2="90"  stroke="#3a3830" strokeWidth="0.6" />
          <line x1="0" y1="350" x2="200" y2="350" stroke="#3a3830" strokeWidth="0.6" />

          {/* Centreline */}
          <line x1="0" y1="220" x2="200" y2="220"
            stroke="#2d2b28" strokeWidth="0.4" strokeDasharray="3,6" />

          {/* Terrain pieces */}
          {terrain.map((p, i) => {
            if (p.type === "crater") {
              return (
                <g key={i}>
                  <circle cx={p.x} cy={p.y} r={p.w / 2}
                    fill="#1a1610" stroke="#2c2820" strokeWidth="0.8" />
                  <circle cx={p.x} cy={p.y} r={p.w / 2 - 2}
                    fill="none" stroke="#221e18" strokeWidth="0.4" />
                </g>
              );
            } else if (p.type === "ruin") {
              return (
                <g key={i}
                  transform={`rotate(${p.rot.toFixed(1)},${p.x},${p.y})`}>
                  <rect
                    x={p.x - p.w / 2} y={p.y - p.h / 2}
                    width={p.w} height={p.h}
                    fill="#221e15" stroke="#3a3228" strokeWidth="0.8"
                  />
                  <line
                    x1={p.x - p.w / 2 + 2} y1={p.y - p.h / 4}
                    x2={p.x + p.w / 2 - 2} y2={p.y - p.h / 4}
                    stroke="#2d2820" strokeWidth="0.4"
                  />
                  <line
                    x1={p.x} y1={p.y - p.h / 2 + 2}
                    x2={p.x} y2={p.y + p.h / 2 - 2}
                    stroke="#2d2820" strokeWidth="0.4"
                  />
                </g>
              );
            } else {
              const notchCount = Math.floor(p.w / 6);
              return (
                <g key={i}
                  transform={`rotate(${p.rot.toFixed(1)},${p.x},${p.y})`}>
                  <rect
                    x={p.x - p.w / 2} y={p.y - p.h / 2}
                    width={p.w} height={p.h}
                    fill="#1e2228" stroke="#2a3038" strokeWidth="0.8"
                  />
                  {Array.from({ length: notchCount }, (_, ni) => (
                    <rect key={ni}
                      x={p.x - p.w / 2 + ni * 6 + 1}
                      y={p.y - p.h / 2 - 1.5}
                      width="4" height="1.5"
                      fill="#1e2228" stroke="#2a3038" strokeWidth="0.4"
                    />
                  ))}
                </g>
              );
            }
          })}

          {/* OBJ-A: player_a home base */}
          <circle cx="100" cy="45" r="11"
            fill="rgba(201,168,76,0.07)"
            stroke={BRASS} strokeWidth="1.2" strokeDasharray="4,2.5" />
          <circle cx="100" cy="45" r="3.5" fill={BRASS} />
          <text x="100" y="68" textAnchor="middle" fontSize="5.5"
            fill={BRASS}
            fontFamily="Georgia, 'Times New Roman', serif" opacity="0.8">
            HOME BASE A
          </text>

          {/* OBJ-C: mission objective (centre) */}
          <circle cx="100" cy="220" r="11"
            fill="rgba(245,200,66,0.06)"
            stroke={GOLD} strokeWidth="1.5" />
          <circle cx="100" cy="220" r="3.5" fill={GOLD} />
          <text x="100" y="241" textAnchor="middle" fontSize="5.5"
            fill={GOLD}
            fontFamily="Georgia, 'Times New Roman', serif">
            OBJECTIVE
          </text>

          {/* OBJ-B: player_b home base */}
          <circle cx="100" cy="395" r="11"
            fill="rgba(122,21,21,0.07)"
            stroke={BLOOD} strokeWidth="1.2" strokeDasharray="4,2.5" />
          <circle cx="100" cy="395" r="3.5" fill={BLOOD} />
          <text x="100" y="375" textAnchor="middle" fontSize="5.5"
            fill={BLOOD}
            fontFamily="Georgia, 'Times New Roman', serif" opacity="0.8">
            HOME BASE B
          </text>

          {/* Faction labels */}
          <text x="4" y="10" fontSize="5" fill={BRASS} opacity="0.55"
            fontFamily="Georgia, 'Times New Roman', serif">
            {factionA.slice(0, 18)}
          </text>
          <text x="4" y="437" fontSize="5" fill={BLOOD} opacity="0.55"
            fontFamily="Georgia, 'Times New Roman', serif">
            {factionB.slice(0, 18)}
          </text>

          {/* Deployment depth markers */}
          <text x="3" y="86" fontSize="4.5" fill={BRASS} opacity="0.4"
            fontFamily="serif">9&Prime;</text>
          <text x="3" y="348" fontSize="4.5" fill={BLOOD} opacity="0.4"
            fontFamily="serif">35&Prime;</text>

          {/* Inch markers along left edge (every 4") */}
          {[0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44].map((inch) => (
            <g key={inch}>
              <line
                x1="0" y1={inch * 10}
                x2={inch % 8 === 0 ? 5 : 3} y2={inch * 10}
                stroke="#c9a84c44" strokeWidth="0.5"
              />
              {inch > 0 && inch < 44 && inch % 8 === 0 && (
                <text x="7" y={inch * 10 + 1.8}
                  fontSize="4" fill="#c9a84c33" fontFamily="serif">
                  {inch}&Prime;
                </text>
              )}
            </g>
          ))}

          {/* Board border */}
          <rect x="0.5" y="0.5" width="199" height="439"
            fill="none" stroke="#c9a84c2a" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ConflictsPage() {
  const supabase     = useMemo(() => supabaseBrowser(), []);
  const [campaignId] = useState<string>(() => bootstrapCampaignId());

  const [uid, setUid]                   = useState<string | null>(null);
  const [role, setRole]                 = useState("player");
  const [authChecked, setAuthChecked]   = useState(false);
  const [roundNumber, setRoundNumber]   = useState(0);
  const [roundStage, setRoundStage]     = useState("");
  const [templateId, setTemplateId]     = useState<string | null>(null);
  const [conflicts, setConflicts]       = useState<Conflict[]>([]);
  const [missions, setMissions]         = useState<Mission[]>([]);
  const [members, setMembers]           = useState<Member[]>([]);
  const [results, setResults]           = useState<Record<string, BattleResult>>({});

  // Result form
  const [reportingFor, setReportingFor]         = useState<string | null>(null);
  const [winnerPick, setWinnerPick]             = useState<string>("");
  const [nipEarned, setNipEarned]               = useState(2);
  const [ncpEarned, setNcpEarned]               = useState(0);
  const [resultNotes, setResultNotes]           = useState("");
  const [submittingResult, setSubmittingResult] = useState(false);
  const [resultStatus, setResultStatus]         = useState<Record<string, string>>({});

  // Mission influence
  const [choosingMissionFor, setChoosingMissionFor] = useState<string | null>(null);
  const [pickedMission, setPickedMission]           = useState<string>("");
  const [influenceStatus, setInfluenceStatus]       = useState<Record<string, string>>({});

  // Pre-battle chronicle
  const [preNarratives, setPreNarratives]       = useState<Record<string, string>>({});
  const [generatingPreFor, setGeneratingPreFor] = useState<string | null>(null);

  // Post-battle chronicle
  const [postNarratives, setPostNarratives]        = useState<Record<string, string>>({});
  const [generatingPostFor, setGeneratingPostFor]  = useState<string | null>(null);
  const [postPublished, setPostPublished]          = useState<Record<string, boolean>>({});

  // Alliance
  const [allianceWorking, setAllianceWorking] = useState<string | null>(null);
  const [allianceStatus, setAllianceStatus]   = useState<Record<string, string>>({});

  // ── Load ──────────────────────────────────────────────────────────────────

  const load = async (cid: string) => {
    const { data: userResp } = await supabase.auth.getUser();
    const currentUid = userResp.user?.id ?? null;
    if (!currentUid) { window.location.href = "/"; return; }
    setUid(currentUid);
    setAuthChecked(true);
    if (!cid) return;

    const { data: mem } = await supabase
      .from("campaign_members").select("role")
      .eq("campaign_id", cid).eq("user_id", currentUid).single();
    setRole(mem?.role ?? "player");

    const { data: camp } = await supabase
      .from("campaigns").select("round_number, template_id, phase")
      .eq("id", cid).single();
    if (!camp) return;
    setRoundNumber(camp.round_number);
    setTemplateId(camp.template_id);

    // Current round stage (governs phase-gated visibility)
    const { data: roundRow } = await supabase
      .from("rounds").select("stage")
      .eq("campaign_id", cid).eq("round_number", camp.round_number).maybeSingle();
    setRoundStage(roundRow?.stage ?? "");

    const { data: allMembers } = await supabase
      .from("campaign_members")
      .select("user_id, faction_name, faction_key, commander_name, role")
      .eq("campaign_id", cid);
    setMembers(allMembers ?? []);

    const { data: conf } = await supabase
      .from("conflicts").select("*")
      .eq("campaign_id", cid)
      .order("round_number", { ascending: false });
    setConflicts(conf ?? []);

    const { data: ms } = await supabase
      .from("missions").select("id, name, description, mission_type")
      .eq("template_id", camp.template_id)
      .eq("is_active", true)
      .lte("phase_min", camp.phase ?? 1);
    setMissions(ms ?? []);

    if (conf?.length) {
      const ids = conf.map((c) => c.id);
      const { data: br } = await supabase
        .from("battle_results").select("*").in("conflict_id", ids);
      const brMap: Record<string, BattleResult> = {};
      (br ?? []).forEach((r) => { brMap[r.conflict_id] = r; });
      setResults(brMap);
    }
  };

  useEffect(() => { load(campaignId); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  // ── Phase-gate helpers ────────────────────────────────────────────────────

  // "Report Result" is only shown in the results stage (or for closed past rounds)
  function canShowResult(conflict: Conflict): boolean {
    if (conflict.round_number < roundNumber) return true;
    return roundStage === "results";
  }

  // Post-battle chronicle: results phase or past rounds
  function canShowPostChronicle(conflict: Conflict): boolean {
    if (conflict.round_number < roundNumber) return true;
    return roundStage === "results" || roundStage === "publish";
  }

  // ── Mission influence ─────────────────────────────────────────────────────

  const submitInfluence = async (
    conflictId: string,
    type: "veto" | "choose" | "preference" | "twist",
    payload: Record<string, unknown>,
    nip: number
  ) => {
    if (!uid) return;
    const { error } = await supabase.from("mission_influence").insert({
      conflict_id: conflictId, user_id: uid,
      influence_type: type, nip_spent: nip, payload,
    });
    setInfluenceStatus((prev) => ({
      ...prev,
      [conflictId]: error ? "Error: " + error.message : "Influence recorded.",
    }));
    setChoosingMissionFor(null);
    setPickedMission("");
  };

  // ── Report battle result ──────────────────────────────────────────────────

  const submitResult = async (conflict: Conflict) => {
    if (!uid || !winnerPick) return;
    setSubmittingResult(true);
    try {
      const existing     = results[conflict.id];
      const winnerUserId = winnerPick === "draw" ? null : winnerPick;
      const isConfirming = existing && !existing.confirmed && existing.reported_by !== uid;

      if (isConfirming) {
        const reportedWinner = (existing.outcome_json as any)?.winner_user_id ?? null;
        const token = await getToken();
        if (!token) throw new Error("Session expired \u2014 refresh.");
        const { data, error } = await supabase.functions.invoke("resolve-conflict", {
          body: {
            conflict_id:     conflict.id,
            winner_user_id:  winnerUserId,
            confirmer_agrees: reportedWinner === winnerUserId,
            nip_earned:      nipEarned,
            ncp_earned:      ncpEarned,
            notes:           resultNotes,
          },
          headers: { Authorization: "Bearer " + token },
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error ?? "Resolution failed");
        let msg = data.status === "disputed"
          ? "Dispute recorded \u2014 the lead will adjudicate."
          : "Result confirmed \u2014 conflict resolved.";
        if (data.loser_eliminated)  msg += " Opponent eliminated.";
        if (data.sector_transferred) msg += " Sector control transferred.";
        setResultStatus((prev) => ({ ...prev, [conflict.id]: msg }));
      } else if (!existing) {
        const { error } = await supabase.from("battle_results").insert({
          conflict_id:     conflict.id,
          reported_by:     uid,
          winner_user_id:  winnerUserId,
          confirmed:       false,
          outcome_json: {
            winner_user_id: winnerUserId,
            nip_earned:     nipEarned,
            ncp_earned:     ncpEarned,
            notes:          resultNotes,
          },
        });
        if (error) throw error;
        setResultStatus((prev) => ({
          ...prev,
          [conflict.id]: "Result submitted \u2014 awaiting confirmation from your opponent.",
        }));
      }

      await load(campaignId);
      setReportingFor(null);
      setWinnerPick("");
      setResultNotes("");
    } catch (e: any) {
      setResultStatus((prev) => ({
        ...prev,
        [conflict.id]: "Error: " + (e?.message ?? "Unknown"),
      }));
    } finally {
      setSubmittingResult(false);
    }
  };

  // ── Pre-battle chronicle ──────────────────────────────────────────────────
  // Calls generate-narrative WITHOUT conflict_id/campaign_id so it does not
  // publish to the War Bulletin (that is reserved for the post-battle chronicle).

  const generatePreNarrative = async (conflict: Conflict) => {
    setGeneratingPreFor(conflict.id);
    setPreNarratives((prev) => ({ ...prev, [conflict.id]: "" }));
    try {
      const token = await getToken();
      if (!token) { setGeneratingPreFor(null); return; }

      const mission  = missions.find((m) => m.id === conflict.mission_id);
      const factionA = memberLabel(members, conflict.player_a);
      const factionB = memberLabel(members, conflict.player_b);

      const prompt = [
        "You are a Warhammer 40,000 campaign chronicler writing a dramatic pre-battle dispatch.",
        "Write 2-3 gripping paragraphs in grimdark 40K style about this imminent territorial engagement.",
        "Describe the factions assembling, what each seeks, and why this sector matters to them.",
        "End with an ominous sense that blood will be spilled. Do NOT write the outcome \u2014 the battle has not yet taken place.",
        "",
        "ENGAGEMENT DETAILS:",
        "Location: " + titleCase(conflict.zone_key) + " \u2014 Sector " + conflict.sector_key.toUpperCase(),
        "Attacker: " + factionA,
        "Defender: " + factionB,
        "Round: " + conflict.round_number,
        mission
          ? "Mission: " + mission.name + " \u2014 " + mission.description
          : "Mission: Unknown \u2014 a brutal territorial contest for sector control.",
        conflict.twist_tags?.length
          ? "Battlefield conditions: " + conflict.twist_tags.join(", ")
          : "",
        "",
        "Flowing prose only. No markdown headers or bullet points.",
      ].filter(Boolean).join("\n");

      const { data, error } = await supabase.functions.invoke("generate-narrative", {
        body: { prompt, max_tokens: 600 },
        headers: { Authorization: "Bearer " + token },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Generation failed");
      setPreNarratives((prev) => ({ ...prev, [conflict.id]: data.text ?? "" }));
    } catch (e: any) {
      setPreNarratives((prev) => ({
        ...prev,
        [conflict.id]: "Generation failed: " + (e?.message ?? "Unknown"),
      }));
    } finally {
      setGeneratingPreFor(null);
    }
  };

  // ── Post-battle chronicle ─────────────────────────────────────────────────
  // Passes conflict_id and campaign_id so the edge function also publishes
  // the narrative to the War Bulletin.

  const generatePostNarrative = async (conflict: Conflict) => {
    setGeneratingPostFor(conflict.id);
    setPostNarratives((prev) => ({ ...prev, [conflict.id]: "" }));
    setPostPublished((prev) => ({ ...prev, [conflict.id]: false }));
    try {
      const token = await getToken();
      if (!token) { setGeneratingPostFor(null); return; }

      const result       = results[conflict.id];
      const mission      = missions.find((m) => m.id === conflict.mission_id);
      const factionA     = memberLabel(members, conflict.player_a);
      const factionB     = memberLabel(members, conflict.player_b);
      const winnerUid    = result?.winner_user_id ?? null;
      const winnerLabel  = winnerUid ? memberLabel(members, winnerUid) : "a draw";
      const outcomeNotes = (result?.outcome_json as any)?.notes ?? "";

      const chronicle_title =
        "Chronicle: " + titleCase(conflict.zone_key) +
        " \u2014 " + conflict.sector_key.toUpperCase() +
        "  (Round " + conflict.round_number + ")";

      const prompt = [
        "You are a Warhammer 40,000 campaign chronicler writing a vivid battle report.",
        "Write 3-4 paragraphs in grimdark 40K style about this concluded engagement.",
        "Be specific about the zone, factions, and mission. End with the outcome and its consequences.",
        "",
        "ENGAGEMENT DETAILS:",
        "Zone: " + titleCase(conflict.zone_key),
        "Sector: " + conflict.sector_key.toUpperCase(),
        "Round: " + conflict.round_number,
        "Combatants: " + factionA + " vs " + factionB,
        "Mission: " + (mission
          ? mission.name + " (" + mission.mission_type + ")"
          : "Unknown"),
        mission ? "Mission objective: " + mission.description : "",
        "Outcome: " + (result
          ? winnerUid
            ? memberLabel(members, winnerUid) + " victorious"
            : "drawn engagement"
          : "unresolved"),
        outcomeNotes
          ? "Notes from the field: " + outcomeNotes
          : "",
        conflict.twist_tags?.length
          ? "Battlefield twist: " + conflict.twist_tags.join(", ")
          : "",
        "",
        "Flowing prose only \u2014 no markdown headers or bullet points.",
      ].filter(Boolean).join("\n");

      const { data, error } = await supabase.functions.invoke("generate-narrative", {
        body: {
          prompt,
          max_tokens:      800,
          conflict_id:     conflict.id,
          campaign_id:     conflict.campaign_id,
          round_number:    conflict.round_number,
          chronicle_title,
        },
        headers: { Authorization: "Bearer " + token },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Generation failed");
      setPostNarratives((prev) => ({ ...prev, [conflict.id]: data.text ?? "" }));
      setPostPublished((prev) => ({ ...prev, [conflict.id]: data.published === true }));
    } catch (e: any) {
      setPostNarratives((prev) => ({
        ...prev,
        [conflict.id]: "Generation failed: " + (e?.message ?? "Unknown"),
      }));
    } finally {
      setGeneratingPostFor(null);
    }
  };

  // ── Alliance actions ──────────────────────────────────────────────────────

  const allianceAction = async (
    conflict: Conflict,
    action: "propose" | "withdraw" | "decline" | "accept"
  ) => {
    if (!uid) return;
    setAllianceWorking(conflict.id);
    setAllianceStatus((prev) => ({ ...prev, [conflict.id]: "" }));
    try {
      const token = await getToken();
      if (!token) throw new Error("Session expired \u2014 refresh.");
      if (action === "accept") {
        const { data, error } = await supabase.functions.invoke("form-alliance", {
          body: { conflict_id: conflict.id },
          headers: { Authorization: "Bearer " + token },
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error ?? "Alliance failed");
        setAllianceStatus((prev) => ({
          ...prev,
          [conflict.id]: data.message ?? "Ceasefire pact formed.",
        }));
      } else {
        const { data, error } = await supabase.functions.invoke("propose-alliance", {
          body: { conflict_id: conflict.id, action },
          headers: { Authorization: "Bearer " + token },
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error ?? "Action failed");
        setAllianceStatus((prev) => ({
          ...prev,
          [conflict.id]: data.message ?? "Done.",
        }));
      }
      await load(campaignId);
    } catch (e: any) {
      setAllianceStatus((prev) => ({
        ...prev,
        [conflict.id]: "Error: " + (e?.message ?? "Unknown"),
      }));
    } finally {
      setAllianceWorking(null);
    }
  };

  // ── Sub-renders ───────────────────────────────────────────────────────────

  const renderResultForm = (conflict: Conflict) => {
    const isConfirming = !!(
      results[conflict.id] &&
      !results[conflict.id].confirmed &&
      results[conflict.id].reported_by !== uid
    );
    return (
      <div className="space-y-3 pt-1">
        <div>
          <label className="text-xs text-parchment/50 mb-1 block">Who won?</label>
          <div className="flex flex-wrap gap-2">
            {[conflict.player_a, conflict.player_b].map((pid) => (
              <button key={pid}
                className={[
                  "px-3 py-1.5 rounded border text-sm transition-colors",
                  winnerPick === pid
                    ? "border-brass/70 bg-brass/25 text-parchment"
                    : "border-brass/25 bg-void hover:border-brass/50 text-parchment/70",
                ].join(" ")}
                onClick={() => setWinnerPick(pid)}
              >
                {memberLabel(members, pid)}
              </button>
            ))}
            <button
              className={[
                "px-3 py-1.5 rounded border text-sm transition-colors",
                winnerPick === "draw"
                  ? "border-parchment/50 bg-parchment/10 text-parchment"
                  : "border-parchment/20 bg-void hover:border-parchment/40 text-parchment/50",
              ].join(" ")}
              onClick={() => setWinnerPick("draw")}
            >
              Draw
            </button>
          </div>
        </div>

        {!isConfirming && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-parchment/50 mb-1 block">NIP earned (winner)</label>
              <input type="number" min={0} max={10} value={nipEarned}
                onChange={(e) => setNipEarned(parseInt(e.target.value) || 0)}
                className="w-full px-2 py-1 rounded bg-void border border-brass/30 text-sm text-center"
              />
            </div>
            <div>
              <label className="text-xs text-parchment/50 mb-1 block">NCP earned (winner)</label>
              <input type="number" min={0} max={5} value={ncpEarned}
                onChange={(e) => setNcpEarned(parseInt(e.target.value) || 0)}
                className="w-full px-2 py-1 rounded bg-void border border-brass/30 text-sm text-center"
              />
            </div>
          </div>
        )}

        <div>
          <label className="text-xs text-parchment/50 mb-1 block">Notes (optional)</label>
          <textarea rows={2}
            className="w-full px-2 py-1.5 rounded bg-void border border-brass/30 text-sm resize-none"
            placeholder="Anything notable about the battle\u2026"
            value={resultNotes}
            onChange={(e) => setResultNotes(e.target.value)}
          />
        </div>

        <div className="flex gap-2 items-center">
          <button
            disabled={!winnerPick || submittingResult}
            className="px-4 py-1.5 rounded bg-brass/25 border border-brass/50 hover:bg-brass/35 text-sm font-semibold disabled:opacity-40"
            onClick={() => submitResult(conflict)}
          >
            {submittingResult
              ? "Submitting\u2026"
              : isConfirming ? "Confirm Result" : "Submit Result"}
          </button>
          <button
            className="text-xs text-parchment/40 hover:text-parchment/60 underline"
            onClick={() => { setReportingFor(null); setWinnerPick(""); setResultNotes(""); }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  const renderAllianceSection = (conflict: Conflict) => {
    if (!uid) return null;
    const isInvolved = uid === conflict.player_a || uid === conflict.player_b;
    if (!isInvolved) return null;

    if (conflict.status === "allied") {
      return (
        <div className="pt-2">
          <div className="rounded border border-brass/30 bg-brass/5 px-3 py-2 flex items-center gap-2">
            <span className="text-brass text-base">\u26dc</span>
            <span className="text-parchment/80 text-sm">
              Ceasefire Pact \u2014 no battle took place. Both factions stood down.
            </span>
          </div>
        </div>
      );
    }

    if (conflict.status !== "scheduled") return null;

    const proposedByMe       = conflict.alliance_proposed_by === uid;
    const proposedByOpponent = conflict.alliance_proposed_by !== null && conflict.alliance_proposed_by !== uid;
    const isWorking          = allianceWorking === conflict.id;
    const statusMsg          = allianceStatus[conflict.id];
    const opponentLabel      = uid === conflict.player_a
      ? memberLabel(members, conflict.player_b)
      : memberLabel(members, conflict.player_a);

    return (
      <div className="border-t border-brass/15 pt-3">
        <div className="text-xs text-parchment/40 uppercase tracking-widest mb-2">
          Ceasefire Negotiation
        </div>

        {!proposedByMe && !proposedByOpponent && (
          <div className="space-y-2">
            <p className="text-xs text-parchment/50 leading-snug">
              Rather than fight, your factions may agree to a ceasefire. A public
              announcement will be posted to the War Bulletin.
            </p>
            <button
              disabled={isWorking}
              className="px-3 py-1.5 rounded bg-brass/10 border border-brass/25 hover:bg-brass/20 text-xs transition-colors disabled:opacity-40"
              onClick={() => allianceAction(conflict, "propose")}
            >
              {isWorking ? "Sending\u2026" : "\u26dc Propose Ceasefire"}
            </button>
          </div>
        )}

        {proposedByMe && (
          <div className="space-y-2">
            <div className="rounded border border-brass/20 bg-void/60 px-3 py-2">
              <p className="text-sm text-parchment/70">
                <span className="text-brass">\u26dc</span> Ceasefire proposed \u2014 awaiting{" "}
                <span className="text-brass">{opponentLabel}</span>.
              </p>
            </div>
            <button
              disabled={isWorking}
              className="text-xs text-parchment/40 hover:text-parchment/60 underline transition-colors disabled:opacity-40"
              onClick={() => allianceAction(conflict, "withdraw")}
            >
              {isWorking ? "Withdrawing\u2026" : "Withdraw proposal"}
            </button>
          </div>
        )}

        {proposedByOpponent && (
          <div className="rounded border border-brass/25 bg-void/60 px-3 py-2 space-y-2">
            <p className="text-sm text-parchment/80">
              <span className="text-brass">{opponentLabel}</span> has proposed a ceasefire.
            </p>
            <div className="flex gap-2 flex-wrap">
              <button
                disabled={isWorking}
                className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm font-semibold disabled:opacity-40 transition-colors"
                onClick={() => allianceAction(conflict, "accept")}
              >
                {isWorking ? "Forming pact\u2026" : "\u26dc Accept Ceasefire"}
              </button>
              <button
                disabled={isWorking}
                className="px-3 py-1.5 rounded bg-void border border-blood/25 hover:border-blood/50 text-sm text-parchment/60 disabled:opacity-40 transition-colors"
                onClick={() => allianceAction(conflict, "decline")}
              >
                {isWorking ? "Declining\u2026" : "Decline"}
              </button>
            </div>
          </div>
        )}

        {statusMsg && (
          <p className={"mt-2 text-xs " + (statusMsg.startsWith("Error")
            ? "text-blood/80" : "text-parchment/50")}>
            {statusMsg}
          </p>
        )}
      </div>
    );
  };

  // ── Render conflict card ──────────────────────────────────────────────────

  const renderConflict = (conflict: Conflict) => {
    const existing         = results[conflict.id];
    const isInvolved       = uid === conflict.player_a || uid === conflict.player_b;
    const isReporting      = reportingFor === conflict.id;
    const isChoosingMs     = choosingMissionFor === conflict.id;
    const preNarrative     = preNarratives[conflict.id] ?? "";
    const postNarrative    = postNarratives[conflict.id] ?? "";
    const isGeneratingPre  = generatingPreFor  === conflict.id;
    const isGeneratingPost = generatingPostFor === conflict.id;
    const wasPublished     = postPublished[conflict.id] ?? false;
    const mission          = missions.find((m) => m.id === conflict.mission_id);
    const alreadyReported  = existing?.reported_by === uid;
    const confirmed        = existing?.confirmed ?? false;
    const canConfirm       = existing && !confirmed && existing.reported_by !== uid && isInvolved;
    const isAllied         = conflict.status === "allied";
    const factionA         = memberLabel(members, conflict.player_a);
    const factionB         = memberLabel(members, conflict.player_b);
    const opponentLabel    = uid === conflict.player_a
      ? memberLabel(members, conflict.player_b)
      : memberLabel(members, conflict.player_a);

    const showResult     = canShowResult(conflict);
    const showPost       = canShowPostChronicle(conflict);
    const showInfluence  =
      conflict.mission_status !== "assigned" &&
      isInvolved &&
      !isAllied &&
      conflict.status !== "resolved";

    return (
      <Card
        key={conflict.id}
        title={
          titleCase(conflict.zone_key) +
          " \u2014 " + conflict.sector_key.toUpperCase() +
          "  (Round " + conflict.round_number + ")"
        }
      >
        {/* ── 2-Column layout ─────────────────────────────────────────── */}
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4">

          {/* LEFT: Combatants → Mission Influence → Alliance */}
          <div className="space-y-4">

            {/* Combatants */}
            <div>
              <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1">
                Combatants
              </div>
              <div className="text-brass font-semibold">{factionA}</div>
              <div className="text-parchment/40 text-xs mt-0.5">vs</div>
              <div className="text-brass font-semibold">{factionB}</div>
              {conflict.twist_tags?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {conflict.twist_tags.map((t) => (
                    <span key={t}
                      className="text-xs px-1.5 py-0.5 rounded bg-blood/10 border border-blood/20 text-blood/70">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Mission Influence — moved up from old position at bottom */}
            {showInfluence && (
              <div className="border-t border-brass/15 pt-3">
                <div className="text-xs text-parchment/40 uppercase tracking-widest mb-2">
                  Mission Influence
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="px-3 py-1.5 rounded bg-brass/15 border border-brass/30 hover:bg-brass/25 text-xs"
                    onClick={() => submitInfluence(conflict.id, "veto", {}, 2)}
                  >
                    Veto (2 NIP)
                  </button>
                  <button
                    className="px-3 py-1.5 rounded bg-brass/15 border border-brass/30 hover:bg-brass/25 text-xs"
                    onClick={() => {
                      setChoosingMissionFor(isChoosingMs ? null : conflict.id);
                      setPickedMission("");
                    }}
                  >
                    Choose Mission (3 NIP)
                  </button>
                  <button
                    className="px-3 py-1.5 rounded bg-brass/15 border border-brass/30 hover:bg-brass/25 text-xs"
                    onClick={() =>
                      submitInfluence(conflict.id, "twist", { twist: "power_flicker" }, 1)
                    }
                  >
                    Add Twist (1 NIP)
                  </button>
                </div>

                {isChoosingMs && (
                  <div className="mt-2 space-y-2">
                    <select
                      className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm"
                      value={pickedMission}
                      onChange={(e) => setPickedMission(e.target.value)}
                    >
                      <option value="">&#8212; Select a mission &#8212;</option>
                      {missions.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.mission_type})
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <button
                        disabled={!pickedMission}
                        className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs disabled:opacity-40"
                        onClick={() =>
                          pickedMission &&
                          submitInfluence(conflict.id, "choose", { mission_id: pickedMission }, 3)
                        }
                      >
                        Confirm Choice (3 NIP)
                      </button>
                      <button
                        className="text-xs text-parchment/40 hover:text-parchment/60 underline"
                        onClick={() => { setChoosingMissionFor(null); setPickedMission(""); }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {influenceStatus[conflict.id] && (
                  <p className="mt-1 text-xs text-parchment/50">
                    {influenceStatus[conflict.id]}
                  </p>
                )}
              </div>
            )}

            {/* Ceasefire / Alliance section */}
            {renderAllianceSection(conflict)}

          </div>
          {/* end LEFT */}

          {/* RIGHT: Mission → SVG → Pre-Chronicle → Result → Post-Chronicle */}
          <div className="space-y-4">

            {/* Mission info */}
            <div>
              <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1">
                Mission
              </div>
              {mission ? (
                <>
                  <div className="text-parchment font-semibold">{mission.name}</div>
                  <div className="text-xs text-parchment/50 capitalize">{mission.mission_type}</div>
                  <div className="text-xs text-parchment/40 mt-0.5 leading-snug">
                    {mission.description}
                  </div>
                </>
              ) : (
                <div className="text-parchment/30 italic text-xs">
                  {conflict.mission_status === "unassigned"
                    ? "Mission not yet assigned"
                    : "Mission assigned"}
                </div>
              )}
            </div>

            {/* Battlefield Layout SVG */}
            <BattlefieldLayout
              conflictId={conflict.id}
              factionA={factionA}
              factionB={factionB}
            />

            {/* Pre-Battle Dispatch — always available for non-allied conflicts */}
            {!isAllied && (
              <div className="border-t border-brass/15 pt-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-xs text-parchment/40 uppercase tracking-widest">
                    Pre-Battle Dispatch
                  </div>
                  <button
                    disabled={isGeneratingPre}
                    className="px-3 py-1.5 rounded bg-brass/15 border border-brass/25 hover:bg-brass/25 text-xs disabled:opacity-40"
                    onClick={() => generatePreNarrative(conflict)}
                  >
                    {isGeneratingPre
                      ? "Generating\u2026"
                      : "\u2726 Generate Pre-Battle Dispatch"}
                  </button>
                </div>

                {isGeneratingPre && (
                  <div className="mt-2 space-y-1.5">
                    <div className="h-2.5 rounded bg-brass/10 animate-pulse w-full" />
                    <div className="h-2.5 rounded bg-brass/10 animate-pulse w-5/6" />
                    <div className="h-2.5 rounded bg-brass/10 animate-pulse w-4/5" />
                    <p className="text-xs text-parchment/25 italic mt-1">
                      Consulting the war records\u2026
                    </p>
                  </div>
                )}

                {preNarrative && !isGeneratingPre && (
                  <div className="mt-2 rounded border border-brass/20 bg-void/60 px-3 py-3">
                    <p className="text-sm text-parchment/80 leading-relaxed whitespace-pre-wrap">
                      {preNarrative}
                    </p>
                    <button
                      className="mt-2 text-xs text-parchment/30 hover:text-parchment/60 underline"
                      onClick={() => navigator.clipboard.writeText(preNarrative)}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Battle Result — gated to results phase */}
            {!isAllied && showResult && (
              <div className="border-t border-brass/15 pt-3">
                <div className="text-xs text-parchment/40 uppercase tracking-widest mb-2">
                  Battle Result
                </div>

                {confirmed ? (
                  <div className="rounded border border-brass/30 bg-brass/5 px-3 py-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-brass text-base">&#10003;</span>
                      <span className="text-parchment/80">
                        {(existing?.outcome_json as any)?.disputed
                          ? "Result disputed \u2014 awaiting lead adjudication"
                          : existing?.winner_user_id
                            ? memberLabel(members, existing.winner_user_id) + " victorious"
                            : "Drawn engagement"}
                      </span>
                    </div>
                    {(existing?.outcome_json as any)?.notes && (
                      <p className="mt-1 text-xs text-parchment/40 italic">
                        &ldquo;{(existing.outcome_json as any).notes}&rdquo;
                      </p>
                    )}
                  </div>
                ) : existing && alreadyReported ? (
                  <p className="text-sm text-parchment/50 italic">
                    Your result is submitted \u2014 awaiting confirmation from {opponentLabel}.
                  </p>
                ) : canConfirm ? (
                  <div className="rounded border border-brass/25 bg-void/60 px-3 py-2 space-y-2">
                    <p className="text-sm text-parchment/80">
                      <span className="text-brass">{opponentLabel}</span> has reported
                      a result. Confirm or dispute:
                    </p>
                    {!isReporting ? (
                      <button
                        className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                        onClick={() => { setReportingFor(conflict.id); setWinnerPick(""); }}
                      >
                        Confirm / Dispute Result
                      </button>
                    ) : renderResultForm(conflict)}
                  </div>
                ) : conflict.status === "resolved" ? null
                  : isInvolved && !isReporting ? (
                  <button
                    className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                    onClick={() => {
                      setReportingFor(conflict.id);
                      setWinnerPick("");
                      setResultNotes("");
                      setNipEarned(2);
                      setNcpEarned(0);
                    }}
                  >
                    Report Result
                  </button>
                ) : isReporting ? renderResultForm(conflict) : null}

                {resultStatus[conflict.id] && (
                  <p className={"mt-2 text-xs " + (resultStatus[conflict.id].startsWith("Error")
                    ? "text-blood/80" : "text-parchment/50")}>
                    {resultStatus[conflict.id]}
                  </p>
                )}
              </div>
            )}

            {/* Phase notice — shown when result is not yet accessible */}
            {!isAllied && !showResult && conflict.round_number === roundNumber && (
              <div className="border-t border-brass/15 pt-3">
                <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1">
                  Battle Result
                </div>
                <p className="text-xs text-parchment/30 italic">
                  Results may be reported once the campaign advances to the Results phase.
                </p>
              </div>
            )}

            {/* Post-Battle Chronicle — results phase or past rounds */}
            {!isAllied && showPost && (
              <div className="border-t border-brass/15 pt-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-xs text-parchment/40 uppercase tracking-widest">
                    Battle Chronicle
                  </div>
                  <button
                    disabled={isGeneratingPost}
                    className="px-3 py-1.5 rounded bg-brass/15 border border-brass/25 hover:bg-brass/25 text-xs disabled:opacity-40"
                    onClick={() => generatePostNarrative(conflict)}
                  >
                    {isGeneratingPost
                      ? "Generating\u2026"
                      : "\u2726 Generate Chronicle"}
                  </button>
                </div>

                {isGeneratingPost && (
                  <div className="mt-2 space-y-1.5">
                    <div className="h-2.5 rounded bg-brass/10 animate-pulse w-full" />
                    <div className="h-2.5 rounded bg-brass/10 animate-pulse w-5/6" />
                    <div className="h-2.5 rounded bg-brass/10 animate-pulse w-4/5" />
                    <p className="text-xs text-parchment/25 italic mt-1">
                      Consulting the war records\u2026
                    </p>
                  </div>
                )}

                {postNarrative && !isGeneratingPost && (
                  <div className="mt-2 rounded border border-brass/20 bg-void/60 px-3 py-3">
                    <p className="text-sm text-parchment/80 leading-relaxed whitespace-pre-wrap">
                      {postNarrative}
                    </p>
                    <div className="mt-2 flex items-center gap-3 flex-wrap">
                      <button
                        className="text-xs text-parchment/30 hover:text-parchment/60 underline"
                        onClick={() => navigator.clipboard.writeText(postNarrative)}
                      >
                        Copy
                      </button>
                      {wasPublished && (
                        <span className="text-xs text-brass/70 flex items-center gap-1">
                          <span>&#10003;</span> Posted to War Bulletin
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
          {/* end RIGHT */}

        </div>
        {/* end 2-column grid */}
      </Card>
    );
  };

  // ── Page render ───────────────────────────────────────────────────────────

  if (!authChecked) {
    return (
      <Frame title="Engagements" currentPage="conflicts" hideNewCampaign>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-brass/20 border-t-brass rounded-full animate-spin" />
        </div>
      </Frame>
    );
  }

  if (!campaignId) {
    return (
      <Frame title="Engagements" currentPage="conflicts" hideNewCampaign>
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <p className="text-parchment/50">No campaign selected.</p>
          <a href="/"
            className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-brass text-sm">
            Return to Home
          </a>
        </div>
      </Frame>
    );
  }

  const currentConflicts = conflicts.filter((c) => c.round_number === roundNumber);
  const pastConflicts    = conflicts.filter((c) => c.round_number < roundNumber);

  return (
    <Frame title="Engagements" campaignId={campaignId} role={role} currentPage="conflicts">
      <div className="space-y-6">

        {currentConflicts.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xs uppercase tracking-widest text-parchment/40 px-1">
              Round {roundNumber} \u2014 Active Engagements
              {roundStage && (
                <span className="ml-2 text-brass/50">
                  ({titleCase(roundStage)} phase)
                </span>
              )}
            </h2>
            {currentConflicts.map(renderConflict)}
          </div>
        )}

        {currentConflicts.length === 0 && (
          <Card title="No Active Engagements">
            <p className="text-parchment/50 text-sm">
              No conflicts scheduled for Round {roundNumber || "\u2014"}.
              Conflicts are generated when two players move to the same sector.
            </p>
          </Card>
        )}

        {pastConflicts.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xs uppercase tracking-widest text-parchment/40 px-1">
              Past Engagements
            </h2>
            {pastConflicts.map(renderConflict)}
          </div>
        )}

      </div>
    </Frame>
  );
}
