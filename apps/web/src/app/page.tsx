"use client";
// src/app/page.tsx
//
// changelog:
//   2026-03-08 — SECURITY: all campaign nav anchors (Dashboard, Map, Conflicts,
//                Lead Controls) converted to buttons that call setCampaignSession
//                then navigate to the clean path. Campaign IDs are no longer
//                exposed in the URL bar or browser history.
//                Removed campaign_id from pending invite display.
//   2026-03-09 — FEATURE: Detect ?campaign_invite=1 URL param (set by invite
//                email links). After auth resolves, scroll to and highlight the
//                Campaign Invites card so the player sees it immediately.
//                inviteHighlight state + invitesPanelRef added.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { setCampaignSession } from "@/lib/campaignSession";
import { Frame } from "@/components/Frame";
import { FACTION_THEMES, getFactionTheme } from "@/components/theme";
import { Card } from "@/components/Card";

type Membership = {
  campaign_id: string;
  role: string;
  faction_key: string | null;
  faction_name: string | null;
  faction_locked: boolean;
  commander_name: string | null;
  campaign: {
    name: string;
    phase: number;
    round_number: number;
    instability: number;
  } | null;
};

type PendingInvite = {
  id: string;
  campaign_id: string;
  campaign_name: string;
  invite_message: string | null;
};

/** Navigate to a campaign page without exposing the campaign ID in the URL. */
function navTo(path: string, campaignId: string) {
  setCampaignSession(campaignId);
  window.location.href = path;
}

export default function Home() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [email, setEmail] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [displayName, setDisplayName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);

  const [pickingFaction, setPickingFaction]   = useState(false);
  const [pendingFaction, setPendingFaction]   = useState<string | null>(null);
  const [settingFaction, setSettingFaction]   = useState(false);
  const [factionError, setFactionError]       = useState<string>("");

  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [processingInviteId, setProcessingInviteId] = useState<string>("");
  const [inviteHighlight, setInviteHighlight] = useState(false);
  const invitesPanelRef = useRef<HTMLDivElement>(null);

  const selectedMembership = memberships.find((m) => m.campaign_id === selectedCampaignId);

  // ── Auth ──────────────────────────────────────────────────
  useEffect(() => {
    const run = async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) {
        setUserEmail(null);
        setUserId(null);
        return;
      }
      setUserEmail(data.user.email ?? null);
      setUserId(data.user.id);
      const name = data.user.user_metadata?.display_name ?? "";
      setDisplayName(name);
      setSavedName(name);
    };
    run().finally(() => setAuthLoading(false));
  }, [supabase]);

  // ── Load campaigns ────────────────────────────────────────
  const loadCampaigns = async (uid: string) => {
    setLoadingCampaigns(true);
    try {
      const { data, error } = await supabase
        .from("campaign_members")
        .select(`
          campaign_id, role, faction_key, faction_name, faction_locked,
          commander_name, campaigns (name, phase, round_number, instability)
        `)
        .eq("user_id", uid)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows: Membership[] = (data ?? []).map((m: any) => ({
        campaign_id:    m.campaign_id,
        role:           m.role,
        faction_key:    m.faction_key ?? null,
        faction_name:   m.faction_name ?? null,
        faction_locked: m.faction_locked ?? false,
        commander_name: m.commander_name ?? null,
        campaign:       m.campaigns ?? null,
      }));

      setMemberships(rows);
      if (rows.length && !selectedCampaignId) setSelectedCampaignId(rows[0].campaign_id);
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoadingCampaigns(false);
    }
  };

  // ── Load pending invites ──────────────────────────────────
  const loadInvites = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const { data, error } = await supabase.functions.invoke("accept-invites", {
        body: { mode: "list" },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) { console.error("invite list error:", error); return; }
      setPendingInvites(data?.invites ?? []);
    } catch (e) { console.error("loadInvites error:", e); }
  };

  useEffect(() => {
    if (!userId) return;
    loadCampaigns(userId);
    loadInvites();
  }, [userId]);

  // ── Detect ?campaign_invite=1 from email link ─────────────
  // When a player clicks the branded invite email, they land here with this
  // param set. Once invites have loaded, scroll to and briefly highlight the
  // invites card so they notice it immediately. Then clean the URL.
  useEffect(() => {
    if (!userId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("campaign_invite") !== "1") return;
    // Wait for invites to load (loadInvites is async), then scroll + highlight
    const timer = setTimeout(() => {
      setInviteHighlight(true);
      invitesPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      // Remove param from URL without a page reload
      const clean = window.location.pathname;
      window.history.replaceState({}, "", clean);
      // Fade highlight out after 3 seconds
      setTimeout(() => setInviteHighlight(false), 3000);
    }, 800);
    return () => clearTimeout(timer);
  }, [userId]);
  // ── Actions ───────────────────────────────────────────────
  const sendMagicLink = async () => {
    if (!email.trim()) return alert("Enter your email address.");
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) alert(error.message);
    else alert("Check your email for the login link.");
  };

  const signOut = async () => { await supabase.auth.signOut(); location.reload(); };

  const saveDisplayName = async () => {
    if (!displayName.trim()) return alert("Enter a name.");
    setSavingName(true);
    try {
      const { error } = await supabase.auth.updateUser({ data: { display_name: displayName.trim() } });
      if (error) throw error;
      setSavedName(displayName.trim());
      alert("Name saved.");
    } catch (e: any) {
      alert(e?.message ?? "Failed to save name.");
    } finally { setSavingName(false); }
  };

  const handleInvite = async (inviteId: string, mode: "accept" | "decline") => {
    setProcessingInviteId(inviteId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { alert("Session expired. Refresh and try again."); return; }
      const { data, error } = await supabase.functions.invoke("accept-invites", {
        body: { mode, invite_id: inviteId },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Failed");
      setPendingInvites((prev) => prev.filter((i) => i.id !== inviteId));
      if (mode === "accept" && userId) await loadCampaigns(userId);
    } catch (e: any) {
      alert(`${mode === "accept" ? "Accept" : "Decline"} failed: ${e?.message}`);
    } finally { setProcessingInviteId(""); }
  };

  const handleSelectCampaign = (id: string) => {
    setSelectedCampaignId(id);
    setPickingFaction(false);
    setFactionError("");
  };

  const confirmFaction = async (factionKey: string) => {
    if (!selectedCampaignId) return;
    setSettingFaction(true);
    setFactionError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setFactionError("Session expired. Refresh and try again."); return; }
      const { data, error } = await supabase.functions.invoke("set-faction", {
        body: { campaign_id: selectedCampaignId, faction_key: factionKey },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Failed to set faction");
      setMemberships((prev) =>
        prev.map((m) =>
          m.campaign_id === selectedCampaignId
            ? { ...m, faction_key: factionKey, faction_name: data.faction_name, faction_locked: true }
            : m
        )
      );
      setPickingFaction(false);
      setPendingFaction(null);
    } catch (e: any) {
      setFactionError(e?.message ?? "Failed to set faction.");
    } finally { setSettingFaction(false); }
  };

  const roleBadge = (role: string) => {
    if (role === "lead")  return "bg-brass/20 text-brass border border-brass/40";
    if (role === "admin") return "bg-blood/20 text-blood border border-blood/40";
    return "bg-iron/40 text-parchment/70 border border-parchment/20";
  };

  // ── Not signed in ─────────────────────────────────────────
  if (authLoading) {
    return (
      <Frame title="Access" hideNewCampaign>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-brass/20 border-t-brass rounded-full animate-spin" />
        </div>
      </Frame>
    );
  }

  if (!userEmail) {
    return (
      <Frame title="Access" hideNewCampaign>
        <div className="grid md:grid-cols-2 gap-6">
          <Card title="Enter the Halo">
            <div className="space-y-3">
              <p className="text-parchment/80">Login via magic link — no password required.</p>
              <input
                className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMagicLink()}
              />
              <button
                className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                onClick={sendMagicLink}
              >
                Send login link
              </button>
            </div>
          </Card>
          <Card title="What is Shattered Halo?">
            <p className="text-parchment/80 leading-relaxed">
              Shattered Halo is a narrative campaign tool for Warhammer 40,000 skirmish play.
              Rival factions battle across a range of theatre maps — ring worlds, void ships,
              continental warzones and more — capturing sectors, moving forces in secret, and
              clashing in tabletop battles that decide territory. Between rounds, commanders
              spend Narrative Influence Points to shape missions, deploy units, and outmanoeuvre
              rivals, while a rising Instability clock escalates the campaign toward a brutal endgame.
            </p>
          </Card>
        </div>
      </Frame>
    );
  }

  // ── Signed in ─────────────────────────────────────────────
  return (
    <Frame title="War Room" currentPage="home">
      <div className="space-y-6">

        {/* ── Profile ── */}
        <Card title="Your Profile">
          <div className="space-y-3">
            <div className="text-parchment/60 text-sm">
              Signed in as <span className="text-parchment">{userEmail}</span>
            </div>
            <div>
              <div className="text-sm text-parchment/70 mb-1">Display name</div>
              <div className="flex gap-3">
                <input
                  className="flex-1 px-3 py-2 rounded bg-void border border-brass/30"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Commander name or callsign"
                  onKeyDown={(e) => e.key === "Enter" && saveDisplayName()}
                />
                <button
                  className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
                  onClick={saveDisplayName}
                  disabled={savingName || displayName.trim() === savedName}
                >
                  {savingName ? "Saving…" : "Save"}
                </button>
              </div>
              {savedName && (
                <p className="mt-1 text-xs text-parchment/50">
                  Current: <span className="text-brass">{savedName}</span>
                </p>
              )}
            </div>
            <button
              className="px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-sm"
              onClick={signOut}
            >
              Sign out
            </button>
          </div>
        </Card>

        {/* ── Pending Invites ── */}
        {pendingInvites.length > 0 && (
          <div ref={invitesPanelRef}>
            <Card title={`Campaign Invites — ${pendingInvites.length} pending`}>
              {inviteHighlight && (
                <div className="mb-3 rounded border border-brass/60 bg-brass/10 px-3 py-2 text-sm text-brass">
                  ⬇ You have a campaign invitation waiting — accept or decline below.
                </div>
              )}
              <p className="text-parchment/60 text-sm mb-3">
                You have been invited to the following campaigns.
              </p>
            <div className="space-y-2">
              {pendingInvites.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-3 rounded border border-brass/20 bg-void px-4 py-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-parchment font-semibold truncate">{invite.campaign_name}</div>
                    {invite.invite_message && (
                      <p className="mt-1 text-sm text-parchment/70 leading-relaxed italic">
                        {invite.invite_message}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      disabled={processingInviteId === invite.id}
                      className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm"
                      onClick={() => handleInvite(invite.id, "accept")}
                    >
                      {processingInviteId === invite.id ? "…" : "Accept"}
                    </button>
                    <button
                      disabled={processingInviteId === invite.id}
                      className="px-3 py-1.5 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40 text-sm"
                      onClick={() => handleInvite(invite.id, "decline")}
                    >
                      {processingInviteId === invite.id ? "…" : "Decline"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
          </div>
        )}

        {/* ── Your Campaigns ── */}
        <Card title="Your Campaigns">
          {loadingCampaigns ? (
            <p className="text-parchment/70">Loading campaigns…</p>
          ) : memberships.length === 0 ? (
            <p className="text-parchment/70">
              You are not enrolled in any campaigns yet. Accept an invite above, or{" "}
              <a href="/campaigns" className="text-brass underline">create a new campaign</a>.
            </p>
          ) : (
            <div className="space-y-3">
              {memberships.map((m) => {
                const camp    = m.campaign;
                const theme   = getFactionTheme(m.faction_key);
                const isSelected = m.campaign_id === selectedCampaignId;

                return (
                  <div
                    key={m.campaign_id}
                    className="rounded border border-brass/25 bg-void/60 overflow-hidden"
                  >
                    {/* Campaign header */}
                    <div className="flex items-start gap-3 px-4 py-3">
                      {theme && (
                        <div
                          className="shrink-0 w-10 h-10 rounded bg-cover bg-center border border-brass/30"
                          style={{ backgroundImage: `url(${theme.crest})` }}
                          title={theme.name}
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-parchment truncate">
                          {camp?.name ?? "—"}
                        </div>
                        {camp && (
                          <div className="text-xs text-parchment/50 mt-0.5">
                            Phase {camp.phase} · Round {camp.round_number} · Instability {camp.instability}/10
                          </div>
                        )}
                        <div className="text-xs mt-0.5">
                          {m.faction_name
                            ? <span className="text-brass">{m.faction_name}</span>
                            : <span className="text-parchment/30 italic">No faction selected</span>
                          }
                          {m.commander_name && (
                            <span className="ml-2 text-parchment/40">— {m.commander_name}</span>
                          )}
                        </div>
                      </div>
                      <span className={`shrink-0 text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide ${roleBadge(m.role)}`}>
                        {m.role}
                      </span>
                    </div>

                    {/* Nav buttons — JS navigation, no ?campaign= in URL */}
                    <div className="flex flex-wrap gap-1.5 px-4 pb-3 border-t border-brass/10 pt-2.5">
                      <button
                        onClick={() => navTo("/dashboard", m.campaign_id)}
                        className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs"
                      >
                        Dashboard
                      </button>
                      <button
                        onClick={() => navTo("/map", m.campaign_id)}
                        className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs"
                      >
                        Map
                      </button>
                      <button
                        onClick={() => navTo("/conflicts", m.campaign_id)}
                        className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-xs"
                      >
                        Conflicts
                      </button>
                      {(m.role === "lead" || m.role === "admin") && (
                        <button
                          onClick={() => navTo("/lead", m.campaign_id)}
                          className="px-3 py-1.5 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-xs"
                        >
                          Lead Controls
                        </button>
                      )}

                      {/* Faction pledge */}
                      <div className="ml-auto">
                        {m.faction_key && theme ? (
                          <div className="flex items-center gap-1.5">
                            <img src={theme.crest} alt={theme.name} className="w-5 h-5 object-contain opacity-80" />
                            <span className="text-xs text-parchment/50">{theme.name}</span>
                            {m.faction_locked && <span className="text-xs text-parchment/30">🔒</span>}
                          </div>
                        ) : (isSelected && pickingFaction) ? null : (
                          <button
                            className="px-3 py-1.5 rounded bg-brass/10 border border-brass/30 hover:bg-brass/20 text-xs text-parchment/60"
                            onClick={() => { handleSelectCampaign(m.campaign_id); setPickingFaction(true); setFactionError(""); }}
                          >
                            Pledge Allegiance
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Faction picker */}
                    {isSelected && pickingFaction && !m.faction_key && (
                      <div className="px-4 pb-4 border-t border-brass/15 pt-3">
                        <div className="text-sm text-parchment/70 mb-2">
                          Choose your faction — <span className="text-blood/80">this cannot be changed once confirmed.</span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 mb-3">
                          {FACTION_THEMES.map((f) => (
                            <button
                              key={f.key}
                              disabled={settingFaction}
                              onClick={() => { setPendingFaction(f.key); setFactionError(""); }}
                              className={[
                                "relative rounded overflow-hidden border transition-colors group h-24 disabled:opacity-40",
                                pendingFaction === f.key
                                  ? "border-brass/80 ring-2 ring-brass/50"
                                  : "border-brass/20 hover:border-brass/60",
                              ].join(" ")}
                              style={{ backgroundImage: `url(${f.preview})`, backgroundSize: "cover", backgroundPosition: "center" }}
                              title={f.name}
                            >
                              <div className="absolute inset-0 bg-void/60 group-hover:bg-void/40 transition-colors" />
                              <div className="absolute inset-0 flex flex-col items-center justify-end pb-2 px-1">
                                <img src={f.crest} alt="" className="w-8 h-8 object-contain drop-shadow mb-1" />
                                <span className="text-parchment text-xs font-semibold text-center leading-tight drop-shadow">
                                  {f.name}
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                        {factionError && <p className="text-blood text-sm mb-2">{factionError}</p>}
                        {pendingFaction && (() => {
                          const pf = FACTION_THEMES.find((f) => f.key === pendingFaction);
                          return (
                            <div className="flex items-center gap-3 pt-2 border-t border-brass/20">
                              <div className="flex items-center gap-2 flex-1">
                                {pf && <img src={pf.crest} alt="" className="w-6 h-6 object-contain" />}
                                <span className="text-sm text-parchment/80">
                                  Pledge allegiance to <span className="text-brass font-semibold">{pf?.name ?? pendingFaction}</span>?
                                </span>
                                <span className="text-xs text-blood/70">This cannot be undone.</span>
                              </div>
                              <button
                                disabled={settingFaction}
                                className="px-4 py-1.5 rounded bg-brass/30 border border-brass/60 hover:bg-brass/40 text-sm font-semibold disabled:opacity-40"
                                onClick={() => confirmFaction(pendingFaction)}
                              >
                                {settingFaction ? "Pledging…" : "Confirm"}
                              </button>
                              <button
                                className="text-xs text-parchment/40 hover:text-parchment/60 underline"
                                onClick={() => setPendingFaction(null)}
                              >
                                Back
                              </button>
                            </div>
                          );
                        })()}
                        <button
                          className="text-xs text-parchment/40 hover:text-parchment/60 underline mt-2 block"
                          onClick={() => { setPickingFaction(false); setPendingFaction(null); setFactionError(""); }}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

      </div>
    </Frame>
  );
}
