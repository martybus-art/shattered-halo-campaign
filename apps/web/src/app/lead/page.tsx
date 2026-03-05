"use client";
// apps/web/src/app/lead/page.tsx
// Lead Player Dashboard -- campaign controls for lead/admin role.
//
// changelog:
//   2026-03-04 -- added Generate Map modal (top-right of Campaign Status card).
//                 Modal shows live image preview; buttons: Confirm Map,
//                 Regenerate Map, Cancel. Cancel deletes map record + storage.
//                 Confirm sets campaign.map_id. Added Delete Campaign card.

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

// -- Types ------------------------------------------------------------------

type Campaign = {
  id: string;
  name: string;
  phase: number;
  round_number: number;
  instability: number;
  map_id: string | null;
  rules_overrides: Record<string, any>;
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

  const [generating, setGenerating]   = useState(false);
  const [pendingMapId, setPendingMapId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl]   = useState<string | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [confirming, setConfirming]   = useState(false);
  const [cancelling, setCancelling]   = useState(false);

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

      // Store the map id (may be new if first generation)
      setPendingMapId(data.map_id);

      // Get a signed URL for the image preview
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
      // Update campaign.map_id -- uses the UPDATE RLS policy for leads
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
        // Delete the map record (uses maps_delete_creator RLS policy)
        await supabase.from("maps").delete().eq("id", pendingMapId);
        // Delete storage file
        const storagePath = `${campaignId}/maps/${pendingMapId}/bg.png`;
        await supabase.storage.from("campaign-maps").remove([storagePath]);
      }
    } catch { /* non-fatal -- close modal regardless */ } finally {
      setCancelling(false);
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-void border border-brass/30 rounded-lg shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-brass/20 shrink-0">
          <h2 className="text-brass font-semibold uppercase tracking-widest text-sm">Generate Campaign Map</h2>
          <span className="text-xs text-parchment/40 font-mono">{campaign.name}</span>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* Loading state */}
          {generating && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="w-10 h-10 border-4 border-brass/20 border-t-brass rounded-full animate-spin" />
              <p className="text-parchment/60 text-sm">
                The Adeptus Mechanicus forges your warzone map...
              </p>
              <p className="text-parchment/30 text-xs">This may take up to 60 seconds.</p>
            </div>
          )}

          {/* Error state */}
          {!generating && error && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <p className="text-blood text-sm font-semibold">Generation failed</p>
              <p className="text-parchment/50 text-xs text-center max-w-sm">{error}</p>
            </div>
          )}

          {/* Image preview */}
          {!generating && previewUrl && (
            <div className="space-y-3">
              <img
                src={previewUrl}
                alt="Campaign map preview"
                className="w-full rounded border border-brass/20 object-cover"
                style={{ maxHeight: "420px" }}
              />
              <p className="text-xs text-parchment/35 text-center italic">
                Review your warzone. Regenerate until satisfied, then confirm to save.
              </p>
            </div>
          )}

        </div>

        {/* Footer buttons */}
        <div className="px-5 py-4 border-t border-brass/20 shrink-0">
          <div className="grid grid-cols-3 gap-3">

            {/* Cancel */}
            <button
              onClick={handleCancel}
              disabled={generating || confirming || cancelling}
              className="px-4 py-2.5 rounded border border-blood/30 bg-blood/5 hover:bg-blood/15 text-blood/80 hover:text-blood text-sm transition-colors disabled:opacity-40"
            >
              {cancelling ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-blood/30 border-t-blood rounded-full animate-spin" />
                  Cancelling...
                </span>
              ) : "Cancel"}
            </button>

            {/* Regenerate */}
            <button
              onClick={() => doGenerate(pendingMapId)}
              disabled={generating || confirming || cancelling}
              className="px-4 py-2.5 rounded border border-brass/40 bg-void hover:bg-brass/10 text-brass text-sm font-semibold transition-colors disabled:opacity-40"
            >
              {generating ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                  Generating...
                </span>
              ) : "Regenerate Map"}
            </button>

            {/* Confirm */}
            <button
              onClick={handleConfirm}
              disabled={!pendingMapId || generating || confirming || cancelling || !!error}
              className="px-4 py-2.5 rounded bg-brass/25 border border-brass/60 hover:bg-brass/40 text-brass font-bold text-sm uppercase tracking-wider transition-colors disabled:opacity-40"
            >
              {confirming ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-brass/30 border-t-brass rounded-full animate-spin" />
                  Saving...
                </span>
              ) : "Confirm Map"}
            </button>

          </div>
          <p className="mt-2 text-xs text-parchment/25 text-center italic">
            Cancel will discard the generated image and remove it from storage.
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
  const [lateUserId, setLateUserId]     = useState<string>("");
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
      .eq("id", cid)
      .single();

    if (cErr || !c) {
      alert(cErr?.message ?? "Campaign not found");
      setCampaign(null);
      setRound(null);
      return;
    }
    setCampaign(c as Campaign);

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
    if (!token) {
      alert("Session expired. Please refresh the page and try again.");
      return null;
    }
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
    if (error) {
      setStartStatus(`Error: ${error.message}`);
      return alert(`Start failed: ${error.message}`);
    }
    setStartStatus(`OK. Allocated: ${data?.allocated ?? 0}`);
    alert(`Start OK. Allocated: ${data?.allocated ?? 0}`);
    await load(campaignId);
  };

  const allocateLatePlayer = async () => {
    if (!lateUserId) return alert("Enter late player user_id");
    setStartStatus("Allocating late player...");
    const token = await getToken();
    if (!token) return;
    const { data, error } = await supabase.functions.invoke("start-campaign", {
      body: { campaign_id: campaignId, mode: "late", late_user_id: lateUserId },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) {
      setStartStatus(`Error: ${error.message}`);
      return alert(`Late allocation failed: ${error.message}`);
    }
    setStartStatus(`OK. Allocated: ${data?.allocated ?? 0}`);
    alert(`Late allocation OK. Allocated: ${data?.allocated ?? 0}`);
    await load(campaignId);
  };

  const deleteCampaign = async () => {
    if (!campaignId) return;
    const confirmed = window.confirm(
      `Delete campaign "${campaign?.name ?? campaignId}"?\n\n` +
      "This will permanently delete all campaign data including sectors, rounds, " +
      "player state, posts, and map artwork.\n\nThis cannot be undone."
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

  const allowed = role === "lead" || role === "admin";

  return (
    <Frame title="Lead Player Dashboard" right={<a className="underline" href={`/dashboard?campaign=${campaignId}`}>Back</a>}>
      <div className="space-y-6">

        {/* Campaign Status */}
        <Card title="Campaign">
          <div className="flex flex-col md:flex-row gap-3">
            <input
              className="flex-1 px-3 py-2 rounded bg-void border border-brass/30"
              placeholder="Campaign ID"
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

          {campaign && (
            <>
              <div className="mt-3 text-parchment/80 space-y-1">
                <div><span className="text-brass">Name:</span> {campaign.name}</div>
                <div>
                  <span className="text-brass">Phase:</span> {campaign.phase}
                  &nbsp;&bull;&nbsp;
                  <span className="text-brass">Round:</span> {campaign.round_number}
                </div>
                <div><span className="text-brass">Instability:</span> {campaign.instability}/10</div>
                <div><span className="text-brass">Stage:</span> {round?.stage ?? "unknown"}</div>
                <div><span className="text-brass">Role:</span> {role}</div>
                <div>
                  <span className="text-brass">Map:</span>{" "}
                  {campaign.map_id
                    ? <span className="text-brass/60 text-xs font-mono">{campaign.map_id}</span>
                    : <span className="text-parchment/40 text-xs italic">not yet generated</span>
                  }
                </div>
              </div>

              {/* Generate Map button -- shown to lead/admin */}
              {allowed && (
                <button
                  onClick={() => setMapModalOpen(true)}
                  className="mt-4 w-full px-4 py-2.5 rounded bg-brass/15 border border-brass/40 hover:bg-brass/25 text-brass text-sm font-semibold uppercase tracking-wider transition-colors"
                >
                  {campaign.map_id ? "Regenerate Map" : "Generate Map"}
                </button>
              )}
            </>
          )}

          {!allowed && campaign && (
            <p className="mt-3 text-blood/80">You are not authorised for leader controls in this campaign.</p>
          )}
        </Card>

        <div className="grid md:grid-cols-2 gap-6">

          <Card title="Start Campaign">
            <p className="text-parchment/70 text-sm">Allocates secret starting locations for all players without revealing assignments.</p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={startCampaign}
            >
              Start Campaign (Allocate Starting Locations)
            </button>
            {startStatus && <p className="mt-2 text-xs text-parchment/60">Status: {startStatus}</p>}
          </Card>

          <Card title="Late Player Allocation">
            <p className="text-parchment/70 text-sm">Reassigns 1 sector from the dominant player to the late joiner.</p>
            <input
              className="mt-3 w-full px-3 py-2 rounded bg-void border border-brass/30"
              value={lateUserId}
              onChange={(e) => setLateUserId(e.target.value)}
              placeholder="Late player user_id (uuid)"
              disabled={!allowed}
            />
            <button
              disabled={!allowed || !lateUserId}
              className="mt-3 w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40"
              onClick={allocateLatePlayer}
            >
              Allocate Late Player
            </button>
          </Card>

          <Card title="Advance Stage / Round">
            <p className="text-parchment/70 text-sm">Moves through the stage order: movement &rarr; recon &rarr; conflicts &rarr; missions &rarr; results &rarr; spend &rarr; publish &rarr; next round.</p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={() => callFn("advance-round")}
            >
              Advance
            </button>
          </Card>

          <Card title="Assign Missions">
            <p className="text-parchment/70 text-sm">Assigns missions to conflicts in the current round, respecting any NIP influence ("choose", "veto", etc.).</p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-blood/20 border border-blood/40 hover:bg-blood/30 disabled:opacity-40"
              onClick={() => callFn("assign-missions")}
            >
              Assign Missions
            </button>
          </Card>

          <Card title="Apply Instability">
            <p className="text-parchment/70 text-sm">Increments Halo Instability by 1 and rolls an event from the appropriate d10 table. Also posts a public bulletin.</p>
            <button
              disabled={!allowed}
              className="mt-3 w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={() => callFn("apply-instability")}
            >
              Apply Instability (Game Day)
            </button>
          </Card>

        </div>

        <Card title="What's next">
          <ul className="list-disc pl-5 space-y-2 text-parchment/75">
            <li>Add "Process Movement" + "Detect Conflicts" functions to fully remove admin work.</li>
            <li>Add "Resolve Recon" and "Apply Underdog Choices" functions.</li>
            <li>Add "Publish Bulletin" helper that writes a public post scaffold.</li>
          </ul>
        </Card>

        {/* Danger Zone -- only shown when campaign is loaded and user is lead/admin */}
        {campaign && allowed && (
          <Card title="Danger Zone">
            <p className="text-parchment/70 text-sm">
              Permanently deletes this campaign, all player data, sectors, rounds, posts, and map artwork.
              This action cannot be undone.
            </p>
            <button
              disabled={deleting}
              className="mt-3 w-full px-4 py-2 rounded bg-blood/30 border border-blood/60 hover:bg-blood/50 disabled:opacity-40 text-parchment font-semibold"
              onClick={deleteCampaign}
            >
              {deleting ? "Deleting..." : `Delete Campaign: ${campaign.name}`}
            </button>
          </Card>
        )}

      </div>

      {/* Generate Map Modal */}
      {campaign && (
        <GenerateMapModal
          open={mapModalOpen}
          campaignId={campaignId}
          campaign={campaign}
          onClose={() => setMapModalOpen(false)}
          onConfirmed={() => {
            setMapModalOpen(false);
            load(campaignId);
          }}
        />
      )}

    </Frame>
  );
}
