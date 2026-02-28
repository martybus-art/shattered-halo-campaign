import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, requireUser } from "../_shared/utils.ts";

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

    if (!ANTHROPIC_API_KEY) {
      return json(500, { ok: false, error: "ANTHROPIC_API_KEY not configured in function secrets" });
    }

    const body = await req.json().catch(() => ({}));
    const prompt: string | undefined = body?.prompt;
    const max_tokens: number = typeof body?.max_tokens === "number" ? body.max_tokens : 1000;

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

    return json(200, { ok: true, text });

  } catch (e: any) {
    console.error("generate-narrative error:", e?.message);
    return json(500, { ok: false, error: e?.message ?? "Internal error" });
  }
});
