"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

type Membership = {
  campaign_id: string;
  role: string;
  faction_name: string | null;
  commander_name: string | null;
  campaign: {
    name: string;
    phase: number;
    round_number: number;
    instability: number;
  } | null;
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

      // Load saved display name from auth user metadata
      const name = data.user.user_metadata?.display_name ?? "";
      setDisplayName(name);
      setSavedName(name);
    };
    run();
  }, [supabase]);

  // ── Load campaigns when user is known ────────────────────
  useEffect(() => {
    if (!userId) return;
    const run = async () => {
      setLoadingCampaigns(true);
      try {
        const { data, error } = await supabase
          .from("campaign_members")
          .select(`
            campaign_id,
            role,
            faction_name,
            commander_name,
            campaigns (name, phase, round_number, instability)
          `)
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (error) throw error;

        const rows: Membership[] = (data ?? []).map((m: any) => ({
          campaign_id: m.campaign_id,
          role: m.role,
          faction_name: m.faction_name,
          commander_name: m.commander_name,
          campaign: m.campaigns ?? null,
        }));

        setMemberships(rows);
        if (rows.length) setSelectedCampaignId(rows[0].campaign_id);
      } catch (e: any) {
        console.error(e);
      } finally {
        setLoadingCampaigns(false);
      }
    };
    run();
  }, [userId, supabase]);

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

  const goToDashboard = () => {
    if (!selectedCampaignId) return;
    window.location.href = `/dashboard?campaign=${selectedCampaignId}`;
  };

  // ── Role badge ────────────────────────────────────────────
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
    <Frame
      title="War Room"
      currentPage="home"
    >
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

        {/* ── Campaign selector ── */}
        <Card title="Your Campaigns">
          {loadingCampaigns ? (
            <p className="text-parchment/70">Loading campaigns…</p>
          ) : memberships.length === 0 ? (
            <div className="space-y-2">
              <p className="text-parchment/70">You are not enrolled in any campaigns yet.</p>
              <a
                href="/campaigns"
                className="inline-block px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm"
              >
                Create a campaign
              </a>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Campaign list */}
              <div className="space-y-2">
                {memberships.map((m) => {
                  const c = m.campaign;
                  const active = m.campaign_id === selectedCampaignId;
                  return (
                    <button
                      key={m.campaign_id}
                      onClick={() => setSelectedCampaignId(m.campaign_id)}
                      className={[
                        "w-full text-left rounded border px-4 py-3 transition-colors",
                        active
                          ? "border-brass/60 bg-brass/10"
                          : "border-brass/20 bg-void hover:border-brass/40 hover:bg-brass/5",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-parchment truncate">
                            {c?.name ?? m.campaign_id}
                          </div>
                          {c && (
                            <div className="text-xs text-parchment/50 mt-0.5">
                              Phase {c.phase} · Round {c.round_number} · Instability {c.instability}/10
                            </div>
                          )}
                          {(m.faction_name || m.commander_name) && (
                            <div className="text-xs text-parchment/60 mt-0.5">
                              {m.faction_name && <span>{m.faction_name}</span>}
                              {m.commander_name && (
                                <span className="ml-2 text-parchment/40">— {m.commander_name}</span>
                              )}
                            </div>
                          )}
                        </div>
                        <span className={`shrink-0 text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wide ${roleBadge(m.role)}`}>
                          {m.role}
                        </span>
                      </div>
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
              )}
            </div>
          )}
        </Card>

      </div>
    </Frame>
  );
}
