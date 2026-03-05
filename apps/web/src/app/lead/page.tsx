"use client";
// apps/web/src/app/lead/page.tsx
// Lead Player Dashboard -- campaign controls for lead/admin role.
//
// changelog:
//   2026-03-05 -- Fixed nav to match dashboard pattern; campaignId initialised
//                 from URL query param so nav links are always populated.
//                 Campaign Card and Invite Players Card side-by-side (md:grid-cols-2).
//                 Invite Players lists current members (commander_name, faction, role).
//                 Auto late-allocation when campaign already started.
//                 All controls consolidated inside Campaign Card.
//                 Stage order: spend>recon>movement>conflicts>missions>results>publish.
//                 Start Campaign hidden after started. Advance Stage blocked until
//                 started. Assign Missions/Apply Instability/Offer Catchup gated.
//                 Generate Map modal. Delete Campaign in danger section.
//                 Nav fixed: Frame now receives campaignId and role props so all
//                 nav links (Dashboard, Map, Conflicts, Lead Controls) render.

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// -- Stage order (from advance-round edge function) -------------------------
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

type Member = {
  user_id:        string;
  role:           string;
  commander_name: string | null;
  faction_name:   string | null;
};

// campaignId is read from the URL query param on first render so nav links
// are always populated even before async load completes.
function getQueryCampaign(): string {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get("campaign") ?? "";
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
        .from("campaign-maps").createSignedUrl(data.image_path, 3600);
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
        .from("campaigns").update({ map_id: pendingMapId }).eq("id", campaignId);
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
        await supabase.storage.from("campaign-maps")
          .remove([`${campaignId}/maps/${pendingMapId}/bg.png`]);
      }
    } catch { /* non-fatal */ } finally { setCancelling(false); }
    onClose();
  };

  if (!open) return null;

  const busy = generating || confirming || cancelling;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-void border border-brass/30 rounded-lg shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brass/20 shrink-0">
          <h2 className="text-brass font-semibold uppercase tracking-widest text-sm">Generate Campaign Map</h2>
          <span className="text-xs text-parchment/40 font-mono">{campaign.name}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
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
              <img src={previewUrl} alt="Campaign map preview"
                className="w-full rounded border border-brass/20 object-cover" style={{ maxHeight: "420px" }} />
              <p className="text-xs text-parchment/35 text-center italic">
                Regenerate until satisfied, then confirm to save.
              </p>
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-brass/20 shrink-0">
          <div className="grid grid-cols-3 gap-3">
            <button onClick={handleCancel} disabled={busy}
              className="px-4 py-2.5 rounded border border-blood/30 bg-blood/5 hover:bg-blood/15 text-blood/80 hover:text-blood text-sm transition-colors disabled:opacity-40">
              {cancelling ? <Spinner colour="blood" label="Cancelling..." /> : "Cancel"}
            </button>
            <button onClick={() => doGenerate(pendingMapId)} disabled={busy}
              className="px-4 py-2.5 rounded border border-brass/40 bg-void hover:bg-brass/10 text-brass text-sm font-semibold transition-colors disabled:opacity-40">
              {generating ? <Spinner colour="brass" label="Generating..." /> : "Regenerate Map"}
            </button>
            <button onClick={handleConfirm} disabled={!pendingMapId || busy || !!error}
              className="px-4 py-2.5 rounded bg-brass/25 border border-brass/60 hover:bg-brass/40 text-brass font-bold text-sm uppercase tracking-wider transition-colors disabled:opacity-40">
              {confirming ? <Spinner colour="brass" label="Saving..." /> : "Confirm Map"}
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
// Start Campaign Notification Modal
// -- Result Modal -----------------------------------------------------------

type ResultModalState =
  | { open: false }
  | { open: true; title: string; message: string; tone?: "brass" | "blood" };

function ResultModal({
  state,
  onClose,
}: {
  state: ResultModalState;
  onClose: () => void;
}) {
  if (!state.open) return null;

  const tone = state.tone ?? "brass";
  const border = tone === "brass" ? "border-brass/30" : "border-blood/30";
  const titleCol = tone === "brass" ? "text-brass" : "text-blood";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className={`bg-void border ${border} rounded-lg shadow-2xl w-full max-w-lg`}>
        <div className={`flex items-center justify-between px-5 py-4 border-b ${border}`}>
          <h2 className={`${titleCol} font-semibold uppercase tracking-widest text-sm`}>
            {state.title}
          </h2>
          <button
            onClick={onClose}
            className="text-parchment/40 hover:text-parchment/70 text-xs uppercase tracking-widest"
          >
            Close
          </button>
        </div>

        <div className="p-5">
          <p className="text-parchment/70 text-sm leading-relaxed whitespace-pre-line">
            {state.message}
          </p>
        </div>

        <div className={`px-5 py-4 border-t ${border}`}>
          <button
            onClick={onClose}
            className={`w-full px-4 py-2.5 rounded ${
              tone === "brass"
                ? "bg-brass/25 border border-brass/60 hover:bg-brass/40 text-brass"
                : "bg-blood/15 border border-blood/50 hover:bg-blood/25 text-blood"
            } font-bold text-sm uppercase tracking-wider transition-colors`}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}


// -- Confirm Modal -----------------------------------------------------------

type ConfirmModalState =
  | { open: false }
  | {
      open: true;
      title: string;
      message: string;
      confirmText?: string;
      cancelText?: string;
      tone?: "brass" | "blood";
    };

function ConfirmModal({
  state,
  onConfirm,
  onCancel,
}: {
  state: ConfirmModalState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!state.open) return null;

  const tone = state.tone ?? "blood";
  const border = tone === "brass" ? "border-brass/30" : "border-blood/30";
  const titleCol = tone === "brass" ? "text-brass" : "text-blood";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className={`bg-void border ${border} rounded-lg shadow-2xl w-full max-w-lg`}>
        <div className={`flex items-center justify-between px-5 py-4 border-b ${border}`}>
          <h2 className={`${titleCol} font-semibold uppercase tracking-widest text-sm`}>
            {state.title}
          </h2>
          <button
            onClick={onCancel}
            className="text-parchment/40 hover:text-parchment/70 text-xs uppercase tracking-widest"
          >
            Close
          </button>
        </div>

        <div className="p-5">
          <p className="text-parchment/70 text-sm leading-relaxed whitespace-pre-line">
            {state.message}
          </p>
        </div>

        <div className={`px-5 py-4 border-t ${border} flex gap-3`}>
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded border border-parchment/20 hover:border-parchment/30 text-parchment/70 hover:text-parchment/85 font-bold text-sm uppercase tracking-wider transition-colors"
          >
            {state.cancelText ?? "Cancel"}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 px-4 py-2.5 rounded ${
              tone === "brass"
                ? "bg-brass/25 border border-brass/60 hover:bg-brass/40 text-brass"
                : "bg-blood/15 border border-blood/50 hover:bg-blood/25 text-blood"
            } font-bold text-sm uppercase tracking-wider transition-colors`}
          >
            {state.confirmText ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

// -- Spinner helper ---------------------------------------------------------

function Spinner({ colour, label }: { colour: "brass" | "blood"; label: string }) {
  return (
    <span className="flex items-center justify-center gap-1.5">
      <span className={`w-3 h-3 border-2 rounded-full animate-spin ${
        colour === "brass" ? "border-brass/30 border-t-brass" : "border-blood/30 border-t-blood"
      }`} />
      {label}
    </span>
  );
}

// -- Main Component ---------------------------------------------------------

export default function LeadControls() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // Initialise campaignId from URL immediately so nav links are always correct
  const [campaignId]                    = useState<string>(getQueryCampaign);
  const [campaign, setCampaign]         = useState<Campaign | null>(null);
  const [round, setRound]               = useState<{ stage: string } | null>(null);
  const [role, setRole]                 = useState<string>("player");
  const [members, setMembers]           = useState<Member[]>([]);
  const [inviteEmails, setInviteEmails] = useState<string>("");
  const [inviteStatus, setInviteStatus] = useState<string>("");
  const [startStatus, setStartStatus]   = useState<string>("");
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [resultModal, setResultModal]   = useState<ResultModalState>({ open: false });


  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({ open: false });
  const confirmResolverRef = useRef<((v: boolean) => void) | null>(null);

  const askConfirm = (
    opts: Omit<Extract<ConfirmModalState, { open: true }>, "open">
  ) => {
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmModal({ open: true, ...opts });
    });
  };

  const closeConfirm = (result: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmModal({ open: false });
    resolver?.(result);
  };
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
    if (cErr || !c) { setResultModal({ open: true, tone: "blood", title: "Campaign Not Found", message: cErr?.message ?? "Campaign not found" }); setCampaign(null); setRound(null); return; }
    setCampaign(c as Campaign);

    // Load all members with their commander/faction names
    const { data: memberRows } = await supabase
      .from("campaign_members")
      .select("user_id,role,commander_name,faction_name")
      .eq("campaign_id", cid)
      .order("created_at", { ascending: true });
    setMembers((memberRows ?? []) as Member[]);

    const { data: r } = await supabase
      .from("rounds").select("stage")
      .eq("campaign_id", cid).eq("round_number", c.round_number)
      .maybeSingle();
    setRound(r);
  };

  useEffect(() => { if (campaignId) load(campaignId); }, []); // eslint-disable-line

  const getToken = async (): Promise<string | null> => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setResultModal({ open: true, tone: "blood", title: "Session Expired", message: "Session expired. Please refresh and try again." }); return null; }
    return token;
  };

  const callFn = async (fn: string, extraBody?: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return;
    const { data, error } = await supabase.functions.invoke(fn, {
      body: { campaign_id: campaignId, ...extraBody },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) { setResultModal({ open: true, tone: "blood", title: "Action Failed", message: error.message }); return; }
    if (!data?.ok) { setResultModal({ open: true, tone: "blood", title: "Action Failed", message: data?.error || "Failed" }); return; }
    setResultModal({ open: true, tone: "brass", title: "Success", message: "Done." });
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
    if (error) { setStartStatus(`Error: ${error.message}`); setResultModal({ open: true, tone: "blood", title: "Start Failed", message: `Start failed: ${error.message}` }); return; }
    const allocated = data?.allocated ?? 0;
    setStartStatus(`OK. Allocated: ${allocated}`);

    setResultModal({
      open: true,
      tone: "brass",
      title: "Campaign Started",
      message: `Allocated ${allocated} starting location${allocated === 1 ? "" : "s"}.`,
    });
    await load(campaignId);
  };

  const handleAssignMissions = async () => {
    const go = await askConfirm({
      title: "Confirm Action",
      tone: "blood",
      confirmText: "Proceed",
      message:
        "Assign Missions to all conflicts?

" +
        "Missions will be assigned based on NIP influence settings.
" +
        "Make sure all players have submitted their NIP spending choices before proceeding.

Proceed?",
    });
    if (go) callFn("assign-missions");
  };

  const handleApplyInstability = async () => {
    const go = await askConfirm({
      title: "Confirm Action",
      tone: "blood",
      confirmText: "Proceed",
      message:
        "Apply Halo Instability?

" +
        "This increments the Instability counter by 1 and rolls an event from the d10 table.
" +
        "A public bulletin will be posted automatically.

" +
        "Make sure all conflict results have been recorded before proceeding.

Proceed?",
    });
    if (go) callFn("apply-instability");
  };

  const handleOfferCatchup = async () => {
    const go = await askConfirm({
      title: "Confirm Action",
      tone: "blood",
      confirmText: "Proceed",
      message:
        "Offer Catchup Choice to Underdog?

" +
        "This will automatically identify the player with the fewest sectors and post
" +
        "a catch-up offer to their dashboard. They will choose a bonus to apply.

Proceed?",
    });
    if (!go) return;
    const token = await getToken();
    if (!token) return;
    const { data, error } = await supabase.functions.invoke("offer-catchup", {
      body: { campaign_id: campaignId },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) { setResultModal({ open: true, tone: "blood", title: "Catchup Failed", message: `Failed: ${error.message}` }); return; }
    if (!data?.ok) { setResultModal({ open: true, tone: "blood", title: "Catchup Failed", message: data?.error ?? "Failed" }); return; }
    setResultModal({
      open: true,
      tone: "brass",
      title: "Catchup Offered",
      message: `Catchup offer sent to: ${data.commander_name ?? data.underdog_id}\nThey currently hold ${data.sector_count} sector(s).`,
    });
  };
  // Invite players. If campaign already started, late-allocate each via
  // start-campaign (mode: late) once they accept the invite and sign in --
  // the accept-invites edge function handles this automatically on login.
  const invitePlayers = async () => {
    const emails = inviteEmails.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return;
    setInviteStatus("Sending invites...");
    const { error } = await supabase
      .from("pending_invites")
      .insert(emails.map(email => ({ campaign_id: campaignId, email })));
    if (error) { setInviteStatus(`Error: ${error.message}`); return; }
    setInviteStatus(`Invited: ${emails.join(", ")}`);
    setInviteEmails("");
  };

  const deleteCampaign = async () => {
    const go = await askConfirm({
      title: "Delete Campaign",
      tone: "blood",
      confirmText: "Delete",
      cancelText: "Cancel",
      message:
        `Delete campaign "${campaign?.name ?? campaignId}"?

` +
        "This permanently deletes all campaign data: sectors, rounds, player state, posts, and map artwork.

This cannot be undone.",
    });
    if (!go) return;
    setDeleting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const { data, error } = await supabase.functions.invoke("delete-campaign", {
        body: { campaign_id: campaignId },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) { setResultModal({ open: true, tone: "blood", title: "Delete Failed", message: `Delete failed: ${error.message}` }); return; }
      if (!data?.ok) { setResultModal({ open: true, tone: "blood", title: "Delete Failed", message: data?.error ?? "Delete failed" }); return; }
      window.location.href = "/";
    } finally { setDeleting(false); }
  };

  // -- Derived state --------------------------------------------------------

  const allowed          = role === "lead" || role === "admin";
  const campaignStarted  = round !== null;
  const currentStage     = (round?.stage ?? null) as Stage | null;
  const stageIndex       = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;
  const maxPlayers       = campaign?.rules_overrides?.map_zone_count ?? 8;
  const slotsRemaining   = Math.max(0, maxPlayers - members.length);
  const showAssignMissions   = campaignStarted && currentStage === "missions";
  const showApplyInstability = campaignStarted && currentStage === "results";
  const showOfferCatchup     = campaignStarted && currentStage === "results";

  const roleColour = (r: string) =>
    r === "lead" ? "text-brass" : r === "admin" ? "text-blood/80" : "text-parchment/50";

  // -- Render ----------------------------------------------------------------

  return (
    <Frame title="Lead Controls" currentPage="lead" campaignId={campaignId} role={role}>
      <div className="space-y-6">

        {/* ── Top row: Campaign Card + Invite Players side by side ─────── */}
        <div className="grid md:grid-cols-2 gap-6 items-start">

          {/* ── Campaign Card ──────────────────────────────────────────── */}
          <Card title={campaign?.name ?? "Campaign"}>
            {campaign ? (
              <div className="space-y-4">

                {/* Status + key numbers */}
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="text-parchment/50 text-xs">
                      Phase {campaign.phase} &bull; Round {campaign.round_number} &bull; Instability {campaign.instability}/10
                    </p>
                    <p className="text-parchment/40 text-xs">Role: {role}</p>
                  </div>
                  <span className={`shrink-0 px-2.5 py-1 rounded text-xs font-bold uppercase tracking-widest border ${
                    campaignStarted
                      ? "bg-brass/20 border-brass/50 text-brass"
                      : "bg-parchment/5 border-parchment/20 text-parchment/40"
                  }`}>
                    {campaignStarted ? "Active" : "Not Started"}
                  </span>
                </div>

                {/* Stage progress strip */}
                {campaignStarted && (
                  <div>
                    <p className="text-xs text-parchment/40 mb-1.5">Stage</p>
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

                {!allowed && (
                  <p className="text-blood/80 text-sm">You are not authorised for lead controls.</p>
                )}

                {/* Action buttons -- lead/admin only */}
                {allowed && (
                  <div className="space-y-2 pt-1 border-t border-brass/10">

                    {/* Generate / Regenerate Map */}
                    <button onClick={() => setMapModalOpen(true)}
                      className="w-full px-4 py-2.5 rounded bg-brass/15 border border-brass/40 hover:bg-brass/25 text-brass text-sm font-semibold uppercase tracking-wider transition-colors">
                      {campaign.map_id ? "Regenerate Map" : "Generate Map"}
                    </button>

                    {/* Start Campaign -- hidden once started */}
                    {!campaignStarted && (
                      <div>
                        <button onClick={startCampaign}
                          className="w-full px-4 py-2.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 text-sm font-semibold transition-colors">
                          Start Campaign
                        </button>
                        {startStatus && <p className="mt-1 text-xs text-parchment/50">{startStatus}</p>}
                        <p className="mt-1 text-xs text-parchment/35">
                          Allocates secret starting locations for all current members.
                        </p>
                      </div>
                    )}

                    {/* Advance Stage -- blocked until started */}
                    <div>
                      <button onClick={() => callFn("advance-round")} disabled={!campaignStarted}
                        className="w-full px-4 py-2.5 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm transition-colors">
                        Advance Stage
                      </button>
                      {!campaignStarted && (
                        <p className="mt-1 text-xs text-parchment/30 italic">Start the campaign first.</p>
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
                          Assigns missions to all conflicts based on NIP influence.
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
                          Increments Instability by 1, rolls d10 event, posts bulletin.
                        </p>
                      </div>
                    )}

                    {/* Offer Catchup -- results stage only */}
                    {showOfferCatchup && (
                      <div>
                        <button onClick={handleOfferCatchup}
                          className="w-full px-4 py-2.5 rounded bg-parchment/10 border border-parchment/25 hover:bg-parchment/20 text-sm font-semibold transition-colors">
                          Offer Catchup Choice to Underdog
                        </button>
                        <p className="mt-1 text-xs text-parchment/35">
                          Auto-detects the player with fewest sectors and posts a bonus offer to their dashboard.
                        </p>
                      </div>
                    )}

                    {/* Delete -- danger section */}
                    <div className="pt-2 border-t border-blood/15">
                      <button onClick={deleteCampaign} disabled={deleting}
                        className="w-full px-4 py-2 rounded bg-blood/10 border border-blood/25 hover:bg-blood/25 disabled:opacity-40 text-blood/70 hover:text-blood text-sm transition-colors">
                        {deleting ? "Deleting..." : "Delete Campaign"}
                      </button>
                      <p className="mt-1 text-xs text-parchment/25 italic">
                        Permanently deletes all campaign data.
                      </p>
                    </div>

                  </div>
                )}

              </div>
            ) : (
              <p className="text-parchment/40 text-sm italic">Loading campaign...</p>
            )}
          </Card>

          {/* ── Invite Players Card ────────────────────────────────────── */}
          {campaign && allowed && (
            <Card title="Players">
              <div className="space-y-4">

                {/* Member list */}
                <div>
                  <p className="text-xs text-parchment/40 mb-2">
                    {members.length} / {maxPlayers} players
                    {slotsRemaining > 0 && (
                      <span className="ml-2 text-parchment/30">&bull; {slotsRemaining} slot{slotsRemaining !== 1 ? "s" : ""} open</span>
                    )}
                    {slotsRemaining === 0 && (
                      <span className="ml-2 text-blood/60 font-semibold">&bull; Full</span>
                    )}
                  </p>
                  <div className="space-y-1.5">
                    {members.map((m) => (
                      <div key={m.user_id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-void border border-brass/10">
                        <div className="min-w-0">
                          <p className="text-parchment/80 text-sm truncate">
                            {m.commander_name ?? <span className="text-parchment/30 italic">Unnamed Commander</span>}
                          </p>
                          {m.faction_name && (
                            <p className="text-parchment/40 text-xs truncate">{m.faction_name}</p>
                          )}
                        </div>
                        <span className={`shrink-0 text-xs font-mono uppercase ${roleColour(m.role)}`}>
                          {m.role}
                        </span>
                      </div>
                    ))}
                    {members.length === 0 && (
                      <p className="text-parchment/30 text-xs italic px-1">No members yet.</p>
                    )}
                  </div>
                </div>

                {/* Invite form */}
                <div className="border-t border-brass/10 pt-3 space-y-2">
                  <p className="text-xs text-parchment/50 font-semibold">Invite Players</p>
                  <input
                    className="w-full px-3 py-2 rounded bg-void border border-brass/30 focus:outline-none focus:border-brass/60 text-sm"
                    value={inviteEmails}
                    onChange={(e) => setInviteEmails(e.target.value)}
                    placeholder="email1@example.com, email2@example.com"
                    disabled={slotsRemaining === 0}
                  />
                  <button
                    onClick={invitePlayers}
                    disabled={!inviteEmails.trim() || slotsRemaining === 0}
                    className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40 text-sm transition-colors"
                  >
                    Send Invites
                  </button>
                  {inviteStatus && <p className="text-xs text-parchment/50">{inviteStatus}</p>}
                  <p className="text-xs text-parchment/30 leading-relaxed">
                    {campaignStarted
                      ? "Campaign is active. Invited players will be automatically allocated a starting sector as late arrivals when they sign in."
                      : "Players auto-join when they sign in with the invited email."}
                  </p>
                </div>

              </div>
            </Card>
          )}

        </div>

        {/* ── What's Next ───────────────────────────────────────────────── */}
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
      
      <ResultModal
        state={resultModal}
        onClose={() => setResultModal({ open: false })}
      />
      

    </Frame>
  );
}