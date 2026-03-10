"use client";

import React, { useMemo } from "react";

type TacticalCellState =
  | "mine_unit"
  | "mine_empty"
  | "enemy"
  | "fog"
  | "unknown"
  | "reachable"
  | "selected";

export type RingSectorOverlay = {
  id: string;
  zone: number;
  index: number;
  state: TacticalCellState;
  fort?: boolean;
  label?: string;
};

type Props = {
  mapUrl: string;
  zones: number;
  sectors: RingSectorOverlay[];
  onSectorClick?: (sectorId: string) => void;
};

const ZONE_COLOURS = [
  "#7dd3fc",
  "#86efac",
  "#f9a8d4",
  "#fcd34d",
  "#c4b5fd",
  "#fb923c",
  "#67e8f9",
  "#a3e635",
  "#fca5a5",
  "#93c5fd",
  "#f5d0fe",
  "#fde68a",
];

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number
) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function wedgePath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number
) {
  const p1 = polarToCartesian(cx, cy, outerR, startAngle);
  const p2 = polarToCartesian(cx, cy, outerR, endAngle);
  const p3 = polarToCartesian(cx, cy, innerR, endAngle);
  const p4 = polarToCartesian(cx, cy, innerR, startAngle);

  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${p1.x} ${p1.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
    "Z",
  ].join(" ");
}

function sectorCenter(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number
) {
  const midAngle = (startAngle + endAngle) / 2;
  const midRadius = (innerR + outerR) / 2;
  return polarToCartesian(cx, cy, midRadius, midAngle);
}

function stateFill(state: TacticalCellState) {
  switch (state) {
    case "mine_unit":
      return "rgba(234, 179, 8, 0.45)";
    case "mine_empty":
      return "rgba(202, 138, 4, 0.22)";
    case "enemy":
      return "rgba(127, 29, 29, 0.38)";
    case "fog":
      return "rgba(15, 23, 42, 0.58)";
    case "unknown":
      return "rgba(51, 65, 85, 0.35)";
    case "reachable":
      return "rgba(34, 197, 94, 0.22)";
    case "selected":
      return "rgba(250, 204, 21, 0.35)";
    default:
      return "rgba(51, 65, 85, 0.35)";
  }
}

function stateStroke(state: TacticalCellState, zone: number) {
  if (state === "selected") return "rgba(250, 204, 21, 0.95)";
  if (state === "reachable") return "rgba(134, 239, 172, 0.95)";
  return ZONE_COLOURS[zone % ZONE_COLOURS.length];
}

export default function CampaignRingMergedMap({
  mapUrl,
  zones,
  sectors,
  onSectorClick,
}: Props) {
  const geometry = useMemo(() => {
    const cx = 500;
    const cy = 500;
    const innerRing = 250;
    const outerRing = 430;
    const ringMid = (innerRing + outerRing) / 2;
    const zoneSweep = 360 / Math.max(zones, 1);

    return sectors.map((sector) => {
      const zoneStart = sector.zone * zoneSweep;
      const halfSweep = zoneSweep / 2;

      const isInnerBand = sector.index < 2;
      const localHalf = sector.index % 2;

      const startAngle = zoneStart + localHalf * halfSweep;
      const endAngle = startAngle + halfSweep;

      const innerR = isInnerBand ? innerRing : ringMid;
      const outerR = isInnerBand ? ringMid : outerRing;

      return {
        ...sector,
        path: wedgePath(cx, cy, innerR, outerR, startAngle, endAngle),
        center: sectorCenter(cx, cy, innerR, outerR, startAngle, endAngle),
      };
    });
  }, [sectors, zones]);

  return (
    <div className="relative w-full aspect-square overflow-hidden rounded-xl border border-zinc-800 bg-black">
      <img
        src={mapUrl}
        alt="Campaign theatre map"
        className="absolute inset-0 h-full w-full object-cover"
      />

      <div className="absolute inset-0 bg-black/10" />

      <svg
        viewBox="0 0 1000 1000"
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label="Campaign tactical overlay"
      >
        {geometry.map((sector) => (
          <g key={sector.id}>
            <path
              d={sector.path}
              fill={stateFill(sector.state)}
              stroke={stateStroke(sector.state, sector.zone)}
              strokeWidth={sector.state === "selected" ? 4 : 2}
              className="transition-all duration-150"
              onClick={() => onSectorClick?.(sector.id)}
              style={{ cursor: onSectorClick ? "pointer" : "default" }}
            />

            {sector.fort ? (
              <circle
                cx={sector.center.x}
                cy={sector.center.y}
                r={10}
                fill="rgba(245, 158, 11, 0.9)"
                stroke="rgba(255,255,255,0.7)"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            ) : null}

            {sector.state === "mine_unit" ? (
              <circle
                cx={sector.center.x}
                cy={sector.center.y}
                r={6}
                fill="rgba(250, 204, 21, 0.95)"
                pointerEvents="none"
              />
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  );
}