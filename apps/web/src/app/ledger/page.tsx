"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

type Entry = { round_number: number; entry_type: string; currency: string; amount: number; reason: string; created_at: string; };

function getQueryCampaign(): string | null {
  if (typeof window === "undefined") return null;
  const u = new URL(window.location.href);
  return u.searchParams.get("campaign");
}

export default function LedgerPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [campaignId, setCampaignId] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    const q = getQueryCampaign();
    if (q) setCampaignId(q);
  }, []);

  const load = async () => {
    const { data, error } = await supabase
      .from("ledger")
      .select("round_number,entry_type,currency,amount,reason,created_at")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return alert(error.message);
    setEntries(data ?? []);
  };

  useEffect(() => { if (campaignId) load(); }, [campaignId]);

  return (
    <Frame title="Ledger" right={<a className="underline" href={`/dashboard?campaign=${campaignId}`}>Dashboard</a>}>
      <div className="space-y-6">
        <Card title="Load Ledger">
          <div className="flex gap-3">
            <input className="flex-1 px-3 py-2 rounded bg-void border border-brass/30" placeholder="Campaign ID"
              value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            <button className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" onClick={load}>Load</button>
          </div>
        </Card>

        <Card title="Recent Entries">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-brass">
                <tr>
                  <th className="text-left py-2">Round</th>
                  <th className="text-left py-2">Type</th>
                  <th className="text-left py-2">Cur</th>
                  <th className="text-right py-2">Amt</th>
                  <th className="text-left py-2">Reason</th>
                  <th className="text-left py-2">Time</th>
                </tr>
              </thead>
              <tbody className="text-parchment/85">
                {entries.map((e, i) => (
                  <tr key={i} className="border-t border-brass/15">
                    <td className="py-2">{e.round_number}</td>
                    <td className="py-2">{e.entry_type}</td>
                    <td className="py-2">{e.currency}</td>
                    <td className="py-2 text-right">{e.amount}</td>
                    <td className="py-2">{e.reason}</td>
                    <td className="py-2 text-parchment/60">{new Date(e.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Frame>
  );
}
