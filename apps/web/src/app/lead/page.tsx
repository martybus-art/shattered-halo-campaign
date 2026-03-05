"use client";
// apps/web/src/app/lead/page.tsx
// Lead Player Dashboard -- campaign controls for lead/admin role.
//
// changelog:
//   2026-03-05 -- Consolidated all controls into Campaign Card. Removed campaign
//                 ID input (loaded from URL). Added campaign started/not-started
//                 status. Fixed stage order: spend>recon>movement>conflicts>
//                 missions>results>publish. Start Campaign hidden after started.
//                 Advance Stage blocked until campaign started. Assign Missions
//                 only shown in missions stage; Apply Instability only in results
//                 stage. Reminder confirm dialogs for both. Generate Map modal
//                 from lead page. Replaced Late Player Allocation with Invite
//                 Players card. Delete Campaign in Campaign Card danger section.

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// -- Stage order from advance-round edge function ---------------------------
// spend > recon > movement > conflicts > missions > results > publish
const STAGE_ORDER = ["spend", "recon", "movement", "conflicts", "missions", "results", "publish"] as const;
type Stage = typeof STAGE_ORDER[number];

// -- Types ------------------------------------------------------------------

type Campaign = {
  id:                 string;
  name:               string;
  phase:              number;
  round_number:       number;
  instability:        number;
  map_id:             string | null;
  rules_overrides:    Record<string, any>;
  campaign_narrative: string | null;
};
type Round = { stage: string };

function getQueryCampaign(): string | null {
  if (typeof window === "undefined") return null;
  const u = new URL(window.location.href);
  return u.searchParams.get("campaign");
}

// -- Generate Map Modal -----------------------------------------------------

interface MapModalProps {
  open:        boolean;
  campaignId:  string;
  campaign:    Campaign;
  onClose:     () => void;
  onConfirmed: () => void;
}

function GenerateMapModal({ open, campaignId, campaign, onClose, onConfirmed }: MapModalProps) {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [generating, setGenerating]     = useState(false);
  const [pendingMapId, setPendingMapId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl]     = useState<string | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [confirming, setConfirming]     = useState(false);
  const [cancelling, setCancelling]     = useState(false);

  // Auto-start generation when modal opens
  useEffect(() => {
    if (open) {
      setPendingMapId(null);
      setPreviewUrl(null);
      setError(null);
      doGenerate(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const doGenerate = async (existingMapId: string | null) => {
    setGenerating(true);
    setPreviewUrl(null);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Session expired -- please refresh.");

      const ro = campaign.rules_overrides ?? {};
      const { data, error: fnErr } = await supabase.functions.invoke("generate-map", {
        body: {
          ...(existingMapId ? { map_id: existingMapId } : {}),
          campaign_id:        campaignId,
          layout:             ro.map_layout      ?? "ring",
          zone_count:         ro.map_zone_count  ?? 8,
          biome:              ro.map_biome       ?? "ash_wastes",
          mixed_biomes:       ro.map_mixed_biomes ?? false,
          campaign_name:      campaign.name,
          campaign_narrative: campaign.campaign_narrative ?? ro.map_narrative ?? "",
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (fnErr) throw fnErr;
      if (!data?.ok) throw new Error(data?.error ?? "Generation failed");

      setPendingMapId(data.map_id);

      const { data: urlData, error: urlErr } = await supabase.storage
        .from("campaign-maps")
        .createSignedUrl(data.image_path, 3600);
      if (urlErr || !urlData?.signedUrl) throw new Error("Could not load image preview");
      setPreviewUrl(urlData.signedUrl);

    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleConfirm = async () => {
    if (!pendingMapId) return;
    setConfirming(true);
    try {
      const { error: updateErr } = await supabase
        .from("campaigns")
        .update({ map_id: pendingMapId })
        .eq("id", campaignId);
      if (updateErr) throw updateErr;
      onConfirmed();
    } catch (e: any) {
      setError(`Confirm failed: ${e?.message ?? String(e)}`);
      setConfirming(false);
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      if (pendingMapId) {
        await supabase.from("maps").delete().eq("id", pendingMapId);
        await supabase.storage.from("campaign-maps").remove([`${campaignId}/maps/${pendingMapId}/bg.png`]);
      }
    } catch { /* non-fatal */ } finally {
      setCancelling(false);
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-void border border-brass/30 rounded-lg shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

        <div className="flex items-center justify-between px-5 py-4 border-b border-brass/20 shrink-0">
          <h2 className="text-brass font-semibold uppercase tracking-widest text-sm">Generate Campaign Map</h2>
          <span className="text-xs text-parchment/40 font-mono">{campaign.name}</span>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {generating && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="w-10 h-10 border-4 border-brass/20 border-t-brass rounded-full animate-spin" />
              <p className="text-parchment/60 text-sm">The Adeptus Mechanicus forges your warzone map...</p>
              <p className="text-parchment/30 text-xs">This may take up to 60 seconds.</p>
            </div>
          )}
          {!generating && error && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <p className="text-blood text-sm font-semibold">Generation failed</p>
              <p className="text-parchment/50 text-xs text-center max-w-sm">{error}</p>
            </div>
          )}
          {!generating && previewUrl && (
            <div className="space-y-3">
              <img src={previewUrl} alt="Campaign map preview" className="w-full rounded border border-brass/20 object-cover" style={{ maxHeight: "420px" }} />
              <p className="text-xs text-parchment/35 text-center italic">Regenerate until satisfied, then confirm to save.</p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-brass/20 shrink-0">
          <div className="grid grid-cols-3 gap-3">
            <button onClick={handleCancel} disabled={generating || confirming || cancelling}
              className="px-4 py-2.5 rounded border border-blood/30 bg-blood/5 hover:bg-blood/15 text-blood/80 hover:text-blood text-sm transition-colors disabled:opacity-40">
              {cancelling ? <span className="flex items-center justify-center gap-1.5"><span className="w-3 h-3 border-2 border-blood/30 border-t-blood rounded-full animate-spin" />Cancelling...</span> : "Cancel"}
            </button>
            <button onClick={() => doGenerate(pendingMapId)} disabled={generating || confirming || cancelling}
              className="px-4 py-2.5 rounded border border-brass/40 bg-void hover:bg-brass/10 text-brass text-sm font-semibold transition-colors disabled:opacity-40">
              {generating ? <span className="flex items-center justify-center gap-1.5"><span className="w-3 h-3 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />Generating...</span> : "Regenerate Map"}
            </button>
            <button onClick={handleConfirm} disabled={!pendingMapId || generating || confirming || cancelling || !!error}
              className="px-4 py-2.5 rounded bg-brass/25 border border-brass/60 hover:bg-brass/40 text-brass font-bold text-sm uppercase tracking-wider transition-colors disabled:opacity-40">
              {confirming ? <span className="flex items-center justify-center gap-1.5"><span className="w-3 h-3 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />Saving...</span> : "Confirm Map"}
            </button>
          </div>
          <p className="mt-2 text-xs text-parchment/25 text-center italic">
            Cancel discards the generated image and removes it from storage.
          </p>
        </div>

      </div>
    </div>
  );
}

// -- Main Component ---------------------------------------------------------

export default function LeadControls() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [campaignId, setCampaignId]     = useState<string>("");
  const [campaign, setCampaign]         = useState<Campaign | null>(null);
  const [round, setRound]               = useState<Round | null>(null);
  const [role, setRole]                 = useState<string>("player");
  const [memberCount, setMemberCount]   = useState<number>(0);
  const [inviteEmails, setInviteEmails] = useState<string>("");
  const [lateUserId, setLateUserId]     = useState<string>("");
  const [inviteStatus, setInviteStatus] = useState<string>("");
  const [startStatus, setStartStatus]   = useState<string>("");
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [deleting, setDeleting]         = useState(false);

  const load = async (cid: string) => {
    const { data: userResp } = await supabase.auth.getUser();
    const uid = userResp.user?.id;
    if (!uid) return;

    const { data: mem } = await supabase
      .from("campaign_members").select("role")
      .eq("campaign_id", cid).eq("user_id", uid).single();
    setRole(mem?.role ?? "player");

    const { data: c, error: cErr } = await supabase
      .from("campaigns")
      .select("id,name,phase,round_number,instability,map_id,rules_overrides,campaign_narrative")
      .eq("id", cid).single();

    if (cErr || !c) {
      alert(cErr?.message ?? "Campaign not found");
      setCampaign(null);
      setRound(null);
      return;
    }
    setCampaign(c as Campaign);

    // Member count for invite slot display
    const { count } = await supabase
      .from("campaign_members")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", cid);
    setMemberCount(count ?? 0);

    const { data: r, error: rErr } = await supabase
      .from("rounds").select("stage")
      .eq("campaign_id", cid)
      .eq("round_number", c.round_number)
      .maybeSingle();

    if (rErr) { setRound(null); return; }
    setRound(r);
  };

  useEffect(() => {
    const q = getQueryCampaign();
    if (q) setCampaignId(q);
  }, []);

  useEffect(() => { if (campaignId) load(campaignId); }, [campaignId]); // eslint-disable-line

  const getToken = async (): Promise<string | null> => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { alert("Session expired. Please refresh and try again."); return null; }
    return token;
  };

  const callFn = async (fn: string, extraBody?: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return;
    const { data, error } = await supabase.functions.invoke(fn, {
      body: { campaign_id: campaignId, ...extraBody },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) return alert(error.message);
    if (!data?.ok) return alert(data?.error || "Failed");
    alert("Done");
    await load(campaignId);
  };

  const startCampaign = async () => {
    setStartStatus("Starting campaign...");
    const token = await getToken();
    if (!token) return;
    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "initial" },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) { setStartStatus(`Error: ${error.message}`); return alert(`Start failed: ${error.message}`); }
    setStartStatus(`OK. Allocated: ${data?.allocated ?? 0}`);
    alert(`Campaign started. Allocated: ${data?.allocated ?? 0} starting locations.`);
    await load(campaignId);
  };

  // Assign Missions -- only callable in missions stage, shows reminder first
  const handleAssignMissions = () => {
    const go = window.confirm(
      "Assign Missions to all conflicts?\n\n" +
      "This will assign missions based on NIP influence settings.\n" +
      "Make sure all players have submitted their NIP spending choices before proceeding.\n\n" +
      "Proceed?"
    );
    if (!go) return;
    callFn("assign-missions");
  };

  // Apply Instability -- only callable in results stage, shows reminder first
  const handleApplyInstability = () => {
    const go = window.confirm(
      "Apply Halo Instability?\n\n" +
      "This increments the Instability counter by 1 and rolls an event from the d10 table.\n" +
      "A public bulletin will be posted automatically.\n\n" +
      "Make sure all conflict results have been recorded before proceeding.\n\n" +
      "Proceed?"
    );
    if (!go) return;
    callFn("apply-instability");
  };

  // Invite players -- adds emails to pending_invites.
  // If campaign started, also prompts for late allocation by user_id.
  // Note: pending_invites requires an INSERT RLS policy for leads, or a
  //       dedicated edge function, if the direct insert fails with a
  //       permissions error.
  const invitePlayers = async () => {
    const emails = inviteEmails.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return;
    setInviteStatus("Sending invites...");

    const { error } = await supabase
      .from("pending_invites")
      .insert(emails.map(email => ({ campaign_id: campaignId, email })));

    if (error) {
      setInviteStatus(`Error: ${error.message}`);
      return;
    }
    setInviteStatus(`Invited: ${emails.join(", ")}`);
    setInviteEmails("");
  };

  const allocateLatePlayer = async () => {
    if (!lateUserId.trim()) return alert("Enter the player's user ID");
    const token = await getToken();
    if (!token) return;
    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "late", late_user_id: lateUserId.trim() },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) return alert(`Late allocation failed: ${error.message}`);
    if (!data?.ok) return alert(data?.error ?? "Failed");
    alert(`Late allocation OK. Allocated: ${data?.allocated ?? 0} sector(s).`);
    setLateUserId("");
    await load(campaignId);
  };

  const deleteCampaign = async () => {
    if (!campaignId) return;
    const confirmed = window.confirm(
      `Delete campaign "${campaign?.name ?? campaignId}"?\n\n` +
      "This will permanently delete all campaign data: sectors, rounds, player state, posts, and map artwork.\n\n" +
      "This cannot be undone."
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const { data, error } = await supabase.functions.invoke("delete-campaign", {
        body: { campaign_id: campaignId },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) return alert(`Delete failed: ${error.message}`);
      if (!data?.ok) return alert(data?.error ?? "Delete failed");
      window.location.href = "/";
    } finally {
      setDeleting(false);
    }
  };

  // -- Derived state --------------------------------------------------------

  const allowed         = role === "lead" || role === "admin";
  // A campaign is "started" when round 1 has been opened (round record exists).
  // start-campaign creates round 1 at "spend" stage.
  const campaignStarted = round !== null;
  const currentStage    = (round?.stage ?? null) as Stage | null;
  const maxPlayers      = campaign?.rules_overrides?.map_zone_count ?? 8;
  const slotsRemaining  = Math.max(0, maxPlayers - memberCount);

  // Stage-gated visibility
  const showAssignMissions   = campaignStarted && currentStage === "missions";
  const showApplyInstability = campaignStarted && currentStage === "results";

  // Stage progress display
  const stageIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;

  // -- Render ----------------------------------------------------------------

  return (
    <Frame title="Lead Player Dashboard" right={<a className="underline" href={`/dashboard?campaign=${campaignId}`}>Back</a>}>
      <div className="space-y-6">

        {/* ── Campaign Card ─────────────────────────────────────────────── */}
        <Card title="Campaign">

          {/* Campaign info */}
          {campaign ? (
            <div className="space-y-4">

              {/* Name + status badge */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-parchment font-semibold text-base">{campaign.name}</p>
                  <p className="text-parchment/50 text-xs mt-0.5">
                    Phase {campaign.phase} &bull; Round {campaign.round_number} &bull; Instability {campaign.instability}/10
                  </p>
                  <p className="text-parchment/50 text-xs">Role: {role}</p>
                </div>
                <span className={`shrink-0 px-2.5 py-1 rounded text-xs font-bold uppercase tracking-widest border ${
                  campaignStarted
                    ? "bg-brass/20 border-brass/50 text-brass"
                    : "bg-parchment/5 border-parchment/20 text-parchment/40"
                }`}>
                  {campaignStarted ? "Active" : "Not Started"}
                </span>
              </div>

              {/* Stage progress */}
              {campaignStarted && (
                <div>
                  <p className="text-xs text-parchment/40 mb-1.5">Current Stage</p>
                  <div className="flex gap-1 flex-wrap">
                    {STAGE_ORDER.map((s, i) => (
                      <span key={s} className={`px-2 py-0.5 rounded text-xs font-mono uppercase ${
                        s === currentStage
                          ? "bg-brass/30 border border-brass/60 text-brass font-bold"
                          : i < stageIndex
                            ? "bg-parchment/5 border border-parchment/10 text-parchment/25 line-through"
                            : "bg-void border border-parchment/10 text-parchment/35"
                      }`}>
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {!allowed && (
                <p className="text-blood/80 text-sm">You are not authorised for leader controls in this campaign.</p>
              )}

              {/* ── Action buttons ─────────────────────────────────────── */}
              {allowed && (
                <div className="space-y-2.5 pt-1 border-t border-brass/10">

                  {/* Generate / Regenerate Map */}
                  <button onClick={() => setMapModalOpen(true)}
                    className="w-full px-4 py-2.5 rounded bg-brass/15 border border-brass/40 hover:bg-brass/25 text-brass text-sm font-semibold uppercase tracking-wider transition-colors">
                    {campaign.map_id ? "Regenerate Map" : "Generate Map"}
                  </button>

                  {/* Start Campaign -- hidden once campaign has started */}
                  {!campaignStarted && (
                    <div>
                      <button onClick={startCampaign}
                        className="w-full px-4 py-2.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm font-semibold transition-colors">
                        Start Campaign (Allocate Starting Locations)
                      </button>
                      {startStatus && <p className="mt-1.5 text-xs text-parchment/50">Status: {startStatus}</p>}
                      <p className="mt-1 text-xs text-parchment/35">
                        Allocates secret starting locations for all current members. Cannot be undone.
                      </p>
                    </div>
                  )}

                  {/* Advance Stage -- disabled until campaign started */}
                  <div>
                    <button
                      disabled={!campaignStarted}
                      onClick={() => callFn("advance-round")}
                      className="w-full px-4 py-2.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm transition-colors">
                      Advance Stage
                    </button>
                    {!campaignStarted && (
                      <p className="mt-1 text-xs text-parchment/30 italic">Start the campaign first to advance stages.</p>
                    )}
                  </div>

                  {/* Assign Missions -- missions stage only */}
                  {showAssignMissions && (
                    <div>
                      <button onClick={handleAssignMissions}
                        className="w-full px-4 py-2.5 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 text-sm font-semibold transition-colors">
                        Assign Missions
                      </button>
                      <p className="mt-1 text-xs text-parchment/35">
                        Assigns missions to all unresolved conflicts based on NIP influence settings.
                      </p>
                    </div>
                  )}

                  {/* Apply Instability -- results stage only */}
                  {showApplyInstability && (
                    <div>
                      <button onClick={handleApplyInstability}
                        className="w-full px-4 py-2.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm font-semibold transition-colors">
                        Apply Instability (Game Day)
                      </button>
                      <p className="mt-1 text-xs text-parchment/35">
                        Increments Halo Instability by 1, rolls a d10 event, and posts a public bulletin.
                      </p>
                    </div>
                  )}

                  {/* Delete Campaign -- danger */}
                  <div className="pt-2 border-t border-blood/15">
                    <button onClick={deleteCampaign} disabled={deleting}
                      className="w-full px-4 py-2 rounded bg-blood/15 border border-blood/30 hover:bg-blood/30 disabled:opacity-40 text-blood/80 hover:text-blood text-sm transition-colors">
                      {deleting ? "Deleting..." : `Delete Campaign`}
                    </button>
                    <p className="mt-1 text-xs text-parchment/25 italic">
                      Permanently deletes all campaign data. This cannot be undone.
                    </p>
                  </div>

                </div>
              )}

            </div>
          ) : (
            /* No campaign loaded yet -- show the ID input */
            <div className="flex flex-col md:flex-row gap-3">
              <input
                className="flex-1 px-3 py-2 rounded bg-void border border-brass/30"
                placeholder="Campaign ID (from URL or paste here)"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
              />
              <button
                className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30"
                onClick={() => load(campaignId)}
              >
                Load
              </button>
            </div>
          )}

        </Card>

        {/* ── Invite Players Card ───────────────────────────────────────── */}
        {campaign && allowed && (
          <Card title="Invite Players">
            <div className="space-y-3">

              <div className="flex items-center justify-between">
                <p className="text-parchment/70 text-sm">
                  {memberCount} / {maxPlayers} players
                </p>
                {slotsRemaining === 0 && (
                  <span className="text-xs text-blood/70 font-semibold">Campaign Full</span>
                )}
                {slotsRemaining > 0 && (
                  <span className="text-xs text-parchment/40">{slotsRemaining} slot{slotsRemaining !== 1 ? "s" : ""} remaining</span>
                )}
              </div>

              <input
                className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm"
                value={inviteEmails}
                onChange={(e) => setInviteEmails(e.target.value)}
                placeholder="commander@warzone.com, sergeant@forge.world"
                disabled={slotsRemaining === 0}
              />

              <button
                onClick={invitePlayers}
                disabled={!inviteEmails.trim() || slotsRemaining === 0}
                className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm transition-colors"
              >
                Send Invites
              </button>

              {inviteStatus && (
                <p className="text-xs text-parchment/50">{inviteStatus}</p>
              )}

              <p className="text-xs text-parchment/35 leading-relaxed">
                {campaignStarted
                  ? "Campaign is active -- invited players will join as late arrivals and must be manually allocated a starting sector below once they sign in."
                  : "Players auto-join when they sign in with the invited email. Campaign must be started to allocate starting locations."}
              </p>

              {/* Late allocation -- only shown after campaign started */}
              {campaignStarted && (
                <div className="pt-3 border-t border-brass/10 space-y-2">
                  <p className="text-xs text-parchment/50 font-semibold">Allocate Late Player</p>
                  <p className="text-xs text-parchment/35">
                    Once a late player has signed in and joined, enter their user ID to assign them a starting sector.
                  </p>
                  <input
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm font-mono"
                    value={lateUserId}
                    onChange={(e) => setLateUserId(e.target.value)}
                    placeholder="Player user_id (uuid)"
                  />
                  <button
                    onClick={allocateLatePlayer}
                    disabled={!lateUserId.trim()}
                    className="w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40 text-sm transition-colors"
                  >
                    Allocate Late Player
                  </button>
                </div>
              )}

            </div>
          </Card>
        )}

        {/* ── What's Next Card ──────────────────────────────────────────── */}
        <Card title="What's next">
          <ul className="list-disc pl-5 space-y-2 text-parchment/75">
            <li>Add "Process Movement" + "Detect Conflicts" functions to fully remove admin work.</li>
            <li>Add "Resolve Recon" and "Apply Underdog Choices" functions.</li>
            <li>Add "Publish Bulletin" helper that writes a public post scaffold.</li>
          </ul>
        </Card>

      </div>

      {/* Generate Map Modal */}
      {campaign && (
        <GenerateMapModal
          open={mapModalOpen}
          campaignId={campaignId}
          campaign={campaign}
          onClose={() => setMapModalOpen(false)}
          onConfirmed={() => { setMapModalOpen(false); load(campaignId); }}
        />
      )}

    </Frame>
  );
}
