import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function getEnv() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const publishableKey = Deno.env.get("SB_PUBLISHABLE_KEY") || "";
    //Deno.env.get("SUPABASE_ANON_KEY") || "";

  const serviceRoleKey =
    Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "";

  if (!supabaseUrl) throw new Error("Missing SUPABASE_URL in function secrets");
  if (!publishableKey) throw new Error("Missing SB_PUBLISHABLE_KEY / SUPABASE_PUBLISHABLE_KEY in function secrets");

  return { supabaseUrl, publishableKey, serviceRoleKey };
}

/**
 * ES256-friendly auth check using getClaims (recommended by Supabase docs).
 * Returns { userId, email } or null.
 */
export async function requireUser(req: Request) {
  const { supabaseUrl, publishableKey } = getEnv();
  if (!publishableKey) return null;

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await authClient.auth.getClaims(token);
  if (error || !data?.claims?.sub) return null;

  return {
    user: {
      id: data.claims.sub as string,
      email: (data.claims.email ?? null) as string | null,
    },
    error: null,
  };
}

export function adminClient() {
  const { supabaseUrl, serviceRoleKey } = getEnv();
  if (!serviceRoleKey) throw new Error("Missing SERVICE_ROLE_KEY in function secrets");
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
