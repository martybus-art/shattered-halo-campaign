import React from "react";

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
};

// Campaign-specific nav items (only shown when campaignId is present)
const CAMPAIGN_NAV = [
  { key: "dashboard", label: "Dashboard", href: (cid: string) => `/dashboard?campaign=${cid}` },
  { key: "map",       label: "Map",        href: (cid: string) => `/map?campaign=${cid}` },
  { key: "conflicts", label: "Conflicts",  href: (cid: string) => `/conflicts?campaign=${cid}` },
] as const;

export function Frame({ title, children, right, campaignId, role, currentPage }: FrameProps) {
  const isLead = role === "lead" || role === "admin";

  return (
    <div className="min-h-screen">
      {/* ── Top bar ── */}
      <header className="sticky top-0 z-10 bg-iron/70 backdrop-blur border-b border-steel/10">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <a href="/" className="text-steel font-gothic tracking-wider hover:text-steel/80 transition-colors">
              SHATTERED HALO
            </a>
            {title && (
              <span className="text-parchment/70 font-mono text-sm">{title}</span>
            )}
          </div>
          {right && (
            <div className="text-parchment/60 text-sm">{right}</div>
          )}
        </div>

        {/* ── Nav strip — always rendered ── */}
        <nav className="mx-auto max-w-6xl px-4 pb-2 flex items-center gap-1 flex-wrap">

          {/* Profile — always visible */}
          <a
            href="/"
            className={[
              "px-3 py-1 rounded text-sm font-mono transition-colors",
              currentPage === "home"
                ? "bg-steel/10 text-steel border border-steel/20"
                : "text-parchment/60 hover:text-parchment hover:bg-steel/5 border border-transparent",
            ].join(" ")}
          >
            Profile
          </a>

          {/* Campaign-specific links — only when we have a campaign context */}
          {campaignId && CAMPAIGN_NAV.map(({ key, label, href }) => {
            const active = currentPage === key;
            return (
              <a
                key={key}
                href={href(campaignId)}
                className={[
                  "px-3 py-1 rounded text-sm font-mono transition-colors",
                  active
                    ? "bg-steel/10 text-steel border border-steel/20"
                    : "text-parchment/60 hover:text-parchment hover:bg-steel/5 border border-transparent",
                ].join(" ")}
              >
                {label}
              </a>
            );
          })}

          {/* Lead Controls — only for lead / admin with a campaign */}
          {campaignId && isLead && (
            <a
              href={`/lead?campaign=${campaignId}`}
              className={[
                "px-3 py-1 rounded text-sm font-mono transition-colors",
                currentPage === "lead"
                  ? "bg-blood/10 text-blood border border-blood/30"
                  : "text-blood/80 hover:text-blood hover:bg-blood/5 border border-transparent",
              ].join(" ")}
            >
              Lead Controls
            </a>
          )}

          {/* + New Campaign — always visible, right-aligned feel via margin */}
          <a
            href="/campaigns"
            className={[
              "px-3 py-1 rounded text-sm font-mono transition-colors ml-auto",
              currentPage === "campaigns"
                ? "bg-steel/10 text-steel border border-steel/20"
                : "text-parchment/60 hover:text-parchment hover:bg-steel/5 border border-transparent",
            ].join(" ")}
          >
            + New Campaign
          </a>

        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}