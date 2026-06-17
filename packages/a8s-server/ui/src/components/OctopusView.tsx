import { useEffect, useRef, useCallback } from 'react';
import { Tag, Tooltip } from '@arco-design/web-react';

// ============================================================
// OctopusView — Canvas 2D 真八爪鱼角色插画(mascot 风格)
// ============================================================
// 灵感:戴眼镜的八爪鱼 mascot + 环绕能力气泡

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
  local: '#22c55e',
  workspace: '#22c55e',
  web: '#3b82f6',
  system: '#6b7280',
  mcp: '#a855f7',
  shell: '#f97316',
};

function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? '#6366f1';
}

const CAPABILITY_ICONS: Record<string, string> = {
  shell: '⌨',
  read_file: '📄',
  write_file: '✏️',
  edit_file: '✂️',
  list_files: '📁',
  grep: '🔍',
  find_files: '🗂',
  web_fetch: '🌐',
  web_search: '🔎',
  exec: '⚡',
  save_memory: '💾',
  memory_search: '🧠',
  memory_get: '📥',
  process_list: '📋',
  process_kill: '❌',
};

function capIcon(name: string): string {
  if (name.startsWith('mcp:')) return '🔌';
  return CAPABILITY_ICONS[name] ?? '⚙️';
}

export function OctopusView({ data, size = 450, className }: OctopusViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  const { brain, hands, skills } = data;

  const draw = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      ctx.scale(dpr, dpr);
    }
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size * 0.42;
    const breathe = 1 + Math.sin(t * 0.0015) * 0.02;

    // --- Octopus body (head) ---
    const headW = size * 0.13 * breathe;
    const headH = size * 0.16 * breathe;

    // Shadow
    ctx.beginPath();
    ctx.ellipse(cx, cy + headH * 1.1, headW * 0.8, headH * 0.15, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fill();

    // Tentacles (8, curvy organic shapes)
    const tentacleCount = 8;
    const tentacleLen = size * 0.22;
    for (let i = 0; i < tentacleCount; i++) {
      const baseAngle = (Math.PI * 0.15) + (Math.PI * 0.7 / (tentacleCount - 1)) * i;
      const angle = baseAngle + Math.PI * 0.15;
      const startX = cx + Math.cos(angle - Math.PI / 2) * headW * 0.6;
      const startY = cy + headH * 0.7;

      const wave1 = Math.sin(t * 0.002 + i * 1.2) * 15;
      const wave2 = Math.cos(t * 0.0015 + i * 0.8) * 8;

      const endAngle = angle;
      const endX = startX + Math.cos(endAngle) * tentacleLen + wave1;
      const endY = startY + Math.sin(endAngle) * tentacleLen + Math.abs(wave2);

      const cp1x = startX + Math.cos(endAngle) * tentacleLen * 0.3 + wave2;
      const cp1y = startY + Math.sin(endAngle) * tentacleLen * 0.4;
      const cp2x = startX + Math.cos(endAngle) * tentacleLen * 0.65 + wave1 * 0.5;
      const cp2y = startY + Math.sin(endAngle) * tentacleLen * 0.8 + wave2;

      // Draw tapered tentacle
      const steps = 16;
      for (let s = 0; s < steps; s++) {
        const t1 = s / steps;
        const t2 = (s + 1) / steps;
        const [x1, y1] = bezier3(t1, startX, startY, cp1x, cp1y, cp2x, cp2y, endX, endY);
        const [x2, y2] = bezier3(t2, startX, startY, cp1x, cp1y, cp2x, cp2y, endX, endY);
        const width = (7 - t1 * 5.5) * breathe;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `rgba(30, 30, 60, ${0.85 - t1 * 0.4})`;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Suction cups (lighter circles on tentacles)
      for (let s = 2; s < steps - 2; s += 3) {
        const tf = s / steps;
        const [sx, sy] = bezier3(tf, startX, startY, cp1x, cp1y, cp2x, cp2y, endX, endY);
        const r = (2.5 - tf * 1.5) * breathe;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(80, 80, 120, ${0.3 - tf * 0.15})`;
        ctx.fill();
      }

      // Tentacle tip curl
      const tipCurl = Math.sin(t * 0.003 + i) * 5;
      ctx.beginPath();
      ctx.arc(endX + tipCurl, endY, 2 * breathe, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(30, 30, 60, 0.5)';
      ctx.fill();
    }

    // --- Head ---
    ctx.beginPath();
    ctx.ellipse(cx, cy, headW, headH, 0, 0, Math.PI * 2);
    const headGrad = ctx.createRadialGradient(cx - headW * 0.3, cy - headH * 0.3, 0, cx, cy, headH);
    headGrad.addColorStop(0, '#2d2b55');
    headGrad.addColorStop(0.6, '#1e1b4b');
    headGrad.addColorStop(1, '#0f0a2e');
    ctx.fillStyle = headGrad;
    ctx.fill();

    // Head highlight
    ctx.beginPath();
    ctx.ellipse(cx - headW * 0.25, cy - headH * 0.35, headW * 0.25, headH * 0.2, -0.3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();

    // --- Glasses ---
    const glassY = cy - headH * 0.05;
    const glassR = headW * 0.28;
    const glassGap = headW * 0.55;
    // Frames
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx - glassGap / 2, glassY, glassR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + glassGap / 2, glassY, glassR, 0, Math.PI * 2);
    ctx.stroke();
    // Bridge
    ctx.beginPath();
    ctx.moveTo(cx - glassGap / 2 + glassR, glassY);
    ctx.lineTo(cx + glassGap / 2 - glassR, glassY);
    ctx.stroke();
    // Lens shine
    ctx.beginPath();
    ctx.arc(cx - glassGap / 2, glassY, glassR - 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + glassGap / 2, glassY, glassR - 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();

    // --- Eyes (inside glasses) ---
    const pupilShift = Math.sin(t * 0.001) * 1.5;
    // Left eye
    ctx.beginPath();
    ctx.arc(cx - glassGap / 2 + pupilShift, glassY, glassR * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - glassGap / 2 + pupilShift, glassY, glassR * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = '#1e1b4b';
    ctx.fill();
    // Right eye
    ctx.beginPath();
    ctx.arc(cx + glassGap / 2 + pupilShift, glassY, glassR * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + glassGap / 2 + pupilShift, glassY, glassR * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = '#1e1b4b';
    ctx.fill();

    // --- Capability bubbles (orbit around octopus) ---
    const n = hands.length;
    const orbitR = size * 0.36;
    const bubbleR = size * 0.045;
    for (let i = 0; i < n; i++) {
      const hand = hands[i];
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
      const wobble = Math.sin(t * 0.002 + i * 1.5) * 4;
      const bx = cx + Math.cos(angle) * (orbitR + wobble);
      const by = cy + Math.sin(angle) * (orbitR + wobble) * 0.85;

      // Bubble
      ctx.beginPath();
      ctx.arc(bx, by, bubbleR, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = kindColor(hand.kind);
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Shadow under bubble
      ctx.beginPath();
      ctx.ellipse(bx, by + bubbleR + 3, bubbleR * 0.6, 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.04)';
      ctx.fill();

      // Icon inside bubble
      ctx.font = `${bubbleR * 0.9}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const icon = hand.capabilities.length > 0 ? capIcon(hand.capabilities[0]) : '⚙️';
      ctx.fillText(icon, bx, by + 1);

      // Label below bubble
      ctx.fillStyle = '#374151';
      ctx.font = `bold 10px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(hand.displayName || hand.id, bx, by + bubbleR + 8);
      ctx.fillStyle = '#9ca3af';
      ctx.font = `9px system-ui, sans-serif`;
      ctx.fillText(`${hand.capabilities.length} tools`, bx, by + bubbleR + 21);

      // Dotted connection line from head to bubble
      const lineStartX = cx + Math.cos(angle) * (headW + 5);
      const lineStartY = cy + Math.sin(angle) * (headH + 5);
      const lineEndX = bx - Math.cos(angle) * (bubbleR + 3);
      const lineEndY = by - Math.sin(angle) * (bubbleR + 3) * 0.85;
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.moveTo(lineStartX, lineStartY);
      ctx.lineTo(lineEndX, lineEndY);
      ctx.strokeStyle = `${kindColor(hand.kind)}66`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Model label under octopus
    ctx.fillStyle = '#6366f1';
    ctx.font = 'bold 12px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(shortModel(brain.model), cx, cy + headH + size * 0.06);

  }, [brain, hands, size]);

  useEffect(() => {
    let running = true;
    const loop = (timestamp: number) => {
      if (!running) return;
      draw(timestamp);
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [draw]);

  return (
    <div className={`inline-flex flex-col items-center gap-2 ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size }}
      />
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

// Cubic bezier point
function bezier3(
  t: number,
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
): [number, number] {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return [
    uuu * x0 + 3 * uu * t * x1 + 3 * u * tt * x2 + ttt * x3,
    uuu * y0 + 3 * uu * t * y1 + 3 * u * tt * y2 + ttt * y3,
  ];
}

function shortModel(model: string): string {
  const parts = model.split('/');
  const name = parts[parts.length - 1];
  if (name.length > 20) return name.slice(0, 18) + '…';
  return name;
}

// ============================================================
// OctopusPreview — wizard use (shows octopus growing as you add Hands)
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
        ...(h.toolGroups.includes('workspace') ? ['shell', 'read_file', 'write_file', 'edit_file'] : []),
        ...(h.toolGroups.includes('web') ? ['web_fetch', 'web_search'] : []),
        'exec',
        ...h.mcpServerRefs.map((s) => `mcp:${s}`),
      ],
    })),
  };
  return <OctopusView data={data} size={320} />;
}
