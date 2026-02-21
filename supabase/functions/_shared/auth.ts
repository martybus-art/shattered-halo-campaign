import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export function getSupabaseUrl(): string {
  const value = Deno.env.get("SUPABASE_URL") ?? "";
  if (!value) throw new Error("Missing SUPABASE_URL");
  return value;
}

export function getPublishableKey(): string {
  // supports both old and new naming
  const value =
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    Deno.env.get("SB_PUBLISHABLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") ||
    "";
  if (!value) throw new Error("Missing SUPABASE_PUBLISHABLE_KEY/SB_PUBLISHABLE_KEY/SUPABASE_ANON_KEY");
  return value;
}

export function getServiceRoleKey(): string {
  const value =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SERVICE_ROLE_KEY") ||
    "";
  if (!value) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SERVICE_ROLE_KEY");
  return value;
}

export function extractBearerToken(req: Request): string {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
  return authHeader.slice(7).trim();
}

export async function getAuthenticatedUser(req: Request) {
  const supabaseUrl = getSupabaseUrl();
  const publishableKey = getPublishableKey();
  const accessToken = extractBearerToken(req);

  if (!accessToken) {
    return { user: null, error: new Error("Missing bearer token") };
  }

  // ✅ ECC/ES256-safe approach for Edge Functions
  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await authClient.auth.getClaims(accessToken);
  if (error || !data?.claims?.sub) {
    return { user: null, error: error ?? new Error("Invalid token") };
  }

  const user = {
    id: data.claims.sub as string,
    email: (data.claims.email ?? null) as string | null,
  };

  return { user, error: null };
}