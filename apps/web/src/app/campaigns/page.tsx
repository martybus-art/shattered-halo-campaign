"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

type Template = {
  id: string;
  name: string;
  description: string | null;
};

type Ruleset = {
  id: string;
  name: string;
  description: string | null;
  key: string;
};

type MapRow = {
  id: string;
  name: string;
  description: string | null;
  version: number;
};

export default function CampaignsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [campaignName, setCampaignName] = useState<string>("");
  const [emails, setEmails] = useState<string>("");

  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [maps, setMaps] = useState<MapRow[]>([]);
  const [selectedRuleset, setSelectedRuleset] = useState<string>("");
  const [selectedMap, setSelectedMap] = useState<string>("");

  const [inviteMessage, setInviteMessage]   = useState<string>("");
  const [generatingMsg, setGeneratingMsg]   = useState(false);

  const [rulesOverrides, setRulesOverrides] = useState({
    economy: { enabled: true, catchup: { enabled: true, bonus: 1 } },
    fog: { enabled: true },
    instability: { enabled: true },
    missions: { enabled: true, mode: "weighted_random_nip" },
    narrative: { cp_exchange: { enabled: true } },
  });

  const load = async () => {
    setLoading(true);
    try {
      const { data: tpls, error: te } = await supabase
        .from("templates")
        .select("id,name,description")
        .order("created_at", { ascending: false });
      if (te) throw te;
      const tplRows = (tpls ?? []) as Template[];
      setTemplates(tplRows);
      if (!selectedTemplate && tplRows.length) setSelectedTemplate(tplRows[0].id);

      const { data: rs } = await supabase
        .from("rulesets")
        .select("id,key,name,description")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      setRulesets((rs ?? []) as Ruleset[]);
      if (!selectedRuleset && rs?.length) setSelectedRuleset(rs[0].id);

      const { data: mp } = await supabase
        .from("maps")
        .select("id,name,description,version")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      setMaps((mp ?? []) as MapRow[]);
      if (!selectedMap && mp?.length) setSelectedMap(mp[0].id);
    } catch (e: any) {
      console.error(e);
      alert(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const generateInviteMessage = async () => {
    if (!campaignName.trim()) return alert("Enter a campaign name first.");
    setGeneratingMsg(true);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `You are a Warhammer 40,000 narrative writer. Write a short, atmospheric invite message (3-4 sentences) for a new campaign called "${campaignName.trim()}". The message should be written in grimdark 40K style — ominous, military, cosmic horror tone. It will be shown to players invited to join this campaign. Include a sense of urgency and honour in the call to arms. Do not use markdown or headers, just plain prose.`
          }]
        })
      });
      const data = await response.json();
      const text = data?.content?.[0]?.text ?? "";
      if (text) setInviteMessage(text);
      else alert("Failed to generate message. Try again.");
    } catch (e: any) {
      alert("Generation failed: " + (e?.message ?? "Unknown error"));
    } finally {
      setGeneratingMsg(false);
    }
  };

  const createCampaign = async () => {
    if (!selectedTemplate) return alert("Select a template.");
    if (!campaignName.trim()) return alert("Enter a campaign name.");

    setCreating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        alert("Session not ready. Refresh and try again.");
        return;
      }

      const inviteEmails = emails.split(",").map((e) => e.trim()).filter(Boolean);

      const { data, error } = await supabase.functions.invoke("create-campaign", {
        body: {
          template_id: selectedTemplate,
          campaign_name: campaignName.trim(),
          player_emails: inviteEmails,
          ruleset_id: selectedRuleset || null,
          rules_overrides: rulesOverrides,
          map_id: selectedMap || null,
          invite_message: inviteMessage.trim() || null,
        },
      });

      if (error) {
        try {
          const text = await error.context.text();
          console.error("function response text:", text);
        } catch (e) {
          console.error("no error context body available", e);
        }
        throw error;
      }

      if (!data?.ok) {
        alert(`Create failed: ${data?.error ?? "Unknown error"}`);
        return;
      }

      // Redirect to profile/home so they can select the new campaign
      alert("Campaign created! You are the Lead player.");
      window.location.href = "/";
    } catch (e: any) {
      console.error(e);
      alert(`Create failed: ${e?.message ?? String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Frame title="New Campaign" currentPage="campaigns">
      <div className="space-y-6">
        <Card title="Create Campaign">
          <div className="space-y-4">

            {/* Template */}
            <div>
              <div className="text-sm text-parchment/70 mb-1">Template</div>
              <select
                className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                disabled={loading || creating}
              >
                {!templates.length && <option value="">No templates found</option>}
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {templates.length ? (
                <p className="mt-1 text-xs text-parchment/60">
                  {templates.find((t) => t.id === selectedTemplate)?.description ?? ""}
                </p>
              ) : (
                <p className="mt-1 text-xs text-parchment/60">
                  You need at least one template row in <span className="text-brass">templates</span>.
                </p>
              )}
            </div>

            {/* Campaign name */}
            <div>
              <div className="text-sm text-parchment/70 mb-1">Campaign name</div>
              <input
                className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="e.g. Embers of the Shattered Halo (Season 1)"
                disabled={loading || creating}
              />
            </div>

            {/* Optional ruleset */}
            {rulesets.length > 0 && (
              <div>
                <div className="text-sm text-parchment/70 mb-1">
                  Ruleset <span className="text-parchment/40">(optional)</span>
                </div>
                <select
                  className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                  value={selectedRuleset}
                  onChange={(e) => setSelectedRuleset(e.target.value)}
                  disabled={loading || creating}
                >
                  <option value="">— None —</option>
                  {rulesets.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Optional map */}
            {maps.length > 0 && (
              <div>
                <div className="text-sm text-parchment/70 mb-1">
                  Map <span className="text-parchment/40">(optional)</span>
                </div>
                <select
                  className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                  value={selectedMap}
                  onChange={(e) => setSelectedMap(e.target.value)}
                  disabled={loading || creating}
                >
                  <option value="">— None —</option>
                  {maps.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} (v{m.version})</option>
                  ))}
                </select>
              </div>
            )}

            {/* Rules overrides */}
            <div className="rounded-2xl border border-brass/30 bg-iron/70 p-4">
              <div className="text-sm font-semibold uppercase tracking-[0.18em] text-brass/90">
                Rules Options
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="flex items-center gap-3">
                  <input type="checkbox"
                    checked={!!rulesOverrides.economy?.enabled}
                    onChange={(e) =>
                      setRulesOverrides((r) => ({ ...r, economy: { ...r.economy, enabled: e.target.checked } }))
                    }
                  />
                  <span>Economy (NIP/NCP)</span>
                </label>

                <label className="flex items-center gap-3">
                  <input type="checkbox"
                    checked={!!rulesOverrides.fog?.enabled}
                    onChange={(e) =>
                      setRulesOverrides((r) => ({ ...r, fog: { enabled: e.target.checked } }))
                    }
                  />
                  <span>Fog of War</span>
                </label>

                <label className="flex items-center gap-3">
                  <input type="checkbox"
                    checked={!!rulesOverrides.instability?.enabled}
                    onChange={(e) =>
                      setRulesOverrides((r) => ({ ...r, instability: { enabled: e.target.checked } }))
                    }
                  />
                  <span>Instability Events</span>
                </label>

                <div className="flex flex-col gap-2">
                  <span className="text-xs text-parchment/70">Mission Selection</span>
                  <select
                    value={rulesOverrides.missions?.mode ?? "weighted_random_nip"}
                    onChange={(e) =>
                      setRulesOverrides((r) => ({ ...r, missions: { ...r.missions, mode: e.target.value } }))
                    }
                    className="rounded-lg border border-brass/30 bg-black/30 px-3 py-2"
                  >
                    <option value="random">Random</option>
                    <option value="player_choice">Player Choice</option>
                    <option value="player_choice_nip">Player Choice + NIP Influence</option>
                    <option value="weighted_random_nip">Weighted Random + NIP Influence</option>
                  </select>
                </div>
              </div>
            </div>


            {/* AI Narrative invite message */}
            <div>
              <div className="text-sm text-parchment/70 mb-1">
                Invite message <span className="text-parchment/40">(shown to invited players)</span>
              </div>
              <textarea
                className="w-full px-3 py-2 rounded bg-void border border-brass/30 text-sm resize-none"
                rows={4}
                value={inviteMessage}
                onChange={(e) => setInviteMessage(e.target.value)}
                placeholder="A grimdark call to arms for your players..."
                disabled={loading || creating}
              />
              <button
                type="button"
                className="mt-1 px-3 py-1.5 rounded bg-iron/40 border border-parchment/20 hover:bg-iron/60 text-xs text-parchment/60 disabled:opacity-40"
                onClick={generateInviteMessage}
                disabled={generatingMsg || loading || creating || !campaignName.trim()}
              >
                {generatingMsg ? "Generating…" : "✦ Generate with AI"}
              </button>
              <p className="mt-1 text-xs text-parchment/40">
                AI generates a 40K narrative blurb based on your campaign name. You can edit it before creating.
              </p>
            </div>

            {/* Invite emails */}
            <div>
              <div className="text-sm text-parchment/70 mb-1">
                Invite players <span className="text-parchment/40">(comma-separated emails, optional)</span>
              </div>
              <input
                className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="friend1@example.com, friend2@example.com"
                disabled={loading || creating}
              />
              <p className="mt-1 text-xs text-parchment/60">
                Players auto-join when they sign in.
              </p>
            </div>

            <button
              className="w-full px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30 disabled:opacity-40"
              onClick={createCampaign}
              disabled={creating || loading || !templates.length}
            >
              {creating ? "Creating…" : "Create Campaign (you become Lead)"}
            </button>

          </div>
        </Card>
      </div>
    </Frame>
  );
}
