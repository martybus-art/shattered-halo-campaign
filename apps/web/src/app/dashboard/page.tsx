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
type MapJson = { zone_cols?: number; zones?: MapZone[] };
type ConflictRow = { id: string; zone_key: string; sector_key: string; player_a: string; player_b: string; status: string };
type BulletinPost = { id: string; round_number: number; title: string; body: string; created_at: string };

// ── Adjacency helper ──────────────────────────────────────────────────────────
function getAdjacentZoneKeys(zones: MapZone[], currentZoneKey: string, zoneCols: number): string[] {
  const idx = zones.findIndex((z) => z.key === currentZoneKey);
  if (idx === -1) return [];
  const row = Math.floor(idx / zoneCols);
  const col = idx % zoneCols;
  const adjacent: string[] = [currentZoneKey];
  if (row > 0)                                       adjacent.push(zones[idx - zoneCols]?.key);
  if (idx + zoneCols < zones.length)                 adjacent.push(zones[idx + zoneCols]?.key);
  if (col > 0)                                       adjacent.push(zones[idx - 1]?.key);
  if (col < zoneCols - 1 && idx + 1 < zones.length) adjacent.push(zones[idx + 1]?.key);
  return adjacent.filter(Boolean) as string[];
}

function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name);
}

function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

const NIP_PER_NCP        = 3;
const RECON_NIP_COST     = 1;
const DEEP_STRIKE_NIP    = 3;

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

  // Spend phase — recon purchase
  const [hasReconToken, setHasReconToken] = useState(false);
  const [reconPending, setReconPending]   = useState(false);
  const [reconStatus, setReconStatus]     = useState<string>("");

  // Conflicts involving this player
  const [myConflicts, setMyConflicts] = useState<ConflictRow[]>([]);
  const [conflictBanner, setConflictBanner] = useState(false);

  // Bulletin board
  const [bulletinPosts, setBulletinPosts] = useState<BulletinPost[]>([]);

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
        .insert({
          campaign_id: cid, user_id: uid,
          nip: 0, ncp: 0,
          current_zone_key: "unknown", current_sector_key: "unknown",
          public_location: "Unknown",
        })
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

    // Recon token this round?
    const { data: recon } = await supabase
      .from("recon_ops")
      .select("id")
      .eq("campaign_id", cid)
      .eq("user_id", uid)
      .eq("round_number", (c as any).round_number)
      .maybeSingle();
    setHasReconToken(!!recon);

    // Map
    if ((c as any).map_id) {
      const { data: mapRow } = await supabase
        .from("maps")
        .select("map_json")
        .eq("id", (c as any).map_id)
        .maybeSingle();
      if (mapRow?.map_json) setMapJson(mapRow.map_json as MapJson);
    }

    // My conflicts this round
    const { data: conflicts } = await supabase
      .from("conflicts")
      .select("id, zone_key, sector_key, player_a, player_b, status")
      .eq("campaign_id", cid)
      .eq("round_number", (c as any).round_number)
      .or(`player_a.eq.${uid},player_b.eq.${uid}`)
      .neq("status", "resolved");
    const myC = (conflicts ?? []) as ConflictRow[];
    setMyConflicts(myC);
    if (myC.length > 0) setConflictBanner(true);

    // Bulletin — recent public posts (results narratives)
    const { data: posts } = await supabase
      .from("posts")
      .select("id, round_number, title, body, created_at")
      .eq("campaign_id", cid)
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .limit(20);
    setBulletinPosts((posts ?? []) as BulletinPost[]);
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
    setReconStatus("");
    setConflictBanner(false);
  }, [campaignId]);

  // ── Derived movement values ─────────────────────────────────────────────────
  const zones     = mapJson?.zones ?? [];
  const zoneCols  = mapJson?.zone_cols ?? 4;
  const adjKeys   = secretZone ? getAdjacentZoneKeys(zones, secretZone, zoneCols) : [];

  const sameZone        = zones.find((z) => z.key === secretZone);
  const adjacentZones   = zones.filter((z) => adjKeys.includes(z.key) && z.key !== secretZone);
  const deepStrikeZones = zones.filter((z) => !adjKeys.includes(z.key));

  const isDeepStrike  = !!selectedZone && !adjKeys.includes(selectedZone);
  const nipForMove    = isDeepStrike ? DEEP_STRIKE_NIP : 0;
  const canAffordMove = (state?.nip ?? 0) >= nipForMove;

  // ── Token helper ─────────────────────────────────────────────────────────────
  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  // ── Submit move ───────────────────────────────────────────────────────────────
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

  // ── Trade NIP for NCP ─────────────────────────────────────────────────────────
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
      setTradeStatus(
        "Traded " + data.nip_spent + " NIP for " + data.ncp_gained + " NCP. " +
        "Totals: " + data.nip_new + " NIP / " + data.ncp_new + " NCP."
      );
      const { data: u } = await supabase.auth.getUser();
      if (u.user) await loadCampaign(u.user.id, campaignId);
    } catch (e: any) {
      setTradeStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setTradePending(false);
    }
  };

  // ── Purchase recon token ───────────────────────────────────────────────────────
  const purchaseRecon = async () => {
    if (!campaignId || !campaign) return;
    setReconPending(true);
    setReconStatus("");
    try {
      const token = await getToken();
      if (!token) { setReconStatus("Session expired."); return; }
      const { data, error } = await supabase.functions.invoke("spend-nip", {
        body: { campaign_id: campaignId, mode: "recon", quantity: 1 },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Purchase failed");
      setReconStatus("Recon token purchased. You may view opponent movements in the recon phase.");
      setHasReconToken(true);
      const { data: u } = await supabase.auth.getUser();
      if (u.user) await loadCampaign(u.user.id, campaignId);
    } catch (e: any) {
      setReconStatus("Error: " + (e?.message ?? "Unknown"));
    } finally {
      setReconPending(false);
    }
  };

  // ── Zone section sub-component ────────────────────────────────────────────────
  const ZoneSection = ({
    label, zones: zList, colorClass, labelNote,
  }: { label: string; zones: MapZone[]; colorClass: string; labelNote?: string }) => {
    if (!zList.length) return null;
    return (
      <div>
        <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1.5">
          {label}{labelNote && <span className="text-parchment/25 normal-case ml-1">{labelNote}</span>}
        </div>
        <div className="space-y-1.5">
          {zList.map((z) => (
            <div key={z.key} className={"rounded border p-2 " + colorClass}>
              <div className="text-xs font-semibold text-parchment/80 mb-1">{z.name ?? titleCase(z.key)}</div>
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

            {/* ── Conflict banner ─────────────────────────────────────────── */}
            {conflictBanner && myConflicts.length > 0 && (
              <div className="relative rounded border border-blood/60 bg-blood/10 px-5 py-4">
                <button
                  onClick={() => setConflictBanner(false)}
                  className="absolute top-3 right-4 text-parchment/30 hover:text-parchment/70 text-lg leading-none"
                  aria-label="Dismiss"
                >
                  ×
                </button>
                <div className="flex items-start gap-3">
                  <span className="text-blood text-xl mt-0.5">⚔</span>
                  <div>
                    <div className="text-blood font-semibold text-sm mb-1">
                      Enemy contact — {myConflicts.length === 1 ? "engagement" : myConflicts.length + " engagements"} detected
                    </div>
                    {myConflicts.map((c) => (
                      <div key={c.id} className="text-parchment/70 text-xs mb-0.5">
                        {titleCase(c.zone_key)} — Sector {c.sector_key.toUpperCase()}
                        <span className="text-parchment/40 ml-2">({c.status})</span>
                      </div>
                    ))}
                    <a href="/conflicts" className="mt-2 inline-block text-xs text-blood/80 underline hover:text-blood">
                      Open Engagements →
                    </a>
                  </div>
                </div>
              </div>
            )}

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
                    <span className="font-mono text-sm capitalize">{roundStage ?? "—"}</span>
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
                  <p className="text-xs text-parchment/40">
                    Spend NIP during the <span className="text-brass">Spend</span> phase each round.
                    Earn NIP by winning battles and completing objectives.
                  </p>
                </div>
              </Card>
            </div>

            {/* ── SPEND phase card ────────────────────────────────────────── */}
            {roundStage === "spend" && (
              <Card title="Spend Phase — Commit Resources">
                <p className="text-parchment/60 text-sm mb-4">
                  Allocate NIP before orders are issued. Purchases carry forward into this round.
                </p>
                <div className="space-y-5">

                  {/* NIP → NCP */}
                  <div className="rounded border border-brass/20 bg-void/40 p-4">
                    <div className="text-sm font-semibold text-parchment/90 mb-1">Trade NIP for NCP</div>
                    <div className="text-xs text-parchment/50 mb-3">
                      {NIP_PER_NCP} NIP = 1 NCP (Campaign Points). NCP contribute to final victory.
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <label className="text-xs text-parchment/50">Qty (NCP):</label>
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
                  </div>

                  {/* Purchase recon */}
                  <div className="rounded border border-brass/20 bg-void/40 p-4">
                    <div className="text-sm font-semibold text-parchment/90 mb-1">
                      Purchase Recon Token
                      <span className="ml-2 text-xs text-parchment/40 font-normal">({RECON_NIP_COST} NIP)</span>
                    </div>
                    <div className="text-xs text-parchment/50 mb-3">
                      Grants access to the Recon phase — lets you scout opponent movements before
                      conflicts lock in, and optionally revise your move order.
                    </div>
                    {hasReconToken ? (
                      <div className="text-xs text-brass/80">✓ Recon token purchased for this round.</div>
                    ) : (
                      <>
                        <button
                          disabled={reconPending || (state.nip ?? 0) < RECON_NIP_COST}
                          className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs disabled:opacity-40"
                          onClick={purchaseRecon}
                        >
                          {reconPending ? "Purchasing…" : `Purchase (${RECON_NIP_COST} NIP)`}
                        </button>
                        {(state.nip ?? 0) < RECON_NIP_COST && (
                          <p className="mt-1 text-xs text-parchment/30 italic">
                            Not enough NIP. You need {RECON_NIP_COST}, you have {state.nip}.
                          </p>
                        )}
                      </>
                    )}
                    {reconStatus && (
                      <p className={"mt-2 text-xs " + (reconStatus.startsWith("Error") ? "text-blood/80" : "text-parchment/60")}>
                        {reconStatus}
                      </p>
                    )}
                  </div>

                  {/* Pre-commit deep strike */}
                  <div className="rounded border border-blood/15 bg-void/40 p-4">
                    <div className="text-sm font-semibold text-parchment/90 mb-1">
                      Pre-commit Deep Strike
                      <span className="ml-2 text-xs text-parchment/40 font-normal">({DEEP_STRIKE_NIP} NIP)</span>
                    </div>
                    <div className="text-xs text-parchment/50">
                      Reserve 3 NIP to enable deep striking to any non-adjacent zone during the Movement phase.
                      Alternatively, you can spend NIP inline when submitting your move.
                    </div>
                  </div>

                  {/* Underdog catch-up */}
                  {state.status === "underdog" && (
                    <div className="rounded border border-brass/40 bg-brass/5 p-4">
                      <div className="text-sm font-semibold text-brass mb-1">Catch-up Bonus (Underdog)</div>
                      <div className="text-xs text-parchment/60 mb-3">
                        You have fewer sectors than average. Choose one bonus for this round:
                      </div>
                      <select
                        className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm"
                        value={underdogChoice}
                        onChange={(e) => setUnderdogChoice(e.target.value)}
                      >
                        <option>+2 NIP</option>
                        <option>+1 NCP next battle</option>
                        <option>Free Recon</option>
                        <option>Safe Passage (1 move cannot be intercepted)</option>
                      </select>
                      <button className="mt-2 px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs">
                        Claim Bonus
                      </button>
                    </div>
                  )}
                </div>
              </Card>
            )}

            {/* ── RECON phase card ────────────────────────────────────────── */}
            {roundStage === "recon" && (
              <Card title="Recon Phase">
                {!hasReconToken ? (
                  <div className="space-y-2">
                    <p className="text-parchment/50 text-sm">
                      You did not purchase a recon token during the Spend phase.
                      Recon intel is unavailable to you this round.
                    </p>
                    <p className="text-parchment/30 text-xs">
                      Purchase a recon token next round during the Spend phase to unlock this capability.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-parchment/80 text-sm">
                      Your scouts have returned. Enemy movements have been detected.
                    </p>
                    <p className="text-xs text-parchment/50">
                      Recon intelligence display coming soon. You will be able to see zone-level
                      opponent positions before conflicts are finalised.
                    </p>
                  </div>
                )}
              </Card>
            )}

            {/* ── Movement Orders ─────────────────────────────────────────── */}
            <Card title={"Movement Orders — Round " + campaign.round_number}>
              {!secretZone ? (
                <p className="text-parchment/40 italic text-sm">
                  Starting location not yet allocated. Wait for the lead to start the campaign.
                </p>
              ) : roundStage !== "movement" ? (
                <p className="text-parchment/50 italic text-sm">
                  Movement is closed.{" "}
                  {roundStage ? "Current stage: " + roundStage + "." : "No active round yet."}
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

                  {/* Hold */}
                  {sameZone && (
                    <div>
                      <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1.5">
                        Hold position
                        <span className="text-parchment/25 normal-case ml-1">(stay in {titleCase(secretZone)})</span>
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
                              {isCurrent && <span className="ml-1 text-brass/50 text-xs">●</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Adjacent */}
                  {adjacentZones.length > 0 && (
                    <ZoneSection
                      label="Adjacent zones"
                      labelNote="(free)"
                      zones={adjacentZones}
                      colorClass="border-brass/20 bg-void/40"
                    />
                  )}

                  {/* Deep strike */}
                  {deepStrikeZones.length > 0 && (
                    <div>
                      <div className="text-xs text-parchment/40 uppercase tracking-widest mb-1.5">
                        Deep strike
                        <span className="text-blood/50 normal-case ml-1">({DEEP_STRIKE_NIP} NIP — orbital insertion)</span>
                      </div>
                      {(state.nip ?? 0) < DEEP_STRIKE_NIP ? (
                        <p className="text-xs text-parchment/30 italic">
                          You need {DEEP_STRIKE_NIP} NIP to deep strike. Current NIP: {state.nip}.
                        </p>
                      ) : (
                        <ZoneSection
                          label=""
                          zones={deepStrikeZones}
                          colorClass="border-blood/20 bg-void/40"
                        />
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
                          Need {DEEP_STRIKE_NIP} NIP — you have {state.nip}.
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

            {/* ── Halo War Bulletin (passive log) ─────────────────────────── */}
            <Card title="Halo War Bulletin">
              {bulletinPosts.length === 0 ? (
                <div className="text-parchment/30 text-sm italic">
                  No dispatches yet. Chronicles of battles will appear here after each round's Results phase.
                </div>
              ) : (
                <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
                  {bulletinPosts.map((post) => (
                    <div
                      key={post.id}
                      className="rounded border border-brass/15 bg-void/40 px-4 py-3"
                    >
                      <div className="flex items-baseline justify-between gap-2 mb-1.5">
                        <div className="text-sm font-semibold text-parchment/90">{post.title}</div>
                        <div className="text-xs text-parchment/30 shrink-0">Round {post.round_number}</div>
                      </div>
                      <p className="text-xs text-parchment/60 leading-relaxed line-clamp-4">{post.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>

          </div>
        )}
      </div>
    </Frame>
  );
}
