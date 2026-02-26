import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type EffectiveRules = {
  economy?: { enabled?: boolean; [k: string]: unknown };
  missions?: { enabled?: boolean; mode?: string; [k: string]: unknown };
  instability?: { enabled?: boolean; [k: string]: unknown };
  fog?: { enabled?: boolean; [k: string]: unknown };
  [k: string]: unknown;
};

const DEFAULT_RULES: EffectiveRules = {
  economy: { enabled: true },
  missions: { enabled: true, mode: "weighted_random_nip" },
  instability: { enabled: true },
  fog: { enabled: true },
};

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge<T extends Record<string, any>>(base: T, override: Record<string, any>): T {
  const out: any = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

export async function loadEffectiveRules(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  campaignId: string;
}) {
  const admin = createClient(args.supabaseUrl, args.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: campaign, error: cErr } = await admin
    .from("campaigns")
    .select("id, ruleset_id, rules_overrides")
    .eq("id", args.campaignId)
    .single();

  if (cErr) throw new Error(`Failed to load campaign: ${cErr.message}`);

  let rules: EffectiveRules = { ...DEFAULT_RULES };

  if (campaign?.ruleset_id) {
    const { data: rs, error: rsErr } = await admin
      .from("rulesets")
      .select("rules_json")
      .eq("id", campaign.ruleset_id)
      .single();
    if (rsErr) throw new Error(`Failed to load ruleset: ${rsErr.message}`);
    rules = deepMerge(rules, (rs?.rules_json ?? {}) as any);
  }

  rules = deepMerge(rules, (campaign?.rules_overrides ?? {}) as any);

  return { rules, campaign };
}