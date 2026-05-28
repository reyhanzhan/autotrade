// ============================================================================
// Sparkline — zero-dependency SVG sparkline. Used for equity curve thumbnails
// on the Dashboard balance card.
// ============================================================================

interface Props {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}

export function Sparkline({ points, width = 220, height = 48, color = "#10b981", fill = true }: Props) {
  if (points.length < 2) {
    return <div className="text-xs text-slate-500">Not enough data yet</div>;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const dx = width / (points.length - 1);
  const path = points.map((p, i) => {
    const x = i * dx;
    const y = height - ((p - min) / span) * (height - 4) - 2;
    return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const last = points[points.length - 1] ?? 0;
  const first = points[0] ?? 0;
  const isUp = last >= first;
  const stroke = color === "auto" ? (isUp ? "#10b981" : "#ef4444") : color;
  const fillColor = stroke + "22";

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      {fill && (
        <path
          d={`${path} L${width},${height} L0,${height} Z`}
          fill={fillColor}
        />
      )}
      <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
