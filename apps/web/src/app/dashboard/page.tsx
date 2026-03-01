"use client";
import React, { useEffect, useMemo, useState } from "react";
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
  public_location: string | null;
};

type Campaign = {
  id: string;
  name: string;
  phase: number;
  round_number: number;
  instability: number;
  map_id: string | null;
};

type Membership = { campaign_id: string; role: string; campaign_name: string };

type MapZone = { key: string; name: string; sectors: { key: string }[] };

type MapJson = {
  zone_cols?: number;
  zones?: MapZone[];
};

// ── Adjacency helper ──────────────────────────────────────────────────────────
// Returns zone keys that are directly adjacent (horizontal/vertical) to the given zone
// in the zone grid, plus the zone itself (to allow same-zone sector moves).
function getAdjacentZoneKeys(zones: MapZone[], currentZoneKey: string, zoneCols: number): string[] {
  const idx = zones.findIndex((z) => z.key === currentZoneKey);
  if (idx === -1) return [];
  const row = Math.floor(idx / zoneCols);
  const col = idx % zoneCols;
  const adjacent: string[] = [currentZoneKey];
  if (row > 0)                                     adjacent.push(zones[idx - zoneCols]?.key);
  if (idx + zoneCols < zones.length)               adjacent.push(zones[idx + zoneCols]?.key);
  if (col > 0)                                     adjacent.push(zones[idx - 1]?.key);
  if (col < zoneCols - 1 && idx + 1 < zones.length) adjacent.push(zones[idx + 1]?.key);
  return adjacent.filter(Boolean) as string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name);
}

function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

const NIP_PER_NCP = 3;

// ── Component ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [campaignId, setCampaignId]   = useState<string>("");
  const [campaign, setCampaign]       = useState<Campaign | null>(null);
  const [state, setState]             = useState<PlayerState | null>(null);
  const [role, setRole]               = useState<string>("player");
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [underdogChoice, setUnderdogChoice] = useState<string>("+2 NIP");

  // Secret location
  const [secretZone, setSecretZone]     = useState<string | null>(null);
  const [secretSector, setSecretSector] = useState<string | null>(null);

  // Map + round
  const [mapJson, setMapJson]       = useState<MapJson | null>(null);
  const [roundStage, setRoundStage] = useState<string | null>(null);
  const [alreadyMoved, setAlreadyMoved] = useState(false);

  // Movement UI
  const [selectedZone, setSelectedZone]     = useState<string>("");
  const [selectedSector, setSelectedSector] = useState<string>("");
  const [movePending, setMovePending]       = useState(false);
  const [moveStatus, setMoveStatus]         = useState<string>("");

  // NIP trade
  const [tradeQty, setTradeQty]       = useState(1);
  const [tradePending, setTradePending] = useState(false);
  const [tradeStatus, setTradeStatus]  = useState<string>("");

  // ── Load memberships ────────────────────────────────────────────────────────
  const loadMemberships = async (uid: string) => {
    const { data: mem } = await supabase
      .from("campaign_members")
      .select("campaign_id, role, campaigns(name)")
      .eq("user_id", uid);
    setMemberships(
      (mem ?? []).map((m) => ({
        campaign_id: m.campaign_id,
        role: m.role,
        campaign_name: (m.campaigns as any)?.name ?? m.campaign_id,
      }))
    );
    const q = getQueryParam("campaign");
    if (q) setCampaignId(q);
    else if (!campaignId && mem?.length) setCampaignId(mem[0].campaign_id);
  };

  // ── Load campaign data ──────────────────────────────────────────────────────
  const loadCampaign = async (uid: string, cid: string) => {
    const { data: c } = await supabase
      .from("campaigns")
      .select("id,name,phase,round_number,instability,map_id")
      .eq("id", cid)
      .single();
    if (!c) return;
    setCampaign(c as Campaign);

    const { data: mem } = await supabase
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", cid)
      .eq("user_id", uid)
      .single();
    setRole(mem?.role ?? "player");

    // Player state
    const { data: existing } = await supabase
      .from("player_state")
      .select("*")
      .eq("campaign_id", cid)
      .eq("user_id", uid)
      .maybeSingle();

    if (existing) {
      setState(existing as PlayerState);
    } else {
      const { data: inserted } = await supabase
        .from("player_state")
        .insert({ campaign_id: cid, user_id: uid, nip: 0, ncp: 0, current_zone_key: "unknown", current_sector_key: "unknown", public_location: "Unknown" })
        .select("*").single();
      if (inserted) setState(inserted as PlayerState);
    }

    // Secret location
    const { data: sec } = await supabase
      .from("player_state_secret")
      .select("secret_location, starting_location")
      .eq("campaign_id", cid)
      .eq("user_id", uid)
      .maybeSingle();

    const loc = sec?.secret_location ?? sec?.starting_location ?? null;
    setSecretZone(loc ? loc.split(":")[0] : null);
    setSecretSector(loc ? loc.split(":")[1] : null);

    // Round stage
    const { data: rd } = await supabase
      .from("rounds")
      .select("stage")
      .eq("campaign_id", cid)
      .eq("round_number", (c as any).round_number)
      .maybeSingle();
    setRoundStage(rd?.stage ?? null);

    // Already moved?
    const { data: mv } = await supabase
      .from("moves")
      .select("id")
      .eq("campaign_id", cid)
      .eq("user_id", uid)
      .eq("round_number", (c as any).round_number)
      .maybeSingle();
    setAlreadyMoved(!!mv);

    // Map
    if ((c as any).map_id) {
      const { data: mapRow } = await supabase
        .from("maps")
        .select("map_json")
        .eq("id", (c as any).map_id)
        .maybeSingle();
      if (mapRow?.map_json) setMapJson(mapRow.map_json as MapJson);
    }
  };

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const uid = data.user?.id;
      if (uid) loadMemberships(uid);
    });
  }, []);

  useEffect(() => {
    if (!campaignId) return;
    supabase.auth.getUser().then(({ data }) => {
      const uid = data.user?.id;
      if (uid) loadCampaign(uid, campaignId);
    });
    setSelectedZone("");
    setSelectedSector("");
    setMoveStatus("");
    setTradeStatus("");
  }, [campaignId]);

  // ── Derived movement values ─────────────────────────────────────────────────
  const zones     = mapJson?.zones ?? [];
  const zoneCols  = mapJson?.zone_cols ?? 2;
  const adjKeys   = secretZone ? getAdjacentZoneKeys(zones, secretZone, zoneCols) : [];

  const sameZone        = zones.find((z) => z.key === secretZone);
  const adjacentZones   = zones.filter((z) => adjKeys.includes(z.key) && z.key !== secretZone);
  const deepStrikeZones = zones.filter((z) => !adjKeys.includes(z.key));

  const isDeepStrike  = !!selectedZone && !adjKeys.includes(selectedZone);
  const nipForMove    = isDeepStrike ? 3 : 0;
  const canAffordMove = (state?.nip ?? 0) >= nipForMove;

  // ── Actions ─────────────────────────────────────────────────────────────────
  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  const submitMove = async () => {
    if (!selectedZone || !selectedSector || !campaignId) return;
    setMovePending(true);
    setMoveStatus("");
    try {
      const token = await getToken();
      if (!token) { setMoveStatus("Session expired — refresh."); return; }
      const { data, error } = await supabase.functions.invoke("submit-move", {
        body: { campaign_id: campaignId, to_zone_key: selectedZone, to_sector_key: selectedSector, is_deep_strike: isDeepStrike },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Move failed");
      const label = titleCase(selectedZone) + " — sector " + selectedSector.toUpperCase();
      setMoveStatus("Orders submitted: moving to " + label + (isDeepStrike ? " (deep strike, 3 NIP spent)" : ""));
      setAlreadyMoved(true);
      const { data: u } = await supabase.auth.getUser();
      if (u.user) await loadCampaign(u.user.id, campaignId);
    } catch (e: any) {
      setMoveStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setMovePending(false);
    }
  };

  const tradeNipForNcp = async () => {
    if (!campaignId || tradeQty < 1) return;
    setTradePending(true);
    setTradeStatus("");
    try {
      const token = await getToken();
      if (!token) { setTradeStatus("Session expired."); return; }
      const { data, error } = await supabase.functions.invoke("spend-nip", {
        body: { campaign_id: campaignId, mode: "trade_for_ncp", quantity: tradeQty },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Trade failed");
      setTradeStatus("Traded " + data.nip_spent + " NIP for " + data.ncp_gained + " NCP. New totals: " + data.nip_new + " NIP / " + data.ncp_new + " NCP.");
      const { data: u } = await supabase.auth.getUser();
      if (u.user) await loadCampaign(u.user.id, campaignId);
    } catch (e: any) {
      setTradeStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setTradePending(false);
    }
  };

  // ── Recap prompts ───────────────────────────────────────────────────────────
  const makePublicRecapPrompt = async () => {
    if (!campaign) return;
    const { data: posts } = await supabase.from("posts").select("round_number,title,body,tags,created_at")
      .eq("campaign_id", campaign.id).eq("visibility", "public").order("round_number", { ascending: false }).limit(40);
    const prompt = [
      "Campaign: " + campaign.name,
      "Phase: " + campaign.phase,
      "Current Round: " + campaign.round_number,
      "Halo Instability: " + campaign.instability + "/10",
      "",
      "PUBLIC CONTEXT (no secrets):",
      JSON.stringify(posts ?? [], null, 2),
      "",
      "Task:",
      "1) Write a 300-600 word grimdark 'Halo War Bulletin' summarizing recent public events.",
      "2) Include paranoia, disputed sightings, and ominous references to the Ashen King.",
      "3) Suggest 3 bounties for next round tied to public tensions.",
      "Tone: 40K grimdark, cosmic horror, military dispatch.",
    ].join("\n");
    await navigator.clipboard.writeText(prompt);
    alert("Public recap prompt copied to clipboard.");
  };

  const makePrivateWhisperPrompt = async () => {
    if (!campaign || !state) return;
    const { data: posts } = await supabase.from("posts").select("round_number,title,body,tags,created_at")
      .eq("campaign_id", campaign.id).eq("visibility", "private").order("round_number", { ascending: false }).limit(40);
    const prompt = [
      "Campaign: " + campaign.name,
      "Phase: " + campaign.phase,
      "Current Round: " + campaign.round_number,
      "Halo Instability: " + campaign.instability + "/10",
      "",
      "MY PRIVATE CONTEXT (include secrets):",
      "My location (secret): " + (secretZone ?? "unknown") + " — " + (secretSector ?? "unknown"),
      "My status: " + state.status,
      "My NIP/NCP: " + state.nip + "/" + state.ncp,
      "My recent private notes:",
      JSON.stringify(posts ?? [], null, 2),
      "",
      "Task:",
      "Write a 2-4 paragraph private 'whisper' tailored to my faction/commander.",
      "Include: 1 opportunity, 1 threat, 1 rumor, and 1 suggested objective for next battle.",
      "Tone: ominous, conspiratorial, cinematic.",
    ].join("\n");
    await navigator.clipboard.writeText(prompt);
    alert("Private whisper prompt copied to clipboard.");
  };

  // ── Zone section sub-component (avoids repetition) ──────────────────────────
  const ZoneSection = ({
    label, zones: zList, colorClass,
  }: { label: string; zones: MapZone[]; colorClass: string }) => {
    if (!zList.length) return null;
    return (
      <div>
        <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1.5">{label}</div>
        <div className="space-y-1.5">
          {zList.map((z) => (
            <div key={z.key} className={"rounded border p-2 " + colorClass.replace("btn", "bg")}>
              <div className="text-xs font-semibold text-parchment/80 mb-1">
                {z.name ?? titleCase(z.key)}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                {z.sectors.map((sec) => {
                  const sKey = sec.key.includes(":") ? sec.key.split(":")[1] : sec.key;
                  const active = selectedZone === z.key && selectedSector === sKey;
                  return (
                    <button
                      key={sec.key}
                      disabled={movePending}
                      onClick={() => { setSelectedZone(z.key); setSelectedSector(sKey!); }}
                      className={[
                        "rounded border px-2 py-1.5 text-xs transition-colors",
                        active ? colorClass + " active" : colorClass,
                      ].join(" ")}
                    >
                      {sKey?.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Frame title="Command Throne" campaignId={campaignId} role={role} currentPage="dashboard">
      <div className="space-y-6">

        {/* Campaign selector */}
        <Card title="My Campaigns">
          {memberships.length ? (
            <select
              className="w-full px-3 py-2 rounded bg-void border border-brass/30"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
            >
              {memberships.map((m) => (
                <option key={m.campaign_id} value={m.campaign_id}>
                  {m.campaign_name} ({m.role})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-parchment/70">
              No campaigns found.{" "}
              <a href="/campaigns" className="text-brass underline">Create one</a>.
            </p>
          )}
        </Card>

        {campaign && state && (
          <div className="space-y-6">

            {/* Status + Resources row */}
            <div className="grid md:grid-cols-2 gap-6">

              <Card title="Your Status">
                <div className="space-y-1.5 text-parchment/85">
                  <div><span className="text-brass">Campaign:</span> {campaign.name}</div>
                  <div>
                    <span className="text-brass">Phase:</span> {campaign.phase} &nbsp;
                    <span className="text-brass">Round:</span> {campaign.round_number}
                  </div>
                  <div><span className="text-brass">Instability:</span> {campaign.instability}/10</div>
                  <div>
                    <span className="text-brass">Stage:</span>{" "}
                    <span className="font-mono text-sm">{roundStage ?? "—"}</span>
                  </div>
                  <div><span className="text-brass">Role:</span> {role}</div>
                  <div className="pt-2 border-t border-brass/20">
                    <div className="text-sm text-parchment/60 mb-0.5">Secret location</div>
                    {secretZone ? (
                      <div className="font-mono text-brass">
                        {titleCase(secretZone)}
                        {secretSector && (
                          <span className="text-parchment/50"> : sector {secretSector.toUpperCase()}</span>
                        )}
                      </div>
                    ) : (
                      <div className="text-parchment/30 italic text-sm">Not yet allocated</div>
                    )}
                    <div className="mt-1"><span className="text-brass">Status:</span> {state.status}</div>
                  </div>
                </div>
              </Card>

              <Card title="Resources">
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded border border-brass/30 bg-void/60 px-4 py-3 text-center">
                      <div className="text-3xl font-bold text-brass">{state.nip}</div>
                      <div className="text-xs text-parchment/50 mt-0.5 uppercase tracking-widest">NIP</div>
                      <div className="text-xs text-parchment/30 mt-0.5">Narrative Influence</div>
                    </div>
                    <div className="rounded border border-parchment/20 bg-void/60 px-4 py-3 text-center">
                      <div className="text-3xl font-bold text-parchment">{state.ncp}</div>
                      <div className="text-xs text-parchment/50 mt-0.5 uppercase tracking-widest">NCP</div>
                      <div className="text-xs text-parchment/30 mt-0.5">Campaign Points</div>
                    </div>
                  </div>

                  <div className="border-t border-brass/20 pt-3">
                    <div className="text-sm text-parchment/70 mb-2">
                      Trade NIP for NCP{" "}
                      <span className="text-parchment/40">({NIP_PER_NCP} NIP = 1 NCP)</span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <label className="text-xs text-parchment/50">Qty:</label>
                      <input
                        type="number" min={1}
                        max={Math.max(1, Math.floor((state.nip ?? 0) / NIP_PER_NCP))}
                        value={tradeQty}
                        onChange={(e) => setTradeQty(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-16 px-2 py-1 rounded bg-void border border-brass/30 text-sm text-center"
                        disabled={tradePending}
                      />
                      <span className="text-xs text-parchment/40">= {tradeQty * NIP_PER_NCP} NIP</span>
                      <button
                        disabled={tradePending || (state.nip ?? 0) < tradeQty * NIP_PER_NCP}
                        className="ml-auto px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs disabled:opacity-40"
                        onClick={tradeNipForNcp}
                      >
                        {tradePending ? "Trading…" : "Trade"}
                      </button>
                    </div>
                    {tradeStatus && (
                      <p className={"mt-2 text-xs " + (tradeStatus.startsWith("Error") ? "text-blood/80" : "text-parchment/60")}>
                        {tradeStatus}
                      </p>
                    )}
                    {(state.nip ?? 0) < NIP_PER_NCP && (
                      <p className="mt-1 text-xs text-parchment/30 italic">
                        Earn more NIP in battle to trade.
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            </div>

            {/* Movement Orders */}
            <Card title={"Movement Orders — Round " + campaign.round_number}>
              {!secretZone ? (
                <p className="text-parchment/40 italic text-sm">
                  Starting location not yet allocated. Wait for the lead to start the campaign.
                </p>
              ) : roundStage !== "movement" ? (
                <p className="text-parchment/50 italic text-sm">
                  Movement is closed.{" "}
                  {roundStage
                    ? "Current stage: " + roundStage + "."
                    : "No active round yet."}
                </p>
              ) : alreadyMoved ? (
                <div className="text-parchment/70 text-sm">
                  <span className="text-brass">✓</span> Movement orders locked in for this round.
                  {moveStatus && <p className="mt-1 text-xs text-parchment/50">{moveStatus}</p>}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="text-sm text-parchment/70">
                    Current position:{" "}
                    <span className="text-brass font-semibold">
                      {titleCase(secretZone)}
                      {secretSector && " — sector " + secretSector.toUpperCase()}
                    </span>
                  </div>

                  {/* Hold (same zone sectors) */}
                  {sameZone && (
                    <div>
                      <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1.5">
                        Hold position{" "}
                        <span className="text-parchment/25 normal-case">(stay in {titleCase(secretZone)})</span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                        {sameZone.sectors.map((sec) => {
                          const sKey = sec.key.includes(":") ? sec.key.split(":")[1] : sec.key;
                          const isCurrent = sKey === secretSector;
                          const active = selectedZone === sameZone.key && selectedSector === sKey;
                          return (
                            <button
                              key={sec.key}
                              disabled={movePending}
                              onClick={() => { setSelectedZone(sameZone.key); setSelectedSector(sKey!); }}
                              className={[
                                "rounded border px-3 py-2 text-xs transition-colors text-center",
                                active
                                  ? "border-brass/70 bg-brass/20 text-parchment"
                                  : "border-brass/25 bg-void hover:border-brass/50 text-parchment/70",
                              ].join(" ")}
                            >
                              Sector {sKey?.toUpperCase()}
                              {isCurrent && <span className="ml-1 text-brass/50 text-xs"> ●</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Adjacent zones — free */}
                  {adjacentZones.length > 0 && (
                    <div>
                      <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1.5">
                        Adjacent zones{" "}
                        <span className="text-parchment/25 normal-case">(free)</span>
                      </div>
                      <div className="space-y-1.5">
                        {adjacentZones.map((z) => (
                          <div key={z.key} className="rounded border border-brass/20 bg-void/40 p-2">
                            <div className="text-xs font-semibold text-parchment/80 mb-1">
                              {z.name ?? titleCase(z.key)}
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                              {z.sectors.map((sec) => {
                                const sKey = sec.key.includes(":") ? sec.key.split(":")[1] : sec.key;
                                const active = selectedZone === z.key && selectedSector === sKey;
                                return (
                                  <button
                                    key={sec.key}
                                    disabled={movePending}
                                    onClick={() => { setSelectedZone(z.key); setSelectedSector(sKey!); }}
                                    className={[
                                      "rounded border px-2 py-1.5 text-xs transition-colors",
                                      active
                                        ? "border-brass/70 bg-brass/20 text-parchment"
                                        : "border-brass/20 bg-void hover:border-brass/40 text-parchment/60",
                                    ].join(" ")}
                                  >
                                    {sKey?.toUpperCase()}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Deep strike zones — 3 NIP */}
                  {deepStrikeZones.length > 0 && (
                    <div>
                      <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1.5">
                        Deep strike{" "}
                        <span className="text-blood/50 normal-case">(3 NIP — orbital insertion)</span>
                      </div>
                      {(state.nip ?? 0) < 3 ? (
                        <p className="text-xs text-parchment/30 italic">
                          You need 3 NIP to deep strike. Current NIP: {state.nip}.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {deepStrikeZones.map((z) => (
                            <div key={z.key} className="rounded border border-blood/20 bg-void/40 p-2">
                              <div className="text-xs font-semibold text-parchment/70 mb-1">
                                {z.name ?? titleCase(z.key)}
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                                {z.sectors.map((sec) => {
                                  const sKey = sec.key.includes(":") ? sec.key.split(":")[1] : sec.key;
                                  const active = selectedZone === z.key && selectedSector === sKey;
                                  return (
                                    <button
                                      key={sec.key}
                                      disabled={movePending}
                                      onClick={() => { setSelectedZone(z.key); setSelectedSector(sKey!); }}
                                      className={[
                                        "rounded border px-2 py-1.5 text-xs transition-colors",
                                        active
                                          ? "border-blood/60 bg-blood/20 text-parchment"
                                          : "border-blood/15 bg-void hover:border-blood/35 text-parchment/50",
                                      ].join(" ")}
                                    >
                                      {sKey?.toUpperCase()}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Submit */}
                  {selectedZone && selectedSector && (
                    <div className="pt-3 border-t border-brass/20">
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="text-sm text-parchment/80 flex-1">
                          Move to{" "}
                          <span className="text-brass font-semibold">
                            {titleCase(selectedZone)} — {selectedSector.toUpperCase()}
                          </span>
                          {isDeepStrike && (
                            <span className="ml-2 text-blood/70 text-xs">(3 NIP)</span>
                          )}
                        </div>
                        <button
                          disabled={movePending || (isDeepStrike && !canAffordMove)}
                          className="shrink-0 px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm disabled:opacity-40"
                          onClick={submitMove}
                        >
                          {movePending ? "Submitting…" : "Submit Orders"}
                        </button>
                      </div>
                      {isDeepStrike && !canAffordMove && (
                        <p className="mt-1 text-xs text-blood/70">
                          Need 3 NIP for deep strike — you have {state.nip}.
                        </p>
                      )}
                    </div>
                  )}

                  {moveStatus && (
                    <p className={"text-xs " + (moveStatus.startsWith("Error") ? "text-blood/80" : "text-parchment/60")}>
                      {moveStatus}
                    </p>
                  )}
                </div>
              )}
            </Card>

            {/* Underdog */}
            {state.status === "underdog" && (
              <Card title="Catch-up Choice (Underdog)">
                <p className="text-parchment/80 text-sm">
                  You are flagged as <span className="text-brass">Underdog</span>. Choose your benefit:
                </p>
                <select
                  className="mt-3 w-full px-3 py-2 rounded bg-void border border-brass/30"
                  value={underdogChoice}
                  onChange={(e) => setUnderdogChoice(e.target.value)}
                >
                  <option>+2 NIP</option>
                  <option>+1 NCP next battle</option>
                  <option>Free Recon</option>
                  <option>Safe Passage (1 move cannot be intercepted)</option>
                </select>
              </Card>
            )}

            {/* Recaps */}
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
                <p className="text-xs text-parchment/30">
                  Paste these prompts into your AI assistant for narrative generation.
                </p>
              </div>
            </Card>

          </div>
        )}
      </div>
    </Frame>
  );
}
