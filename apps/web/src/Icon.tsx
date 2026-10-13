const paths = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  check: "m5 12 4 4 10-10",
  blocks: "M4 4h7v7H4zM14 4h6v7h-6zM4 14h7v6H4zM14 14h6v6h-6z",
  play: "m8 5 11 7-11 7z",
  pause: "M8 5v14M16 5v14",
  book: "M4 4h7v16H4zM11 4h9v16h-9",
  chevron: "m9 5 7 7-7 7",
  settings: "M4 7h16M4 17h16M9 4v6M15 14v6",
  clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6",
  layers: "m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5",
  close: "M6 6l12 12M18 6 6 18",
  alert: "M12 8v5M12 16.5v.5M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  skip: "m6 5 9 7-9 7zM18 5v14",
  reset: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  folder: "M3 6h6l2 2h10v11H3z",
} as const;
export function Icon({
  name,
  size = 18,
}: {
  name: keyof typeof paths;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

// The Metropilot mark: a cream M whose last stroke rises into a gold arrow, with a gold point below.
// Geometry follows the 1000×1000 master artwork; brand/favicon.svg uses the same paths.
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 1000 1000"
      aria-hidden="true"
    >
      <rect className="brand-tile" x="0" y="0" width="1000" height="1000" rx="230" />
      <g fill="none" strokeWidth="80" strokeLinecap="round" strokeLinejoin="round">
        <path className="brand-m" d="M285 700V330l215 215 180-195" />
        <path className="brand-arrow" d="M592 312h123v123" />
      </g>
      <circle className="brand-dot" cx="705" cy="690" r="48" />
    </svg>
  );
}
