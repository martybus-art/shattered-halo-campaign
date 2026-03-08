// supabase/functions/generate-narrative/index.ts
//
// changelog:
//   2026-03-08 — FEATURE: After generating battle chronicle text, insert a
//                public post into the `posts` table tagged ["chronicle"] so the
//                narrative appears in the War Bulletin on the dashboard.
//                New optional body fields: conflict_id, campaign_id,
//                round_number, chronicle_title. Returns published: bool.
//                Uses adminClient to bypass posts RLS (lead/admin only).
//                Anthropic API (claude-sonnet-4-20250514) retained as-is.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, adminClient, requireUser } from "../_shared/utils.ts";

// Anthropic API key — set this in Supabase Edge Function secrets as ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    // Require authenticated user — prevents abuse of the API key
    const result = await requireUser(req);
    if (!result?.user) return json(401, { ok: false, error: "Unauthorized" });
    const user = result.user;

    if (!ANTHROPIC_API_KEY) {
      return json(500, { ok: false, error: "ANTHROPIC_API_KEY not configured in function secrets" });
    }

    const body = await req.json().catch(() => ({}));
    const prompt: string | undefined = body?.prompt;
    const max_tokens: number = typeof body?.max_tokens === "number" ? body.max_tokens : 1000;

    // Optional — if provided, the generated narrative is also posted to the
    // War Bulletin as a public chronicle post.
    const conflict_id: string | null     = body?.conflict_id ?? null;
    const campaign_id: string | null     = body?.campaign_id ?? null;
    const round_number: number | null    = typeof body?.round_number === "number" ? body.round_number : null;
    const chronicle_title: string | null = body?.chronicle_title ?? null;

    if (!prompt?.trim()) return json(400, { ok: false, error: "Missing prompt" });

    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return json(502, { ok: false, error: `Anthropic API returned ${response.status}` });
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text ?? "";

    // ── Publish to War Bulletin if campaign context was provided ─────────────
    // Uses adminClient to bypass the posts RLS (which only allows lead/admin
    // to insert public posts directly). The narrative is authored by the game
    // system, not by the player, so the admin client is appropriate here.
    let published = false;
    if (conflict_id && campaign_id && round_number !== null) {
      const admin = adminClient();
      const title = chronicle_title ?? `Battle Chronicle — Round ${round_number}`;

      const { error: postErr } = await admin.from("posts").insert({
        campaign_id,
        round_number,
        visibility: "public",
        title,
        body: text,
        tags: ["chronicle"],
        created_by: user.id,
      });

      if (postErr) {
        // Non-fatal: log the error but still return the generated text
        console.error("generate-narrative: failed to publish post:", postErr.message);
      } else {
        published = true;
        console.log(`generate-narrative: chronicle posted for conflict=${conflict_id} campaign=${campaign_id}`);
      }
    }

    return json(200, { ok: true, text, published });

  } catch (e: any) {
    console.error("generate-narrative error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
