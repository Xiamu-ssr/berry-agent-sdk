import { useMemo } from 'react';
import { Tag, Tooltip } from '@arco-design/web-react';

// ============================================================
// OctopusView — Agent 4+1 八爪鱼可视化
// ============================================================
// Brain(中心)+ Hand(触手)+ Capabilities(吸盘)

export interface OctopusHand {
  id: string;
  kind: string;
  displayName?: string;
  capabilities: string[];
}

export interface OctopusData {
  brain: { model: string; provider?: string; status?: string };
  hands: OctopusHand[];
  skills?: Array<{ name: string; description: string }>;
}

interface OctopusViewProps {
  data: OctopusData;
  size?: number;
  className?: string;
}

const KIND_COLORS: Record<string, string> = {
  local: 'rgb(var(--green-6))',
  workspace: 'rgb(var(--green-6))',
  web: 'rgb(var(--arcoblue-5))',
  system: 'rgb(var(--gray-6))',
  mcp: 'rgb(var(--purple-6))',
  shell: 'rgb(var(--orange-6))',
};

function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? 'rgb(var(--arcoblue-6))';
}

const STATUS_COLORS: Record<string, string> = {
  idle: 'rgb(var(--green-6))',
  running: 'rgb(var(--arcoblue-6))',
  busy: 'rgb(var(--orange-5))',
  error: 'rgb(var(--red-6))',
};

export function OctopusView({ data, size = 380, className }: OctopusViewProps) {
  const { brain, hands, skills } = data;
  const cx = size / 2;
  const cy = size / 2;
  const brainR = size * 0.12;
  const tentacleLen = size * 0.32;

  const handPositions = useMemo(() => {
    const n = hands.length;
    if (n === 0) return [];
    const startAngle = -Math.PI / 2;
    return hands.map((h, i) => {
      const angle = startAngle + (2 * Math.PI * i) / n;
      const endX = cx + tentacleLen * Math.cos(angle);
      const endY = cy + tentacleLen * Math.sin(angle);
      const ctrlX = cx + (tentacleLen * 0.5) * Math.cos(angle + 0.15);
      const ctrlY = cy + (tentacleLen * 0.5) * Math.sin(angle + 0.15);
      return { hand: h, angle, endX, endY, ctrlX, ctrlY };
    });
  }, [hands, cx, cy, tentacleLen]);

  return (
    <div className={`inline-flex flex-col items-center gap-3 ${className ?? ''}`}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        style={{ overflow: 'visible' }}
      >
        {/* Tentacles */}
        {handPositions.map(({ hand, endX, endY, ctrlX, ctrlY }) => (
          <g key={hand.id}>
            {/* Tentacle path */}
            <path
              d={`M ${cx},${cy} Q ${ctrlX},${ctrlY} ${endX},${endY}`}
              fill="none"
              stroke={kindColor(hand.kind)}
              strokeWidth={2.5}
              strokeLinecap="round"
              opacity={0.7}
            />
            {/* Suction cups (capabilities) */}
            {hand.capabilities.slice(0, 6).map((cap, ci) => {
              const t = 0.4 + (ci * 0.1);
              const sx = (1 - t) * (1 - t) * cx + 2 * (1 - t) * t * ctrlX + t * t * endX;
              const sy = (1 - t) * (1 - t) * cy + 2 * (1 - t) * t * ctrlY + t * t * endY;
              return (
                <Tooltip key={cap} content={cap} mini>
                  <circle
                    cx={sx}
                    cy={sy}
                    r={3.5}
                    fill={kindColor(hand.kind)}
                    opacity={0.5}
                  />
                </Tooltip>
              );
            })}
            {/* Hand end node */}
            <circle
              cx={endX}
              cy={endY}
              r={size * 0.045}
              fill={kindColor(hand.kind)}
              opacity={0.9}
            />
            <text
              x={endX}
              y={endY + size * 0.08}
              textAnchor="middle"
              fontSize={10}
              fill="var(--color-text-2)"
              fontFamily="var(--font-family-mono, monospace)"
            >
              {hand.displayName || hand.id}
            </text>
            <text
              x={endX}
              y={endY + size * 0.08 + 13}
              textAnchor="middle"
              fontSize={8}
              fill="var(--color-text-4)"
            >
              {hand.capabilities.length} tools
            </text>
          </g>
        ))}

        {/* Brain center */}
        <circle
          cx={cx}
          cy={cy}
          r={brainR}
          fill="rgb(var(--arcoblue-1))"
          stroke="rgb(var(--arcoblue-6))"
          strokeWidth={3}
        />
        {/* Status indicator */}
        <circle
          cx={cx + brainR * 0.65}
          cy={cy - brainR * 0.65}
          r={5}
          fill={STATUS_COLORS[brain.status ?? 'idle'] ?? STATUS_COLORS.idle}
        />
        {/* Brain label */}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="rgb(var(--arcoblue-7))"
        >
          Brain
        </text>
        <text
          x={cx}
          y={cy + 10}
          textAnchor="middle"
          fontSize={9}
          fill="var(--color-text-3)"
          fontFamily="var(--font-family-mono, monospace)"
        >
          {shortModel(brain.model)}
        </text>
      </svg>

      {/* Skills badges below */}
      {skills && skills.length > 0 && (
        <div className="flex flex-wrap gap-1 justify-center max-w-xs">
          {skills.map((s) => (
            <Tooltip key={s.name} content={s.description} mini>
              <Tag size="small" color="purple">{s.name}</Tag>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}

function shortModel(model: string): string {
  const parts = model.split('/');
  const name = parts[parts.length - 1];
  if (name.length > 16) return name.slice(0, 14) + '…';
  return name;
}

// ============================================================
// OctopusPreview — lightweight version for wizard Step 4
// ============================================================

export interface OctopusPreviewProps {
  model: string;
  hands: Array<{ id: string; name: string; machineId: string; toolGroups: string[]; mcpServerRefs: string[] }>;
}

export function OctopusPreview({ model, hands }: OctopusPreviewProps) {
  const data: OctopusData = {
    brain: { model, status: 'idle' },
    hands: hands.map((h) => ({
      id: h.id,
      kind: 'local',
      displayName: h.name,
      capabilities: [
        ...(h.toolGroups.includes('workspace') ? ['shell', 'read_file', 'write_file'] : []),
        ...(h.toolGroups.includes('web') ? ['web_fetch', 'web_search'] : []),
        'exec',
        ...h.mcpServerRefs.map((s) => `mcp:${s}`),
      ],
    })),
  };
  return <OctopusView data={data} size={300} />;
}
