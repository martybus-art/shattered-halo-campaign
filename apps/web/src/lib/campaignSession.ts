// src/lib/campaignSession.ts
// Stores the active campaign ID in sessionStorage so it is never exposed in the
// browser URL bar after the initial navigation.
//
// sessionStorage is per-tab — if the user opens a link in a new tab without a
// ?campaign= param, getCampaignSession() returns "" and the page shows a
// "no campaign selected" fallback with a link back to home.
//
// changelog:
//   2026-03-08 — initial implementation. Replaces ?campaign=<UUID> URL pattern
//                across all campaign pages (dashboard, map, lead, conflicts).

const SESSION_KEY = "shc_campaign_id";

/** Save the campaign ID to sessionStorage for this tab. */
export function setCampaignSession(id: string): void {
  if (typeof window !== "undefined") {
    sessionStorage.setItem(SESSION_KEY, id);
  }
}

/** Read the campaign ID from sessionStorage. Returns "" if not set. */
export function getCampaignSession(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(SESSION_KEY) ?? "";
}

/**
 * Call once on page mount (inside a useState initialiser or useEffect).
 *
 * Priority:
 *   1. ?campaign= URL param  →  save to sessionStorage, wipe from URL bar, return it.
 *   2. sessionStorage value  →  return it (normal in-app navigation).
 *   3. Nothing found         →  return "" (caller should show a fallback).
 */
export function bootstrapCampaignId(): string {
  if (typeof window === "undefined") return "";

  const params = new URL(window.location.href).searchParams;
  const urlId  = params.get("campaign");

  if (urlId) {
    // Persist for this tab
    sessionStorage.setItem(SESSION_KEY, urlId);

    // Wipe the UUID from the visible URL bar immediately
    const clean = new URL(window.location.href);
    clean.searchParams.delete("campaign");
    history.replaceState({}, "", clean.toString());

    return urlId;
  }

  return sessionStorage.getItem(SESSION_KEY) ?? "";
}
