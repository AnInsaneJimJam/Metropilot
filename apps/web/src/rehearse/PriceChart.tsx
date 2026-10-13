import { useEffect, useRef, useState } from "react";
import type { Rehearsal } from "./simulate.ts";
export function elapsedLabel(seconds: number): string {
  return seconds >= 86400
    ? `${(seconds / 86400).toFixed(1)}d`
    : seconds >= 3600
      ? `${(seconds / 3600).toFixed(1)}h`
      : `${Math.round(seconds)}s`;
}
const HEIGHT = 300;
const TOP = 44;
const BOTTOM = 250;
const LEFT = 64;
const RIGHT_PAD = 24;
export function PriceChart({
  rehearsal,
  block,
  threshold,
}: {
  rehearsal: Rehearsal;
  block: number;
  threshold: number | undefined;
}) {
  // The viewBox follows the rendered width so axis text stays at its CSS size on every screen.
  const frame = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(920);
  const [hover, setHover] = useState<number>();
  const ticks = rehearsal.ticks.filter((t) => t.twap !== undefined);
  const points = ticks.filter(
    (_, i) => i % Math.max(1, Math.floor(ticks.length / 350)) === 0,
  );
  const plotted = points.length > 0;
  useEffect(() => {
    const svg = frame.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(320, Math.round(entry.contentRect.width)));
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [plotted]);
  if (!points.length)
    return (
      <p className="empty-state">No price observations in this scenario.</p>
    );
  const right = width - RIGHT_PAD;
  const prices = points.map((t) => Number(t.twap));
  const low = Math.min(...prices, threshold ?? Infinity),
    high = Math.max(...prices, threshold ?? -Infinity);
  const padding = Math.max((high - low) * 0.15, Math.abs(high) * 1e-5, 0.5);
  const min = low - padding,
    max = high + padding;
  const last = Math.max(1, rehearsal.ticks.at(-1)?.block ?? 1);
  const x = (b: number) => LEFT + (b / last) * (right - LEFT);
  const y = (p: number) => BOTTOM - ((p - min) / (max - min)) * (BOTTOM - TOP);
  const path = points
    .map((t, i) => `${i ? "L" : "M"}${x(t.block)} ${y(Number(t.twap))}`)
    .join(" ");
  const fired = rehearsal.events.filter(
    (e) => e.kind === "fire" && e.block <= block,
  );
  const hovered =
    hover === undefined
      ? undefined
      : points.reduce((best, t) =>
          Math.abs(t.block - hover) < Math.abs(best.block - hover) ? t : best,
        );
  const tipX = hovered ? Math.min(x(hovered.block) + 12, right - 132) : 0;
  return (
    <svg
      ref={frame}
      className="price-chart"
      viewBox={`0 0 ${width} ${HEIGHT}`}
      role="img"
      aria-label="Synthetic TWAP over time, with trigger events marked"
      onPointerMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - box.left) / box.width) * width;
        setHover(
          px < LEFT || px > right
            ? undefined
            : ((px - LEFT) / (right - LEFT)) * last,
        );
      }}
      onPointerLeave={() => setHover(undefined)}
    >
      <defs>
        <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="fill-stop" stopOpacity=".14" />
          <stop offset="100%" className="fill-stop" stopOpacity="0" />
        </linearGradient>
        <clipPath id="played">
          <rect x="0" y="0" width={x(block)} height={HEIGHT} />
        </clipPath>
      </defs>
      {[0, 1, 2, 3, 4].map((i) => {
        const p = min + ((max - min) * i) / 4;
        return (
          <g key={i}>
            <line className="grid" x1={LEFT} x2={right} y1={y(p)} y2={y(p)} />
            <text className="axis" x={LEFT - 12} y={y(p) + 4} textAnchor="end">
              {p.toFixed(1)}
            </text>
          </g>
        );
      })}
      {[0, 1, 2, 3, 4].map((i) => (
        <text
          key={i}
          className="axis"
          x={LEFT + ((right - LEFT) * i) / 4}
          y={BOTTOM + 28}
          textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
        >
          {elapsedLabel((((last * i) / 4) * rehearsal.blockMillis) / 1000)}
        </text>
      ))}
      {threshold !== undefined && (
        <g className="threshold">
          <line
            x1={LEFT}
            x2={right}
            y1={y(threshold)}
            y2={y(threshold)}
            strokeDasharray="4 4"
          />
          <text x={right} y={y(threshold) - 8} textAnchor="end">
            Threshold {threshold}
          </text>
        </g>
      )}
      <path className="price-ghost" d={path} />
      <g clipPath="url(#played)">
        <path
          d={`${path} L${x(last)} ${BOTTOM} L${LEFT} ${BOTTOM} Z`}
          fill="url(#price-fill)"
        />
        <path className="price-line" d={path} />
      </g>
      {fired.map((e, i) => (
        <g key={i} className="fire-marker">
          <line
            x1={x(e.block)}
            x2={x(e.block)}
            y1={TOP - 6}
            y2={BOTTOM}
            strokeDasharray="2 4"
          />
          <rect x={x(e.block) - 9} y={TOP - 26} width="18" height="18" rx="2" />
          <text x={x(e.block)} y={TOP - 13} textAnchor="middle">
            {i + 1}
          </text>
        </g>
      ))}
      <line
        className="playhead"
        x1={x(block)}
        x2={x(block)}
        y1={TOP}
        y2={BOTTOM}
      />
      {hovered && (
        <g className="crosshair" aria-hidden="true">
          <line
            x1={x(hovered.block)}
            x2={x(hovered.block)}
            y1={TOP}
            y2={BOTTOM}
          />
          <circle
            cx={x(hovered.block)}
            cy={y(Number(hovered.twap))}
            r="4"
          />
          <rect x={tipX} y={TOP} width="120" height="44" rx="4" />
          <text x={tipX + 10} y={TOP + 18} className="tip-label">
            {elapsedLabel((hovered.block * rehearsal.blockMillis) / 1000)} ·
            block {hovered.block}
          </text>
          <text x={tipX + 10} y={TOP + 35} className="tip-value">
            {hovered.twap} TWAP
          </text>
        </g>
      )}
    </svg>
  );
}
