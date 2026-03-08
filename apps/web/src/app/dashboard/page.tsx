"use client";
// apps/web/src/app/dashboard/page.tsx
// Player dashboard: status, war bulletin, faction resources, campaign map.
//
// changelog:
//   2026-03-08 — SECURITY: authChecked state added. load() now redirects
//                unauthenticated users to / immediately rather than silently
//                rendering an empty page. Spinner shown while auth resolves.
//   2026-03-08 — FEATURE: War Bulletin now shows the 5 most recent public posts
//                rather than just the latest one. Posts tagged "chronicle" show
//                a ✦ Chronicle badge; posts tagged "alliance" show a ⚜ Pact badge.
//                Post type updated to include `tags` field.
//   2026-03-08 — FEATURE: Realtime subscription on player_state for the current
//                user. NIP and NCP balances in the Faction Resources card update
//                live when resolve-conflict (or any other edge function) writes
//                to player_state — no page refresh required.
//   2026-03-07 -- FIX: Dashboard now also queries player_state_secret for
//                 secret_location. Location card shows the player's real
//                 starting location (zone:sector from secret_location) when
//                 current_zone_key is still "unknown". Once movement begins
//                 and submit-move updates current_zone_key, that takes over.
//   2026-03-06 -- Added inline ToastContainer + addToast (consistent with
//                 campaigns/page.tsx and lead/page.tsx patterns). Replaced all
//                 alert() calls and bare addToast references with the proper
//                 toast hook. Fixed TS compile error: "Cannot find name
//                 'addToast'" at line 247.
//   2026-03-05 -- Removed My Campaigns card (campaignId from URL param).
//                 Removed Catch-up Choice card (now a conditional card driven
//                 by lead offer). Status (top-left) + War Bulletin (top-right).
//                 Added stage strip to Status card. Added Faction Resources
//                 card with NIP/NCP balances and spend-phase shopping cart.
//                 Added Campaign Map preview card with territory legend.
//                 Underdog catchup offer appears as dedicated card when pending.
//                 Removed prompt-copy helper functions. Cleaned up debug code.
//                 Removed Quick Links card. Nav fixed: Frame now receives
//                 campaignId and role props so all nav links render correctly.
//                 Theatre Map image is now a link to /map page.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { bootstrapCampaignId } from "@/lib/campaignSession";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// -- Stage order (must match advance-round edge function) -------------------
const STAGE_ORDER = ["spend", "recon", "movement", "conflicts", "missions", "results", "publish"] as const;
type Stage = typeof STAGE_ORDER[number];

// -- NIP shop items ---------------------------------------------------------
// These are the purchasable abilities in the spend phase.
const SHOP_ITEMS = [
  { id: "deep_strike",       label: "Deep Strike",       nip: 1,
    desc: "Move to any unoccupied sector this round, ignoring adjacency." },
  { id: "recon",             label: "Recon",             nip: 1,
    desc: "Reveal the zone of one enemy commander in range." },
  { id: "mission_selection", label: "Mission Selection", nip: 2,
    desc: "Choose or veto your mission in the next conflict." },
  { id: "safe_passage",      label: "Safe Passage",      nip: 1,
    desc: "Your movement this round cannot be intercepted." },
] as const;

// -- Catchup options (shown to the underdog player) ------------------------
const CATCHUP_OPTIONS = [
  "+2 NIP",
  "+1 NCP next battle",
  "Free Recon",
  "Safe Passage (1 move cannot be intercepted)",
] as const;

// -- Toast system (consistent with campaigns/page.tsx + lead/page.tsx) ------

type ToastType = "success" | "error" | "info";
interface Toast { id: number; type: ToastType; title: string; body?: string }
let _toastId = 0;

function ToastContainer({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded border px-4 py-3 shadow-2xl shadow-black/60 backdrop-blur-sm
            ${t.type === "success" ? "bg-void border-brass/60" : ""}
            ${t.type === "error"   ? "bg-void border-blood/60" : ""}
            ${t.type === "info"    ? "bg-void border-brass/30" : ""}
          `}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className={`text-sm font-semibold uppercase tracking-widest
                ${t.type === "success" ? "text-brass"    : ""}
                ${t.type === "error"   ? "text-blood"    : ""}
                ${t.type === "info"    ? "text-brass/70" : ""}
              `}>
                {t.type === "success" && "⚙ "}
                {t.type === "error"   && "☠ "}
                {t.type === "info"    && "✦ "}
                {t.title}
              </p>
              {t.body && (
                <p className="mt-1 text-xs text-parchment/60 leading-relaxed">{t.body}</p>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-parchment/30 hover:text-parchment/70 text-lg leading-none mt-0.5 shrink-0"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// -- Types ------------------------------------------------------------------

type Campaign = {
  id:           string;
  name:         string;
  phase:        number;
  round_number: number;
  instability:  number;
  map_id:       string | null;
};

type PlayerState = {
  nip:                number;
  ncp:                number;
  status:             string;
  current_zone_key:   string;
  current_sector_key: string;
};

type Round  = { stage: string };

// tags is a jsonb array from the DB — typed as string[] for our purposes.
type Post   = {
  id:           string;
  title:        string;
  body:         string;
  round_number: number;
  created_at:   string;
  tags:         string[];
};

type Spend  = { spend_type: string; nip_spent: number };
type Member = { user_id: string; commander_name: string | null; faction_name: string | null; role: string };
type Sector = { zone_key: string; sector_key: string; owner_user_id: string | null; revealed_public: boolean };

type UnderdogChoice = {
  id:            string;
  chosen_option: string | null;
  status:        string;
};

// -- Helpers ----------------------------------------------------------------

function fmtKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Stable colour per player index for territory display
const PLAYER_COLOURS = [
  "bg-brass/30 border-brass/60 text-brass",
  "bg-blood/30 border-blood/60 text-blood/90",
  "bg-blue-500/25 border-blue-400/50 text-blue-300",
  "bg-green-600/25 border-green-500/50 text-green-300",
  "bg-purple-500/25 border-purple-400/50 text-purple-300",
  "bg-orange-500/25 border-orange-400/50 text-orange-300",
  "bg-pink-500/25 border-pink-400/50 text-pink-300",
  "bg-teal-500/25 border-teal-400/50 text-teal-300",
];

// Post tag badge — visual indicator for chronicle vs alliance vs plain posts
function PostTagBadge({ tags }: { tags: string[] }) {
  if (tags.includes("alliance")) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-brass/30 bg-brass/10 text-brass/70 font-mono uppercase tracking-wider">
        ⚜ Pact
      </span>
    );
  }
  if (tags.includes("chronicle")) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-parchment/20 bg-parchment/5 text-parchment/40 font-mono uppercase tracking-wider">
        ✦ Chronicle
      </span>
    );
  }
  return null;
}

// -- Main Component ---------------------------------------------------------

export default function Dashboard() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // campaignId is read directly from URL so nav links are always populated
  const [campaignId] = useState<string>(() => bootstrapCampaignId());

  const [authChecked,     setAuthChecked]     = useState(false);
  const [campaign,        setCampaign]        = useState<Campaign | null>(null);
  const [playerState,     setPlayerState]     = useState<PlayerState | null>(null);
  const [round,           setRound]           = useState<Round | null>(null);
  const [role,            setRole]            = useState<string>("player");
  // Bulletin now holds the 5 most recent public posts instead of just the latest
  const [bulletinPosts,   setBulletinPosts]   = useState<Post[]>([]);
  const [spends,          setSpends]          = useState<Spend[]>([]);
  const [mapUrl,          setMapUrl]          = useState<string | null>(null);
  const [sectors,         setSectors]         = useState<Sector[]>([]);
  const [members,         setMembers]         = useState<Member[]>([]);
  const [underdogChoice,  setUnderdogChoice]  = useState<UnderdogChoice | null>(null);
  const [cart,            setCart]            = useState<Record<string, boolean>>({});
  const [secretLocation,  setSecretLocation]  = useState<string | null>(null);
  const [myUnits,         setMyUnits]         = useState<{ id: string; unit_type: string; zone_key: string; sector_key: string }[]>([]);
  const [purchasing,      setPurchasing]      = useState(false);
  const [catchupOption,   setCatchupOption]   = useState<string>(CATCHUP_OPTIONS[0]);
  const [accepting,       setAccepting]       = useState(false);
  const [uid,             setUid]             = useState<string>("");

  // -- Toast state ----------------------------------------------------------
  const [toasts,    setToasts]    = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, title: string, body?: string) => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, type, title, body }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // -- Accept invites on load -----------------------------------------------
  const acceptInvites = async (token: string) => {
    try {
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/accept-invites`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );
      if (!resp.ok) console.warn("[dashboard] accept-invites returned", resp.status);
    } catch (e) {
      console.warn("[dashboard] accept-invites failed:", e);
    }
  };

  // -- Load all dashboard data ----------------------------------------------
  const load = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { window.location.href = "/"; return; }
    setAuthChecked(true);
    setUid(user.id);
    const cid = campaignId;
    if (!cid) return;

    // 1. Campaign basics
    const { data: c } = await supabase
      .from("campaigns")
      .select("id,name,phase,round_number,instability,map_id")
      .eq("id", cid).single();
    if (!c) return;
    setCampaign(c as Campaign);

    // 2. My role
    const { data: mem } = await supabase
      .from("campaign_members").select("role")
      .eq("campaign_id", cid).eq("user_id", user.id).single();
    setRole(mem?.role ?? "player");

    // 3. My player state
    const { data: ps } = await supabase
      .from("player_state").select("nip,ncp,status,current_zone_key,current_sector_key")
      .eq("campaign_id", cid).eq("user_id", user.id).maybeSingle();
    setPlayerState(ps ?? null);

    // 3b. My secret location (real starting/current position, fog-of-war safe)
    // current_zone_key in player_state is "unknown" until submit-move runs.
    // secret_location is the authoritative source for the player's own position.
    const { data: pss } = await supabase
      .from("player_state_secret").select("secret_location")
      .eq("campaign_id", cid).eq("user_id", user.id).maybeSingle();
    setSecretLocation(pss?.secret_location ?? null);

    // 4. Current round / stage
    const { data: r } = await supabase
      .from("rounds").select("stage")
      .eq("campaign_id", cid).eq("round_number", c.round_number).maybeSingle();
    setRound(r ?? null);

    // 5. War bulletin — last 5 public posts, newest first.
    //    Includes tags so the UI can render chronicle/alliance badges.
    const { data: posts } = await supabase
      .from("posts").select("id,title,body,round_number,created_at,tags")
      .eq("campaign_id", cid).eq("visibility", "public")
      .order("created_at", { ascending: false }).limit(5);
    setBulletinPosts((posts ?? []) as Post[]);

    // 6. My spends this round
    const { data: spendRows } = await supabase
      .from("round_spends").select("spend_type,nip_spent")
      .eq("campaign_id", cid).eq("round_number", c.round_number).eq("user_id", user.id);
    setSpends(spendRows ?? []);

    // 7. Map signed URL (if campaign has a map)
    if (c.map_id) {
      const { data: mapRow } = await supabase
        .from("maps").select("bg_image_path,image_path")
        .eq("id", c.map_id).single();
      const path = mapRow?.bg_image_path ?? mapRow?.image_path;
      if (path) {
        const { data: urlData } = await supabase.storage
          .from("campaign-maps").createSignedUrl(path, 3600);
        setMapUrl(urlData?.signedUrl ?? null);
      }
    }

    // 8. Sectors visible to this player (RLS: own + revealed_public)
    const { data: sectorRows } = await supabase
      .from("sectors").select("zone_key,sector_key,owner_user_id,revealed_public")
      .eq("campaign_id", cid);
    setSectors((sectorRows ?? []) as Sector[]);

    // 9. Members (for territory display and commander names)
    const { data: memberRows } = await supabase
      .from("campaign_members").select("user_id,commander_name,faction_name,role")
      .eq("campaign_id", cid);
    setMembers((memberRows ?? []) as Member[]);

    // 10. Pending underdog choice for this player
    const { data: udChoice } = await supabase
      .from("underdog_choices").select("id,chosen_option,status")
      .eq("campaign_id", cid).eq("user_id", user.id).eq("status", "pending")
      .maybeSingle();
    setUnderdogChoice(udChoice ?? null);

    // 11. My active units (for Current Troop Locations display)
    const { data: unitRows } = await supabase
      .from("units").select("id,unit_type,zone_key,sector_key")
      .eq("campaign_id", cid).eq("user_id", user.id).eq("status", "active");
    setMyUnits(unitRows ?? []);
  };

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) await acceptInvites(session.access_token);
      await load();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Realtime: player_state NIP/NCP live updates --------------------------
  // Subscribes once uid is available (set inside load()). Updates the
  // playerState balance in-place so the Faction Resources card reflects
  // changes from resolve-conflict and any other edge function immediately,
  // without needing a page refresh.
  useEffect(() => {
    if (!uid || !campaignId) return;

    const channel = supabase
      .channel(`player_state_live_${uid}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "player_state",
          filter: `user_id=eq.${uid}`,
        },
        (payload) => {
          const updated = payload.new as any;
          // Only apply if this update is for our campaign
          if (updated.campaign_id !== campaignId) return;
          setPlayerState((prev) =>
            prev
              ? {
                  ...prev,
                  nip:    updated.nip    ?? prev.nip,
                  ncp:    updated.ncp    ?? prev.ncp,
                  status: updated.status ?? prev.status,
                }
              : null
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [uid, campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Purchase cart --------------------------------------------------------

  const toggleCart = (itemId: string) => {
    setCart((prev) => ({ ...prev, [itemId]: !prev[itemId] }));
  };

  const cartItems     = SHOP_ITEMS.filter((i) => cart[i.id]);
  const cartTotal     = cartItems.reduce((sum, i) => sum + i.nip, 0);
  const alreadyBought = new Set(spends.map((s) => s.spend_type));

  const purchaseCart = async () => {
    if (!cartItems.length || !campaign || !playerState) return;
    if (cartTotal > playerState.nip) {
      addToast("error", "Insufficient NIP", "Not enough NIP to complete this purchase.");
      return;
    }
    setPurchasing(true);
    try {
      // Insert spend records
      const { error: spendErr } = await supabase.from("round_spends").insert(
        cartItems.map((i) => ({
          campaign_id:  campaign.id,
          round_number: campaign.round_number,
          user_id:      uid,
          spend_type:   i.id,
          nip_spent:    i.nip,
        }))
      );
      if (spendErr) throw spendErr;
      // Deduct NIP from player state (player_state_update_self RLS allows this)
      const { error: nipErr } = await supabase
        .from("player_state")
        .update({ nip: playerState.nip - cartTotal })
        .eq("campaign_id", campaign.id)
        .eq("user_id", uid);
      if (nipErr) throw nipErr;
      setCart({});
      addToast("success", "Purchase complete", `${cartItems.length} ability${cartItems.length !== 1 ? "s" : ""} activated for this round.`);
      await load();
    } catch (e: any) {
      addToast("error", "Purchase failed", e?.message ?? String(e));
    } finally {
      setPurchasing(false);
    }
  };

  // -- Accept catchup choice ------------------------------------------------

  const acceptCatchup = async () => {
    if (!underdogChoice || !campaign) return;
    setAccepting(true);
    try {
      // Record the choice
      const { error: choiceErr } = await supabase
        .from("underdog_choices")
        .update({ chosen_option: catchupOption, chosen_at: new Date().toISOString(), status: "accepted" })
        .eq("id", underdogChoice.id);
      if (choiceErr) throw choiceErr;

      // Apply the benefit directly where possible
      if (catchupOption === "+2 NIP" && playerState) {
        await supabase.from("player_state")
          .update({ nip: playerState.nip + 2 })
          .eq("campaign_id", campaign.id).eq("user_id", uid);
      }
      if (catchupOption === "Free Recon") {
        // Insert a zero-cost recon spend for this round
        await supabase.from("round_spends").insert({
          campaign_id:  campaign.id,
          round_number: campaign.round_number,
          user_id:      uid,
          spend_type:   "recon",
          nip_spent:    0,
          payload:      { source: "underdog_bonus" },
        });
      }
      if (catchupOption === "Safe Passage (1 move cannot be intercepted)") {
        await supabase.from("round_spends").insert({
          campaign_id:  campaign.id,
          round_number: campaign.round_number,
          user_id:      uid,
          spend_type:   "safe_passage",
          nip_spent:    0,
          payload:      { source: "underdog_bonus" },
        });
      }
      // "+1 NCP next battle" is recorded in the choice and applied by lead manually.

      setUnderdogChoice(null);
      addToast("success", "Bonus accepted", `${catchupOption} has been applied to your faction.`);
      await load();
    } catch (e: any) {
      addToast("error", "Failed to accept", e?.message ?? String(e));
    } finally {
      setAccepting(false);
    }
  };

  // -- Derived state --------------------------------------------------------

  const campaignStarted = round !== null;
  const currentStage    = (round?.stage ?? null) as Stage | null;
  const stageIndex      = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;
  const inSpendPhase    = currentStage === "spend";

  // Build member colour index for territory display
  const memberColour = useMemo(() => {
    const map = new Map<string, string>();
    members.forEach((m, i) => map.set(m.user_id, PLAYER_COLOURS[i % PLAYER_COLOURS.length]));
    return map;
  }, [members]);

  // Group visible sectors by zone_key, then by owner
  const territoryByZone = useMemo(() => {
    const zones = new Map<string, Map<string, number>>();
    for (const s of sectors) {
      if (!s.owner_user_id) continue;
      if (!zones.has(s.zone_key)) zones.set(s.zone_key, new Map());
      const owners = zones.get(s.zone_key)!;
      owners.set(s.owner_user_id, (owners.get(s.owner_user_id) ?? 0) + 1);
    }
    return zones;
  }, [sectors]);

  const mySectorCount = sectors.filter((s) => s.owner_user_id === uid).length;

  // Zone control: player with strictly more sectors than any other controls the zone.
  // Rule: majority wins; if tied at the top (e.g. 2v2 in a 4-sector zone) = contested.
  const zoneController = useMemo(() => {
    const result = new Map<string, string | null>(); // zone_key -> uid or null (contested)
    for (const [zoneKey, owners] of territoryByZone.entries()) {
      const ranked = Array.from(owners.entries()).sort((a, b) => b[1] - a[1]);
      if (ranked.length === 0) {
        result.set(zoneKey, null);
      } else if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
        result.set(zoneKey, ranked[0][0]); // strict winner
      } else {
        result.set(zoneKey, null); // tied — contested
      }
    }
    return result;
  }, [territoryByZone]);

  const myZoneCount = Array.from(zoneController.values()).filter((uid_) => uid_ === uid).length;

  const memberById = useMemo(() => {
    const m = new Map<string, Member>();
    members.forEach((mem) => m.set(mem.user_id, mem));
    return m;
  }, [members]);

  // -- Render ----------------------------------------------------------------

  const isLeadOrAdmin = role === "lead" || role === "admin";

  // Auth loading gate — show spinner until getUser() resolves
  if (!authChecked) {
    return (
      <Frame title="Command Throne" currentPage="dashboard" hideNewCampaign>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-brass/20 border-t-brass rounded-full animate-spin" />
        </div>
      </Frame>
    );
  }

  // No campaign in session (e.g. opened in a new tab without a ?campaign= link)
  if (!campaignId) {
    return (
      <Frame title="Command Throne" currentPage="dashboard" hideNewCampaign>
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <p className="text-parchment/50">No campaign selected.</p>
          <a href="/" className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-brass text-sm">
            Return to Home
          </a>
        </div>
      </Frame>
    );
  }

  return (
    <Frame title="Command Throne" currentPage="dashboard" campaignId={campaignId} role={role}>
      <div className="space-y-6">

        {/* ── Row 1: Your Status (left) + War Bulletin (right) ─────────── */}
        <div className="grid md:grid-cols-2 gap-6 items-start">

          {/* Your Status */}
          <Card title="Your Status">
            {campaign && playerState ? (
              <div className="space-y-3">
                <div className="space-y-0.5">
                  <p className="text-parchment font-semibold">{campaign.name}</p>
                  <p className="text-parchment/50 text-xs">
                    Phase {campaign.phase} &bull; Round {campaign.round_number} &bull; Instability {campaign.instability}/10
                  </p>
                  <p className="text-parchment/40 text-xs">Role: {role}</p>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-brass/10 text-sm">
                  <div>
                    <p className="text-parchment/40 text-xs">Status</p>
                    <p className="text-parchment/80 capitalize">{playerState.status}</p>
                    <p className="text-parchment/40 text-xs">
                      {mySectorCount} sector{mySectorCount !== 1 ? "s" : ""} held
                      {myZoneCount > 0 && (
                        <span className="ml-1.5 text-brass">· {myZoneCount} zone{myZoneCount !== 1 ? "s" : ""} controlled</span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Current Troop Locations */}
                <div className="pt-2 border-t border-brass/10">
                  <p className="text-xs text-parchment/40 mb-2">Current Troop Locations</p>
                  {myUnits.length > 0 ? (
                    <div className="space-y-1.5">
                      {myUnits.map((u) => (
                        <div key={u.id} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded bg-void border border-brass/10">
                          <span className={`text-xs px-1.5 py-0.5 rounded border font-mono uppercase shrink-0 ${
                            u.unit_type === "scout"
                              ? "bg-blue-500/15 border-blue-400/40 text-blue-300"
                              : "bg-brass/15 border-brass/40 text-brass"
                          }`}>
                            {u.unit_type === "scout" ? "◈ Scout" : "⬡ Occ."}
                          </span>
                          <span className="text-parchment/80 text-sm">{fmtKey(u.zone_key)}</span>
                          <span className="text-parchment/40 text-xs font-mono">/ {u.sector_key.toUpperCase()}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    (() => {
                      // No active units yet — show starting location from secret_location or player_state
                      const useSecret =
                        (!playerState.current_zone_key || playerState.current_zone_key === "unknown") &&
                        !!secretLocation;
                      const [dispZone, dispSector] = useSecret
                        ? secretLocation!.split(":")
                        : [playerState.current_zone_key, playerState.current_sector_key];
                      return (
                        <div className="px-2.5 py-1.5 rounded bg-void border border-brass/10">
                          <p className="text-parchment/40 text-xs mb-0.5">Starting Position</p>
                          <span className="text-parchment/70 text-sm">{fmtKey(dispZone ?? "unknown")}</span>
                          <span className="text-parchment/40 text-xs font-mono ml-2">/ {(dispSector ?? "—").toUpperCase()}</span>
                        </div>
                      );
                    })()
                  )}
                </div>

                {/* Stage strip */}
                {campaignStarted && (
                  <div className="pt-1 border-t border-brass/10">
                    <p className="text-xs text-parchment/40 mb-1.5">Current Stage</p>
                    <div className="flex gap-1 flex-wrap">
                      {STAGE_ORDER.map((s, i) => (
                        <span key={s} className={`px-2 py-0.5 rounded text-xs font-mono uppercase ${
                          s === currentStage
                            ? "bg-brass/30 border border-brass/60 text-brass font-bold"
                            : i < stageIndex
                              ? "bg-void border border-parchment/10 text-parchment/25 line-through"
                              : "bg-void border border-parchment/10 text-parchment/35"
                        }`}>{s}</span>
                      ))}
                    </div>
                  </div>
                )}

                {!campaignStarted && (
                  <p className="text-parchment/30 text-xs italic">Campaign not yet started.</p>
                )}
              </div>
            ) : (
              <p className="text-parchment/40 text-sm italic">Loading status...</p>
            )}
          </Card>

          {/* War Bulletin — last 5 public posts */}
          <Card title="War Bulletin">
            {bulletinPosts.length > 0 ? (
              <div className="space-y-4 max-h-[480px] overflow-y-auto pr-1">
                {bulletinPosts.map((post, idx) => {
                  const tags: string[] = Array.isArray(post.tags) ? post.tags : [];
                  return (
                    <div
                      key={post.id}
                      className={idx > 0 ? "pt-4 border-t border-brass/10" : ""}
                    >
                      {/* Title row */}
                      <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
                        <p className="text-parchment font-semibold leading-snug flex-1">{post.title}</p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <PostTagBadge tags={tags} />
                          <span className="text-xs text-parchment/30 font-mono">R{post.round_number}</span>
                        </div>
                      </div>
                      {/* Body — truncated for older posts to keep the card scannable */}
                      <p className="text-parchment/65 text-sm leading-relaxed whitespace-pre-wrap">
                        {idx === 0
                          ? (post.body.length > 500 ? post.body.slice(0, 500) + "…" : post.body)
                          : (post.body.length > 200 ? post.body.slice(0, 200) + "…" : post.body)
                        }
                      </p>
                      <p className="text-parchment/25 text-xs mt-1">
                        {new Date(post.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-parchment/30 text-sm italic">No bulletins posted yet. The silence of the void is deafening.</p>
            )}
          </Card>

        </div>

        {/* ── Row 2: Faction Resources (left) + Campaign Map (right) ───── */}
        <div className="grid md:grid-cols-2 gap-6 items-start">

          {/* Faction Resources */}
          <Card title="Faction Resources">
            {playerState ? (
              <div className="space-y-4">

                {/* NIP / NCP balances — updated live via realtime subscription */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="px-3 py-2.5 rounded bg-brass/10 border border-brass/25 text-center">
                    <p className="text-xs text-parchment/40 uppercase tracking-widest">NIP</p>
                    <p className="text-2xl font-bold text-brass">{playerState.nip}</p>
                    <p className="text-xs text-parchment/30">Influence Points</p>
                  </div>
                  <div className="px-3 py-2.5 rounded bg-parchment/5 border border-parchment/15 text-center">
                    <p className="text-xs text-parchment/40 uppercase tracking-widest">NCP</p>
                    <p className="text-2xl font-bold text-parchment/80">{playerState.ncp}</p>
                    <p className="text-xs text-parchment/30">Campaign Points</p>
                  </div>
                </div>

                {/* Purchased abilities this round -- always visible after spend */}
                {spends.length > 0 && (
                  <div>
                    <p className="text-xs text-parchment/40 mb-1.5 font-semibold uppercase tracking-widest">
                      Round {campaign?.round_number} Purchases
                    </p>
                    <div className="space-y-1">
                      {spends.map((s, i) => {
                        const item = SHOP_ITEMS.find((x) => x.id === s.spend_type);
                        return (
                          <div key={i} className="flex items-center justify-between px-2.5 py-1.5 rounded bg-brass/5 border border-brass/15 text-sm">
                            <span className="text-parchment/75">{item?.label ?? fmtKey(s.spend_type)}</span>
                            {s.nip_spent > 0
                              ? <span className="text-parchment/35 text-xs font-mono">{s.nip_spent} NIP</span>
                              : <span className="text-brass/60 text-xs font-mono">Free</span>
                            }
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Shopping cart -- spend phase only */}
                {inSpendPhase && (
                  <div className="border-t border-brass/10 pt-3 space-y-3">
                    <p className="text-xs text-parchment/40 font-semibold uppercase tracking-widest">Spend NIP</p>
                    <div className="space-y-2">
                      {SHOP_ITEMS.filter((i) => !alreadyBought.has(i.id)).map((item) => {
                        const inCart    = !!cart[item.id];
                        const canAfford = cart[item.id]
                          ? true
                          : playerState.nip - cartTotal >= item.nip;
                        return (
                          <div key={item.id}
                            className={`flex items-start gap-3 px-3 py-2 rounded border transition-colors ${
                              inCart
                                ? "bg-brass/15 border-brass/50"
                                : "bg-void border-brass/15 hover:border-brass/30"
                            }`}>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-2">
                                <p className="text-parchment/85 text-sm font-semibold">{item.label}</p>
                                <p className="text-brass/80 text-xs font-mono">{item.nip} NIP</p>
                              </div>
                              <p className="text-parchment/40 text-xs mt-0.5">{item.desc}</p>
                            </div>
                            <button
                              onClick={() => toggleCart(item.id)}
                              disabled={!canAfford && !inCart}
                              className={`shrink-0 px-3 py-1 rounded text-xs font-semibold border transition-colors disabled:opacity-30 ${
                                inCart
                                  ? "bg-brass/30 border-brass/60 text-brass"
                                  : "bg-void border-parchment/20 hover:border-brass/40 text-parchment/60 hover:text-parchment/90"
                              }`}>
                              {inCart ? "Remove" : "Add"}
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {/* Cart total + checkout */}
                    {cartItems.length > 0 && (
                      <div className="pt-2 border-t border-brass/15 space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-parchment/50">
                            {cartItems.length} item{cartItems.length !== 1 ? "s" : ""} selected
                          </span>
                          <span className="text-brass font-bold font-mono">{cartTotal} NIP</span>
                        </div>
                        {cartTotal > playerState.nip && (
                          <p className="text-blood/70 text-xs">Insufficient NIP ({playerState.nip} available).</p>
                        )}
                        <button
                          onClick={purchaseCart}
                          disabled={purchasing || cartTotal > playerState.nip}
                          className="w-full px-4 py-2 rounded bg-brass/25 border border-brass/50 hover:bg-brass/40 disabled:opacity-40 text-brass font-bold text-sm uppercase tracking-wider transition-colors">
                          {purchasing ? "Purchasing..." : `Spend ${cartTotal} NIP`}
                        </button>
                      </div>
                    )}

                    {SHOP_ITEMS.every((i) => alreadyBought.has(i.id)) && (
                      <p className="text-parchment/30 text-xs italic">All available abilities purchased this round.</p>
                    )}
                  </div>
                )}

                {!inSpendPhase && spends.length === 0 && (
                  <p className="text-parchment/25 text-xs italic">No purchases this round.</p>
                )}

              </div>
            ) : (
              <p className="text-parchment/40 text-sm italic">Loading resources...</p>
            )}
          </Card>

          {/* Campaign Map */}
          <Card title={campaign ? `${campaign.name} — Theatre Map` : "Campaign Map"}>
            {mapUrl ? (
              <div className="space-y-3">
                <a href="/map" onClick={(e) => { e.preventDefault(); import("@/lib/campaignSession").then(m => { m.setCampaignSession(campaignId); window.location.href = "/map"; }); }} title="Open Tactical Hololith" className="cursor-pointer">
                  <img
                    src={mapUrl}
                    alt="Campaign theatre map"
                    className="w-full rounded border border-brass/20 object-cover hover:border-brass/50 transition-colors cursor-pointer"
                    style={{ maxHeight: "260px" }}
                  />
                </a>

                {/* Territory legend */}
                {territoryByZone.size > 0 && (
                  <div>
                    <p className="text-xs text-parchment/35 mb-2 uppercase tracking-widest">Visible Territory</p>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {Array.from(territoryByZone.entries()).map(([zoneKey, owners]) => {
                        const controller = zoneController.get(zoneKey) ?? null;
                        const contested  = Array.from(owners.values()).filter(c => c > 0).length > 1
                          && controller === null;
                        return (
                          <div key={zoneKey} className="flex items-start gap-2">
                            <div className="w-32 shrink-0 pt-0.5">
                              <span className="text-parchment/40 text-xs font-mono">{fmtKey(zoneKey)}</span>
                              {controller !== null && (
                                <span className={`block text-xs font-mono ${controller === uid ? "text-brass" : "text-parchment/30"}`}>
                                  {controller === uid ? "⚑ Controlled" : "⚑ Enemy held"}
                                </span>
                              )}
                              {contested && (
                                <span className="block text-xs font-mono text-orange-400/70">⚔ Contested</span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {Array.from(owners.entries()).map(([ownerId, count]) => {
                                const m      = memberById.get(ownerId);
                                const colour = memberColour.get(ownerId) ?? PLAYER_COLOURS[0];
                                return (
                                  <span key={ownerId}
                                    className={`px-1.5 py-0.5 rounded border text-xs font-mono ${colour}`}>
                                    {m?.commander_name ?? "Unknown"} ×{count}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-parchment/20 text-xs mt-2 italic">
                      Fog of war — only your sectors and publicly revealed sectors are shown.
                    </p>
                  </div>
                )}

                {territoryByZone.size === 0 && (
                  <p className="text-parchment/30 text-xs italic">
                    No territory data visible. Fog of war conceals all positions.
                  </p>
                )}
              </div>
            ) : campaign?.map_id ? (
              <p className="text-parchment/40 text-sm italic">Loading map...</p>
            ) : (
              <p className="text-parchment/30 text-sm italic">
                No map generated yet. The theatre of war awaits its cartographer.
              </p>
            )}
          </Card>

        </div>

        {/* ── Row 3: Catchup Offer (conditional — underdog only) ───────── */}
        {underdogChoice && (
          <Card title="Catch-up Offer — Underdog Bonus">
            <div className="space-y-4">
              <p className="text-parchment/70 text-sm leading-relaxed">
                The campaign lead has identified you as the current underdog. Choose one benefit
                to apply before the next round begins.
              </p>
              <div className="space-y-2">
                <p className="text-xs text-parchment/40 uppercase tracking-widest">Select your benefit</p>
                <select
                  className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm text-parchment/85"
                  value={catchupOption}
                  onChange={(e) => setCatchupOption(e.target.value)}
                >
                  {CATCHUP_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                {catchupOption === "+1 NCP next battle" && (
                  <p className="text-xs text-parchment/35 italic">
                    This bonus is recorded and applied by the campaign lead at your next conflict.
                  </p>
                )}
              </div>
              <button
                onClick={acceptCatchup}
                disabled={accepting}
                className="w-full px-4 py-2.5 rounded bg-brass/25 border border-brass/50 hover:bg-brass/40 disabled:opacity-40 text-brass font-bold text-sm uppercase tracking-wider transition-colors">
                {accepting ? "Accepting..." : "Accept Bonus"}
              </button>
            </div>
          </Card>
        )}

      </div>

      {/* ── Toast notifications ─────────────────────────────────────────── */}
      <ToastContainer toasts={toasts} dismiss={dismissToast} />

    </Frame>
  );
}
