import React from "react";

export function Card(props: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <section className="bg-iron rounded-xl shadow-reliquary border border-brass/30">
      <div className="px-4 py-3 border-b border-brass/20 flex items-center justify-between">
        <h2 className="font-gothic tracking-wide text-parchment">{props.title}</h2>
      </div>
      <div className="p-4 text-parchment/90">{props.children}</div>
      {props.footer && <div className="px-4 py-3 border-t border-brass/20 text-parchment/70">{props.footer}</div>}
    </section>
  );
}
