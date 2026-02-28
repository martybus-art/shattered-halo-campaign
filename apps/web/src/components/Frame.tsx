import React from "react";

type FrameProps = {
  title?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  /** Pass the active campaign ID to populate nav links */
  campaignId?: string;
  /** Pass the user's role to show/hide Lead Controls link */
  role?: string;
  /** Current page key — used to highlight the active nav item */
  currentPage?: "dashboard" | "map" | "conflicts" | "lead" | "campaigns";
};

const NAV_ITEMS = [
  { key: "campaigns", label: "Campaigns", href: (_cid: string) => "/campaigns" },
  { key: "dashboard", label: "Dashboard", href: (cid: string) => `/dashboard?campaign=${cid}` },
  { key: "map",       label: "Map",        href: (cid: string) => `/map?campaign=${cid}` },
  { key: "conflicts", label: "Conflicts",  href: (cid: string) => `/conflicts?campaign=${cid}` },
] as const;

export function Frame({ title, children, right, campaignId, role, currentPage }: FrameProps) {
  const isLead = role === "lead" || role === "admin";

  return (
    <div className="min-h-screen bg-void">
      {/* ── Top bar ── */}
      <header className="sticky top-0 z-10 bg-iron/80 backdrop-blur border-b border-brass/30">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <a href="/campaigns" className="text-brass font-gothic tracking-wider hover:text-brass/80 transition-colors">
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

        {/* ── Nav strip — only renders when we have a campaign context ── */}
        {campaignId && (
          <nav className="mx-auto max-w-6xl px-4 pb-2 flex items-center gap-1 flex-wrap">
            {NAV_ITEMS.map(({ key, label, href }) => {
              const target = key === "campaigns" ? href("") : href(campaignId);
              const active = currentPage === key;
              return (
                <a
                  key={key}
                  href={target}
                  className={[
                    "px-3 py-1 rounded text-sm font-mono transition-colors",
                    active
                      ? "bg-brass/30 text-brass border border-brass/50"
                      : "text-parchment/60 hover:text-parchment hover:bg-brass/10 border border-transparent",
                  ].join(" ")}
                >
                  {label}
                </a>
              );
            })}

            {/* Lead Controls — only for lead / admin */}
            {isLead && (
              <a
                href={`/lead?campaign=${campaignId}`}
                className={[
                  "px-3 py-1 rounded text-sm font-mono transition-colors",
                  currentPage === "lead"
                    ? "bg-blood/40 text-blood border border-blood/60"
                    : "text-blood/70 hover:text-blood hover:bg-blood/10 border border-transparent",
                ].join(" ")}
              >
                Lead Controls
              </a>
            )}
          </nav>
        )}

        {/* No-campaign fallback nav — just a link back to campaigns */}
        {!campaignId && (
          <nav className="mx-auto max-w-6xl px-4 pb-2 flex items-center gap-1">
            <a
              href="/campaigns"
              className={[
                "px-3 py-1 rounded text-sm font-mono transition-colors",
                currentPage === "campaigns"
                  ? "bg-brass/30 text-brass border border-brass/50"
                  : "text-parchment/60 hover:text-parchment hover:bg-brass/10 border border-transparent",
              ].join(" ")}
            >
              Campaigns
            </a>
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
