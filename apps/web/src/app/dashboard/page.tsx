// apps/web/src/app/dashboard/page.tsx
// Player command throne — campaign status, mission preference (NIP-gated),
// underdog choice, recap/whisper prompt builders, and quick navigation.
"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// ── Types ─────────────────────────────────────────────────────────────────────

type PlayerState = {
  campaign_id: string;
  user_id: string;
  current_zone_key: string;
  current_sector_key: string;
  nip: number;
  ncp: number;
  status: string;
  public_location: string;
};

type Campaign = {
  id: string;
  name: string;
  phase: number;
  round_number: number;
  instability: number;
};

type Membership = {
  campaign_id: string;
  role: string;
  campaign_name: string;
};

type Round = {
  stage: string;
  round_number: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name);
}

const STARTING_NIP = 1;

// Mission preference options — players spend 1 NIP to influence mission selection
const MISSION_PREF_OPTIONS = [
  { value: "",               label: "— No preference —"       },
  { value: "assassination",  label: "Assassination"            },
  { value: "sabotage",       label: "Sabotage"                 },
  { value: "border_clash",   label: "Border Clash"             },
  { value: "supply_raid",    label: "Supply Raid"              },
  { value: "recon_in_force", label: "Recon in Force"           },
  { value: "zone_mortalis",  label: "Zone Mortalis"            },
  { value: "siege",          label: "Siege"                    },
  { value: "ambush",         label: "Ambush"                   },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [campaignId, setCampaignId]     = useState<string>("");
  const [campaign, setCampaign]         = useState<Campaign | null>(null);
  const [state, setState]               = useState<PlayerState | null>(null);
  const [role, setRole]                 = useState<string>("player");
  const [memberships, setMemberships]   = useState<Membership[]>([]);
  const [currentRound, setCurrentRound] = useState<Round | null>(null);
  const [loadingCampaign, setLoadingCampaign] = useState(false);
  const [pageError, setPageError]       = useState<string | null>(null);

  // Underdog
  const [underdogChoice, setUnderdogChoice] = useState<string>("+2 NIP");

  // Mission preference
  const [missionPref, setMissionPref]             = useState<string>("");
  const [missionPrefSaved, setMissionPrefSaved]   = useState<string>("");
  const [missionPrefStatus, setMissionPrefStatus] = useState<string>("");
  const [submittingPref, setSubmittingPref]       = useState(false);

  // ── Accept pending invites ────────────────────────────────────────────────

  const acceptInvites = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      await supabase.functions.invoke("accept-invites", { body: {} });
    } catch { /* non-fatal */ }
  };

  // ── Load memberships ──────────────────────────────────────────────────────

  const loadMemberships = useCallback(async (uid: string) => {
    const { data: mem, error } = await supabase
      .from("campaign_members")
      .select("campaign_id, role, campaigns(name)")
      .eq("user_id", uid);

    if (error) { setPageError(error.message); return; }

    const rows = (mem ?? []).map(m => ({
      campaign_id:   m.campaign_id,
      role:          m.role,
      campaign_name: (m.campaigns as any)?.name ?? m.campaign_id,
    }));
    setMemberships(rows);

    const q = getQueryParam("campaign");
    if (q)               setCampaignId(q);
    else if (rows.length) setCampaignId(rows[0].campaign_id);
  }, [supabase]);

  // ── Load campaign ─────────────────────────────────────────────────────────

  const loadCampaign = useCallback(async (uid: string, cid: string) => {
    setLoadingCampaign(true);
    setPageError(null);
    try {
      // Campaign row
      const { data: c, error: ce } = await supabase
        .from("campaigns")
        .select("id,name,phase,round_number,instability")
        .eq("id", cid)
        .single();
      if (ce) throw new Error(ce.message);
      setCampaign(c as Campaign);

      // Membership / role
      const { data: mem, error: me } = await supabase
        .from("campaign_members")
        .select("role")
        .eq("campaign_id", cid)
        .eq("user_id", uid)
        .single();
      if (me) throw new Error("You are not a member of this campaign.");
      setRole(mem.role);

      // Current round stage
      const { data: roundRow } = await supabase
        .from("rounds")
        .select("stage, round_number")
        .eq("campaign_id", cid)
        .eq("round_number", c.round_number)
        .maybeSingle();
      setCurrentRound(roundRow as Round | null);

      // Player state — create default row if missing
      const { data: existing, error: pe } = await supabase
        .from("player_state")
        .select("*")
        .eq("campaign_id", cid)
        .eq("user_id", uid)
        .maybeSingle();
      if (pe) throw new Error(pe.message);

      let ps: PlayerState;
      if (existing) {
        ps = existing as PlayerState;
      } else {
        const { data: inserted, error: insErr } = await supabase
          .from("player_state")
          .insert({
            campaign_id:        cid,
            user_id:            uid,
            nip:                STARTING_NIP,
            ncp:                0,
            current_zone_key:   "unknown",
            current_sector_key: "unknown",
            public_location:    "Unknown",
            status:             "active",
          })
          .select("*")
          .single();
        if (insErr) throw new Error(insErr.message);
        ps = inserted as PlayerState;
      }

      // setState was missing from the live version — this was the bug
      // causing the entire player card block to never render
      setState(ps);

      // Load any saved mission preference for this round
      if (roundRow) {
        const { data: prefRow } = await supabase
          .from("round_spends")
          .select("mission_pref")
          .eq("campaign_id", cid)
          .eq("user_id", uid)
          .eq("round_number", roundRow.round_number)
          .maybeSingle();
        const saved = (prefRow as any)?.mission_pref ?? "";
        setMissionPrefSaved(saved);
        setMissionPref(saved);
      }

    } catch (e: any) {
      setPageError(e?.message ?? String(e));
    } finally {
      setLoadingCampaign(false);
    }
  }, [supabase]);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const { data: userResp } = await supabase.auth.getUser();
      const uid = userResp.user?.id;
      if (!uid) return;
      await acceptInvites();
      await loadMemberships(uid);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!campaignId) return;
    (async () => {
      const { data: userResp } = await supabase.auth.getUser();
      const uid = userResp.user?.id;
      if (!uid) return;
      await loadCampaign(uid, campaignId);
    })();
  }, [campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mission preference submit ─────────────────────────────────────────────

  const submitMissionPref = async () => {
    if (!campaignId || !currentRound || submittingPref) return;
    if ((state?.nip ?? 0) < 1) return;

    setSubmittingPref(true);
    setMissionPrefStatus("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Session expired — refresh.");

      const { data, error } = await supabase.functions.invoke("spend-nip", {
        body: { campaign_id: campaignId, mode: "mission_pref", mission_pref: missionPref },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Unknown error");

      setMissionPrefSaved(missionPref);
      setMissionPrefStatus("Preference saved.");

      // Refresh to show updated NIP balance
      const { data: userResp } = await supabase.auth.getUser();
      if (userResp.user) await loadCampaign(userResp.user.id, campaignId);

    } catch (e: any) {
      setMissionPrefStatus(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setSubmittingPref(false);
    }
  };

  // ── Recap prompt builders ─────────────────────────────────────────────────

  const makePublicRecapPrompt = async () => {
    if (!campaign) return;
    const { data: publicPosts } = await supabase
      .from("posts")
      .select("round_number,title,body,tags,created_at")
      .eq("campaign_id", campaign.id)
      .eq("visibility", "public")
      .order("round_number", { ascending: false })
      .limit(40);

    const prompt = [
      `Campaign: ${campaign.name}`,
      `Phase: ${campaign.phase}`,
      `Current Round: ${campaign.round_number}`,
      `Halo Instability: ${campaign.instability}/10`,
      "",
      "PUBLIC CONTEXT (no secrets):",
      JSON.stringify(publicPosts ?? [], null, 2),
      "",
      "Task:",
      "1) Write a 300–600 word grimdark 'Halo War Bulletin' summarizing recent public events.",
      "2) Include paranoia, disputed sightings, and ominous references to the Ashen King.",
      "3) Suggest 3 bounties for next round tied to public tensions.",
      "Tone: 40K grimdark, cosmic horror, military dispatch.",
    ].join("\n");

    await navigator.clipboard.writeText(prompt);
    alert("Public recap prompt copied to clipboard.");
  };

  const makePrivateWhisperPrompt = async () => {
    if (!campaign || !state) return;
    const { data: myPosts } = await supabase
      .from("posts")
      .select("round_number,title,body,tags,created_at")
      .eq("campaign_id", campaign.id)
      .eq("visibility", "private")
      .order("round_number", { ascending: false })
      .limit(40);

    const prompt = [
      `Campaign: ${campaign.name}`,
      `Phase: ${campaign.phase}`,
      `Current Round: ${campaign.round_number}`,
      `Halo Instability: ${campaign.instability}/10`,
      "",
      "MY PRIVATE CONTEXT (include secrets):",
      `My location (secret): ${state.current_zone_key}-${state.current_sector_key}`,
      `My status: ${state.status}`,
      `My NIP/NCP: ${state.nip}/${state.ncp}`,
      "My recent private notes:",
      JSON.stringify(myPosts ?? [], null, 2),
      "",
      "Task:",
      "Write a 2–4 paragraph private 'whisper' tailored to my faction/commander.",
      "Include: 1 opportunity, 1 threat, 1 rumor, and 1 suggested objective for next battle.",
      "Tone: ominous, conspiratorial, cinematic.",
    ].join("\n");

    await navigator.clipboard.writeText(prompt);
    alert("Private whisper prompt copied to clipboard.");
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const hasNip       = (state?.nip ?? 0) >= 1;
  const isSpendStage = currentRound?.stage === "spend";
  const canSubmitPref = hasNip && isSpendStage && !submittingPref;
  const prefChanged  = missionPref !== missionPrefSaved;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame title="Command Throne" right={<a className="underline" href="/campaigns">Campaigns</a>}>
      <div className="space-y-6">

        {/* ── Campaign selector ── */}
        <Card title="My Campaigns">
          {memberships.length ? (
            <div className="flex flex-col md:flex-row gap-3 items-start md:items-center">
              <select
                className="flex-1 px-3 py-2 rounded bg-void border border-brass/30"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
              >
                {memberships.map(m => (
                  <option key={m.campaign_id} value={m.campaign_id}>
                    {m.campaign_name} ({m.role})
                  </option>
                ))}
              </select>
              <a className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                href={`/map?campaign=${campaignId}`}>Map</a>
              <a className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                href={`/conflicts?campaign=${campaignId}`}>Conflicts</a>
              {(role === "lead" || role === "admin") && (
                <a className="px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30"
                  href={`/lead?campaign=${campaignId}`}>Lead Controls</a>
              )}
            </div>
          ) : (
            <p className="text-parchment/70">
              No campaigns found. Create one in{" "}
              <a className="underline text-brass" href="/campaigns">Campaigns</a>.
            </p>
          )}
          <p className="mt-2 text-xs text-parchment/50">
            Share deep links like{" "}
            <span className="text-brass">/dashboard?campaign=&lt;id&gt;</span>.
          </p>
        </Card>

        {loadingCampaign && (
          <p className="text-parchment/50 animate-pulse text-sm px-1">Loading campaign data…</p>
        )}
        {pageError && (
          <Card title="Error">
            <p className="text-blood text-sm">{pageError}</p>
          </Card>
        )}

        {/* ── Player cards — only render once state is loaded ── */}
        {campaign && state && !loadingCampaign && (
          <div className="grid md:grid-cols-2 gap-6">

            {/* ── Status ── */}
            <Card title="Your Status">
              <div className="space-y-2 text-sm text-parchment/85">
                <div><span className="text-brass">Campaign:</span> {campaign.name}</div>
                <div>
                  <span className="text-brass">Phase:</span> {campaign.phase}
                  &nbsp;&nbsp;
                  <span className="text-brass">Round:</span> {campaign.round_number}
                  {currentRound && (
                    <span className="ml-2 text-xs text-parchment/40 uppercase tracking-wider">
                      [{currentRound.stage}]
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-brass">Instability:</span>{" "}
                  <span className={
                    campaign.instability >= 8 ? "text-blood font-semibold" :
                    campaign.instability >= 4 ? "text-yellow-500/80" :
                    "text-parchment/80"
                  }>
                    {campaign.instability}/10
                  </span>
                </div>
                <div><span className="text-brass">Role:</span> {role}</div>
                <div className="pt-2 border-t border-brass/20 space-y-1">
                  <div>
                    <span className="text-brass">NIP:</span> {state.nip}
                    &nbsp;&nbsp;
                    <span className="text-brass">NCP:</span> {state.ncp}
                  </div>
                  <div>
                    <span className="text-brass">Location:</span>{" "}
                    {state.current_zone_key === "unknown"
                      ? <span className="text-parchment/40 italic">Undeployed</span>
                      : `${state.current_zone_key} – ${state.current_sector_key}`
                    }
                  </div>
                  <div><span className="text-brass">Status:</span> {state.status}</div>
                </div>
              </div>
            </Card>

            {/* ── Mission Preference ── */}
            <Card title="Mission Preference">
              <div className="space-y-3">
                <p className="text-xs text-parchment/60 leading-relaxed">
                  Spend 1 NIP to influence which mission is assigned this round.
                  Your preference is weighed against all players&apos; choices.
                </p>

                {/* Dropdown — visually greyed out when locked */}
                <div className={
                  !hasNip || !isSpendStage
                    ? "opacity-40 pointer-events-none select-none"
                    : ""
                }>
                  <select
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm"
                    value={missionPref}
                    onChange={(e) => setMissionPref(e.target.value)}
                    disabled={!canSubmitPref}
                  >
                    {MISSION_PREF_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Lock reason */}
                {!hasNip && (
                  <p className="text-xs text-blood/70 italic">
                    ☠ No NIP — mission preference locked this round.
                  </p>
                )}
                {hasNip && !isSpendStage && (
                  <p className="text-xs text-parchment/40 italic">
                    Available during the Spend phase only.
                    {currentRound ? ` Current: ${currentRound.stage}.` : ""}
                  </p>
                )}

                {/* Submit */}
                <button
                  onClick={submitMissionPref}
                  disabled={!canSubmitPref || !prefChanged || !missionPref}
                  className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm font-semibold transition-colors disabled:opacity-40"
                >
                  {submittingPref
                    ? "Submitting…"
                    : missionPrefSaved
                      ? "Update preference (costs 1 NIP)"
                      : "Submit preference (costs 1 NIP)"
                  }
                </button>

                {missionPrefSaved && (
                  <p className="text-xs text-brass/70">
                    ✓ Current preference:{" "}
                    {MISSION_PREF_OPTIONS.find(o => o.value === missionPrefSaved)?.label ?? missionPrefSaved}
                  </p>
                )}

                {missionPrefStatus && (
                  <p className={`text-xs ${
                    missionPrefStatus.startsWith("Error") ? "text-blood/70" : "text-parchment/50"
                  }`}>
                    {missionPrefStatus}
                  </p>
                )}
              </div>
            </Card>

            {/* ── Catch-up / Underdog ── */}
            <Card title="Catch-up Choice (Underdog)">
              <p className="text-parchment/80 text-sm">
                If flagged as <span className="text-brass">Underdog</span> this round, choose one benefit:
              </p>
              <select
                className="mt-3 w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm"
                value={underdogChoice}
                onChange={(e) => setUnderdogChoice(e.target.value)}
              >
                <option>+2 NIP</option>
                <option>+1 NCP next battle</option>
                <option>Free Recon</option>
                <option>Safe Passage (1 move cannot be intercepted)</option>
              </select>
              <p className="mt-2 text-parchment/50 text-xs">
                Underdog status is assigned by the Lead at the start of each round.
              </p>
            </Card>

            {/* ── Recaps & Whispers ── */}
            <Card title="Recaps & Whispers">
              <div className="space-y-3">
                {(role === "lead" || role === "admin") && (
                  <button
                    className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                    onClick={makePublicRecapPrompt}
                  >
                    Copy PUBLIC recap prompt (Lead)
                  </button>
                )}
                <button
                  className="w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-sm"
                  onClick={makePrivateWhisperPrompt}
                >
                  Copy PRIVATE whisper prompt (You)
                </button>
              </div>
            </Card>

            {/* ── Quick Links ── */}
            <Card title="Quick Links">
              <div className="flex flex-wrap gap-3">
                <a className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                  href={`/map?campaign=${campaignId}`}>Map</a>
                <a className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                  href={`/conflicts?campaign=${campaignId}`}>Conflicts</a>
                <a className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                  href={`/ledger?campaign=${campaignId}`}>Ledger</a>
              </div>
            </Card>

          </div>
        )}
      </div>
    </Frame>
  );
}
