import type { Rehearsal } from "./simulate.ts";
export function elapsedLabel(seconds: number): string {
  return seconds >= 86400
    ? `${(seconds / 86400).toFixed(1)}d`
    : seconds >= 3600
      ? `${(seconds / 3600).toFixed(1)}h`
      : `${Math.round(seconds)}s`;
}
export function PriceChart({
  rehearsal,
  block,
  threshold,
}: {
  rehearsal: Rehearsal;
  block: number;
  threshold: number | undefined;
}) {
  const ticks = rehearsal.ticks.filter((t) => t.twap !== undefined);
  const points = ticks.filter(
    (_, i) => i % Math.max(1, Math.floor(ticks.length / 350)) === 0,
  );
  if (!points.length)
    return (
      <p className="empty-state">No price observations in this scenario.</p>
    );
  const prices = points.map((t) => Number(t.twap));
  const low = Math.min(...prices, threshold ?? Infinity),
    high = Math.max(...prices, threshold ?? -Infinity);
  const padding = Math.max((high - low) * 0.15, Math.abs(high) * 1e-5, 0.5);
  const min = low - padding,
    max = high + padding;
  const last = Math.max(1, rehearsal.ticks.at(-1)?.block ?? 1);
  const x = (b: number) => 62 + (b / last) * 818;
  const y = (p: number) => 250 - ((p - min) / (max - min)) * 200;
  const path = points
    .map((t, i) => `${i ? "L" : "M"}${x(t.block)} ${y(Number(t.twap))}`)
    .join(" ");
  const fired = rehearsal.events.filter(
    (e) => e.kind === "fire" && e.block <= block,
  );
  return (
    <svg
      className="price-chart"
      viewBox="0 0 920 310"
      role="img"
      aria-label="Synthetic TWAP over time, with trigger events marked"
    >
      <defs>
        <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d3f36b" stopOpacity=".12" />
          <stop offset="100%" stopColor="#d3f36b" stopOpacity="0" />
        </linearGradient>
        <clipPath id="played">
          <rect x="0" y="0" width={x(block)} height="310" />
        </clipPath>
      </defs>
      {[0, 1, 2, 3, 4].map((i) => {
        const p = min + ((max - min) * i) / 4;
        return (
          <g key={i}>
            <line x1="62" x2="880" y1={y(p)} y2={y(p)} stroke="#314047" />
            <text x="50" y={y(p) + 4} textAnchor="end">
              {p.toFixed(1)}
            </text>
          </g>
        );
      })}
      {threshold !== undefined && (
        <g>
          <line
            x1="62"
            x2="880"
            y1={y(threshold)}
            y2={y(threshold)}
            stroke="#e4ba7d"
            strokeDasharray="5 5"
          />
          <text x="880" y={y(threshold) - 9} textAnchor="end" fill="#e4ba7d">
            Threshold {threshold}
          </text>
        </g>
      )}
      <path d={path} fill="none" stroke="#41545d" strokeWidth="2" />
      <g clipPath="url(#played)">
        <path d={`${path} L${x(last)} 250 L62 250 Z`} fill="url(#price-fill)" />
        <path d={path} fill="none" stroke="#d3f36b" strokeWidth="2.5" />
      </g>
      {fired.map((e, i) => (
        <g key={i}>
          <line
            x1={x(e.block)}
            x2={x(e.block)}
            y1="40"
            y2="250"
            stroke="#d3f36b"
            strokeDasharray="2 4"
          />
          <circle cx={x(e.block)} cy="32" r="11" fill="#d3f36b" />
          <text x={x(e.block)} y="36" textAnchor="middle" fill="#152018">
            {i + 1}
          </text>
        </g>
      ))}
      <line
        x1={x(block)}
        x2={x(block)}
        y1="50"
        y2="250"
        stroke="#b7c9d0"
        opacity=".5"
      />
      {[0, 1, 2, 3, 4].map((i) => (
        <text key={i} x={62 + (818 * i) / 4} y="281" textAnchor="middle">
          {elapsedLabel((((last * i) / 4) * rehearsal.blockMillis) / 1000)}
        </text>
      ))}
    </svg>
  );
}
