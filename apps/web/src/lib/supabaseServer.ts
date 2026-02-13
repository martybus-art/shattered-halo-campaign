import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

export function supabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  // Cookie session handling can be expanded with @supabase/ssr; keeping dependency-light for starter.
  // For production, consider @supabase/ssr for robust auth on server components.
  const cookieStore = cookies();
  const access_token = cookieStore.get("sb-access-token")?.value;

  return createClient(url, anon, {
    global: access_token ? { headers: { Authorization: `Bearer ${access_token}` } } : {}
  });
}

export function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, key);
}
