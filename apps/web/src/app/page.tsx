"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
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

export default function Home() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // Auth state
  const [email, setEmail] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Profile state
  const [displayName, setDisplayName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savingName, setSavingName] = useState(false);

  // Campaigns
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);

  // Faction picker
  const [pickingFaction, setPickingFaction] = useState(false);
  const [settingFaction, setSettingFaction] = useState(false);
  const [factionError, setFactionError]     = useState<string>("");

  // Pending invites
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [processingInviteId, setProcessingInviteId] = useState<string>("");

  // Derived — role for the selected campaign
  const selectedMembership = memberships.find((m) => m.campaign_id === selectedCampaignId);
  const selectedRole = selectedMembership?.role ?? "player";

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
    run();
  }, [supabase]);

  // ── Load campaigns ────────────────────────────────────────
  const loadCampaigns = async (uid: string) => {
    setLoadingCampaigns(true);
    try {
      const { data, error } = await supabase
        .from("campaign_members")
        .select(`
          campaign_id,
          role,
          faction_key,
          faction_name,
          faction_locked,
          commander_name,
          campaigns (name, phase, round_number, instability)
        `)
        .eq("user_id", uid)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows: Membership[] = (data ?? []).map((m: any) => ({
        campaign_id: m.campaign_id,
        role: m.role,
        faction_key: m.faction_key ?? null,
        faction_name: m.faction_name ?? null,
        faction_locked: m.faction_locked ?? false,
        commander_name: m.commander_name ?? null,
        campaign: m.campaigns ?? null,
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
    } catch (e) {
      console.error("loadInvites error:", e);
    }
  };

  useEffect(() => {
    if (!userId) return;
    loadCampaigns(userId);
    loadInvites();
  }, [userId]);

  // ── Actions ───────────────────────────────────────────────
  const sendMagicLink = async () => {
    if (!email.trim()) return alert("Enter your email address.");
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) alert(error.message);
    else alert("Check your email for the login link.");
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    location.reload();
  };

  const saveDisplayName = async () => {
    if (!displayName.trim()) return alert("Enter a name.");
    setSavingName(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: { display_name: displayName.trim() },
      });
      if (error) throw error;
      setSavedName(displayName.trim());
      alert("Name saved.");
    } catch (e: any) {
      alert(e?.message ?? "Failed to save name.");
    } finally {
      setSavingName(false);
    }
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

      // Remove from local list immediately
      setPendingInvites((prev) => prev.filter((i) => i.id !== inviteId));

      // If accepted, reload campaigns so the new one appears
      if (mode === "accept" && userId) {
        await loadCampaigns(userId);
      }
    } catch (e: any) {
      alert(`${mode === "accept" ? "Accept" : "Decline"} failed: ${e?.message}`);
    } finally {
      setProcessingInviteId("");
    }
  };

  // Reset faction picker when a different campaign is selected
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

      // Update local state so UI reflects immediately without a full reload
      setMemberships((prev) =>
        prev.map((m) =>
          m.campaign_id === selectedCampaignId
            ? { ...m, faction_key: factionKey, faction_name: data.faction_name, faction_locked: true }
            : m
        )
      );
      setPickingFaction(false);
    } catch (e: any) {
      setFactionError(e?.message ?? "Failed to set faction.");
    } finally {
      setSettingFaction(false);
    }
  };

  const goToDashboard = () => {
    if (!selectedCampaignId) return;
    window.location.href = `/dashboard?campaign=${selectedCampaignId}`;
  };

  // ── Style helpers ─────────────────────────────────────────
  const roleBadge = (role: string) => {
    if (role === "lead")  return "bg-brass/20 text-brass border border-brass/40";
    if (role === "admin") return "bg-blood/20 text-blood border border-blood/40";
    return "bg-iron/40 text-parchment/70 border border-parchment/20";
  };

  // ── Not signed in ─────────────────────────────────────────
  if (!userEmail) {
    return (
      <Frame title="Access">
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

          <Card title="What this is">
            <ul className="list-disc pl-5 space-y-2 text-parchment/80">
              <li>Secret movement + fog-of-war map reveals</li>
              <li>NIP/NCP economies with audit ledger</li>
              <li>Conflicts auto-detected, missions assigned with NIP influence</li>
              <li>Instability clock drives escalation and endgame</li>
            </ul>
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

        {/* ── Pending Invites — only shown when there are invites waiting ── */}
        {pendingInvites.length > 0 && (
          <Card title={`Campaign Invites — ${pendingInvites.length} pending`}>
            <p className="text-parchment/60 text-sm mb-3">
              You have been invited to the following campaigns. Accept to join or decline to remove the invite.
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
                    <div className="text-xs text-parchment/30 font-mono mt-1">{invite.campaign_id}</div>
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
            <div className="space-y-4">
              <div className="space-y-2">
                {memberships.map((m) => {
                  const c = m.campaign;
                  const active = m.campaign_id === selectedCampaignId;
                  return (
                    <button
                      key={m.campaign_id}
                      onClick={() => handleSelectCampaign(m.campaign_id)}
                      className={[
                        "w-full text-left rounded border px-4 py-3 transition-colors",
                        active
                          ? "border-brass/60 bg-brass/10"
                          : "border-brass/20 bg-void hover:border-brass/40 hover:bg-brass/5",
                      ].join(" ")}
                    >
                      {(() => {
                        const theme = getFactionTheme(m.faction_key);
                        return (
                          <div className="flex items-start justify-between gap-3">
                            {/* Faction crest — only when faction is set */}
                            {theme && (
                              <div
                                className="shrink-0 w-10 h-10 rounded bg-cover bg-center border border-brass/30"
                                style={{ backgroundImage: `url(${theme.crest})` }}
                                title={theme.name}
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-parchment truncate">
                                {c?.name ?? m.campaign_id}
                              </div>
                              {c && (
                                <div className="text-xs text-parchment/50 mt-0.5">
                                  Phase {c.phase} · Round {c.round_number} · Instability {c.instability}/10
                                </div>
                              )}
                              <div className="text-xs text-parchment/60 mt-0.5">
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
                        );
                      })()}
                    </button>
                  );
                })}
              </div>

              {/* Actions for selected campaign */}
              {selectedCampaignId && (
                <div className="flex flex-wrap gap-2 pt-2 border-t border-brass/20">
                  <button
                    onClick={goToDashboard}
                    className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                  >
                    Open Dashboard
                  </button>
                  <a
                    href={`/map?campaign=${selectedCampaignId}`}
                    className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                  >
                    Map
                  </a>
                  <a
                    href={`/conflicts?campaign=${selectedCampaignId}`}
                    className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
                  >
                    Conflicts
                  </a>
                  {(selectedRole === "lead" || selectedRole === "admin") && (
                    <a
                      href={`/lead?campaign=${selectedCampaignId}`}
                      className="px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-sm"
                    >
                      Lead Controls
                    </a>
                  )}
                </div>

              {/* ── Faction picker ── */}
              {selectedCampaignId && (() => {
                const sm = memberships.find((m) => m.campaign_id === selectedCampaignId);
                if (!sm) return null;
                const theme = getFactionTheme(sm.faction_key);

                return (
                  <div className="pt-3 border-t border-brass/20">
                    {sm.faction_key && theme ? (
                      /* Faction already set — show banner */
                      <div
                        className="relative rounded overflow-hidden border border-brass/30"
                        style={{ backgroundImage: `url(${theme.bg})`, backgroundSize: "cover", backgroundPosition: "center" }}
                      >
                        {/* Dark overlay so text is readable */}
                        <div className="absolute inset-0 bg-void/75" />
                        <div className="relative flex items-center gap-4 px-4 py-3">
                          <img src={theme.crest} alt={theme.name} className="w-12 h-12 object-contain drop-shadow-lg" />
                          <div>
                            <div className="text-xs text-parchment/50 uppercase tracking-widest mb-0.5">Sworn Allegiance</div>
                            <div className="text-parchment font-bold text-lg">{theme.name}</div>
                            {sm.faction_locked && (
                              <div className="text-xs text-parchment/40 mt-0.5">
                                Faction locked — contact your lead to change it.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : pickingFaction ? (
                      /* Faction picker grid */
                      <div>
                        <div className="text-sm text-parchment/70 mb-1">
                          Choose your faction — <span className="text-blood/80">this cannot be changed once confirmed.</span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 mb-3">
                          {FACTION_THEMES.map((f) => (
                            <button
                              key={f.key}
                              disabled={settingFaction}
                              onClick={() => confirmFaction(f.key)}
                              className="relative rounded overflow-hidden border border-brass/20 hover:border-brass/60 transition-colors group h-24 disabled:opacity-40"
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
                        {factionError && (
                          <p className="text-blood text-sm mb-2">{factionError}</p>
                        )}
                        <button
                          className="text-xs text-parchment/40 hover:text-parchment/60 underline"
                          onClick={() => { setPickingFaction(false); setFactionError(""); }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      /* No faction — prompt to pick */
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-parchment/50 italic">
                          No faction pledged for this campaign.
                        </div>
                        <button
                          className="px-3 py-1.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm shrink-0"
                          onClick={() => { setPickingFaction(true); setFactionError(""); }}
                        >
                          Pledge Allegiance
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
              </div>
              )}
            </div>
          )}
        </Card>

      </div>
    </Frame>
  );
}
