import React from "react";

export function Frame(props: { title?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-void">
      <header className="sticky top-0 z-10 bg-iron/80 backdrop-blur border-b border-brass/30">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <span className="text-brass font-gothic tracking-wider">SHATTERED HALO</span>
            {props.title && <span className="text-parchment/90 font-mono text-sm">{props.title}</span>}
          </div>
          <div className="text-parchment/70 text-sm">{props.right}</div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{props.children}</main>
    </div>
  );
}
