// ============================================================
// Sparkline — a tiny dependency-free SVG trend line.
// ============================================================
// Feeds on the rolling history the dashboard accumulates from its 5s poll.
// Renders an area + line; flat/empty input degrades to a baseline.

export function Sparkline({
  data,
  width = 240,
  height = 48,
  className = '',
  tone = 'snow',
}: {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  tone?: 'snow' | 'emerald' | 'berry';
}) {
  const stroke =
    tone === 'emerald' ? '#10b981' : tone === 'berry' ? '#ef4444' : '#0284c7';
  const pad = 3;
  const n = data.length;

  if (n < 2) {
    return (
      <svg width={width} height={height} className={className} preserveAspectRatio="none">
        <line
          x1={pad} y1={height / 2} x2={width - pad} y2={height / 2}
          stroke={stroke} strokeWidth={1.5} strokeDasharray="3 3" opacity={0.4}
        />
      </svg>
    );
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (n - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const line = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${height - pad} L${x(0).toFixed(1)},${height - pad} Z`;
  const gid = `spark-${tone}`;

  return (
    <svg width={width} height={height} className={className} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
