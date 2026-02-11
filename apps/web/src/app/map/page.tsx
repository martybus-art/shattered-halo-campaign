"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

type Sector = {
  zone_key: string;
  sector_key: string;
  owner_user_id: string | null;
  revealed_public: boolean;
  fortified: boolean;
};

const ZONES: { key: string; name: string }[] = [
  { key: "vault_ruins", name: "Vault Ruins" },
  { key: "ash_wastes", name: "Ash Wastes" },
  { key: "halo_spire", name: "Halo Spire" },
  { key: "sunken_manufactorum", name: "Sunken Manufactorum" },
  { key: "warp_scar_basin", name: "Warp Scar Basin" },
  { key: "obsidian_fields", name: "Obsidian Fields" },
  { key: "signal_crater", name: "Signal Crater" },
  { key: "xenos_forest", name: "Xenos Forest" }
];

const SECTORS = ["A1", "A2", "B1", "B2"];

export default function MapPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [campaignId, setCampaignId] = useState("");
  const [rows, setRows] = useState<Sector[]>([]);

  const load = async () => {
    const { data, error } = await supabase.from("sectors").select("zone_key,sector_key,owner_user_id,revealed_public,fortified").eq("campaign_id", campaignId);
    if (error) return alert(error.message);
    setRows(data ?? []);
  };

  useEffect(() => { if (campaignId) load(); }, [campaignId]);

  const sectorAt = (zone: string, key: string) => rows.find(r => r.zone_key === zone && r.sector_key === key);

  return (
    <Frame title="Tactical Hololith" right={<a className="underline" href="/dashboard">Dashboard</a>}>
      <div className="space-y-6">
        <Card title="Campaign Map">
          <div className="flex gap-3">
            <input className="flex-1 px-3 py-2 rounded bg-void border border-brass/30" placeholder="Campaign ID"
              value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            <button className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" onClick={load}>Load</button>
          </div>
        </Card>

        <div className="grid md:grid-cols-2 gap-6">
          {ZONES.map(z => (
            <Card key={z.key} title={z.name}>
              <div className="grid grid-cols-2 gap-2">
                {SECTORS.map(sk => {
                  const s = sectorAt(z.key, sk);
                  const known = !!s?.revealed_public;
                  return (
                    <div key={sk} className="rounded border border-brass/25 bg-void px-3 py-2">
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-xs text-brass">{sk}</div>
                        {s?.fortified && <div className="text-xs text-blood">FORT</div>}
                      </div>
                      <div className="mt-1 text-sm">
                        {known ? (s?.owner_user_id ? "Occupied" : "Unclaimed") : <span className="text-parchment/50">Unknown</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-parchment/60">Fog-of-war: only revealed sectors show occupation publicly.</p>
            </Card>
          ))}
        </div>
      </div>
    </Frame>
  );
}
