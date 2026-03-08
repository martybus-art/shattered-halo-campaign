"use client";
// src/components/Frame.tsx
// App shell: top bar + campaign nav strip.
//
// changelog:
//   2026-03-08 — SECURITY: campaign nav links converted from <a href="?campaign=UUID">
//                to JS navigation (button onClick). setCampaignSession ensures the ID
//                is in sessionStorage before navigating so the URL stays clean.
//                Added "use client" directive (required for onClick + sessionStorage).

import React from "react";
import { setCampaignSession } from "@/lib/campaignSession";

type FrameProps = {
  title?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  /** Pass the active campaign ID to populate campaign-specific nav links */
  campaignId?: string;
  /** Pass the user's role to show/hide Lead Controls link */
  role?: string;
  /** Current page key — used to highlight the active nav item */
  currentPage?: "home" | "dashboard" | "map" | "conflicts" | "lead" | "campaigns";
  /** Hide the + New Campaign link (e.g. on the unauthenticated landing view) */
  hideNewCampaign?: boolean;
};

// Campaign-specific nav items — paths only, no ?campaign= param
const CAMPAIGN_NAV = [
  { key: "dashboard", label: "Dashboard", path: "/dashboard" },
  { key: "map",       label: "Map",        path: "/map"       },
  { key: "conflicts", label: "Conflicts",  path: "/conflicts" },
] as const;

/** Navigate to a campaign page without exposing the campaign ID in the URL. */
function navTo(path: string, campaignId: string) {
  setCampaignSession(campaignId);
  window.location.href = path;
}

export function Frame({ title, children, right, campaignId, role, currentPage, hideNewCampaign }: FrameProps) {
  const isLead = role === "lead" || role === "admin";

  const activeClass    = "bg-brass/30 text-brass border border-brass/50";
  const inactiveClass  = "text-parchment/60 hover:text-parchment hover:bg-brass/10 border border-transparent";
  const baseNavClass   = "px-3 py-1 rounded text-sm font-mono transition-colors cursor-pointer";

  return (
    <div className="min-h-screen bg-void">
      {/* ── Top bar ── */}
      <header className="sticky top-0 z-10 bg-iron/80 backdrop-blur border-b border-brass/30">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <a href="/" className="text-brass font-gothic tracking-wider hover:text-brass/80 transition-colors">
              SHATTERED HALO
            </a>
            {title && (
              <span className="text-parchment/90 font-mono text-sm">{title}</span>
            )}
          </div>
          {right && (
            <div className="text-parchment/70 text-sm">{right}</div>
          )}
        </div>

        {/* ── Nav strip ── */}
        <nav className="mx-auto max-w-6xl px-4 pb-2 flex items-center gap-1 flex-wrap">

          {/* Profile — always visible, plain anchor (no campaign context needed) */}
          <a
            href="/"
            className={`${baseNavClass} ${currentPage === "home" ? activeClass : inactiveClass}`}
          >
            Profile
          </a>

          {/* Campaign-specific links — only when we have a campaign context */}
          {campaignId && CAMPAIGN_NAV.map(({ key, label, path }) => {
            const active = currentPage === key;
            return (
              <button
                key={key}
                onClick={() => navTo(path, campaignId)}
                className={`${baseNavClass} ${active ? activeClass : inactiveClass}`}
              >
                {label}
              </button>
            );
          })}

          {/* Lead Controls — only for lead / admin with a campaign */}
          {campaignId && isLead && (
            <button
              onClick={() => navTo("/lead", campaignId)}
              className={[
                baseNavClass,
                currentPage === "lead"
                  ? "bg-blood/40 text-blood border border-blood/60"
                  : "text-blood/70 hover:text-blood hover:bg-blood/10 border border-transparent",
              ].join(" ")}
            >
              Lead Controls
            </button>
          )}

          {/* + New Campaign — hidden when not authenticated */}
          {!hideNewCampaign && (
            <a
              href="/campaigns"
              className={`${baseNavClass} ml-auto ${currentPage === "campaigns" ? activeClass : inactiveClass}`}
            >
              + New Campaign
            </a>
          )}

        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
