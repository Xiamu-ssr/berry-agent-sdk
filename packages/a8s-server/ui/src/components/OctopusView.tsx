import { useEffect, useRef, useMemo, useCallback } from 'react';
import { Tag, Tooltip } from '@arco-design/web-react';

// ============================================================
// OctopusView — Canvas 2D 有机八爪鱼可视化
// ============================================================
// Brain = 八爪鱼头(椭圆+渐变+呼吸脉搏)
// Hand = 触手(多段贝塞尔+波动动画+吸盘节点)
// Capabilities = 吸盘(沿触手分布的小圆)

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

const KIND_COLORS: Record<string, [number, number, number]> = {
  local: [34, 197, 94],
  workspace: [34, 197, 94],
  web: [59, 130, 246],
  system: [156, 163, 175],
  mcp: [168, 85, 247],
  shell: [249, 115, 22],
};

function kindRgb(kind: string): [number, number, number] {
  return KIND_COLORS[kind] ?? [59, 130, 246];
}

const STATUS_COLORS: Record<string, string> = {
  idle: '#22c55e',
  running: '#3b82f6',
  busy: '#f59e0b',
  error: '#ef4444',
};

export function OctopusView({ data, size = 420, className }: OctopusViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef(0);

  const { brain, hands, skills } = data;
  const cx = size / 2;
  const cy = size / 2;

  const handLayout = useMemo(() => {
    const n = hands.length;
    if (n === 0) return [];
    const startAngle = -Math.PI / 2;
    return hands.map((h, i) => {
      const angle = startAngle + (2 * Math.PI * i) / n;
      const reach = size * 0.38;
      return { hand: h, angle, reach };
    });
  }, [hands, size]);

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

    const breathe = 1 + Math.sin(t * 0.002) * 0.03;
    const headRx = size * 0.09 * breathe;
    const headRy = size * 0.11 * breathe;

    // Draw tentacles
    for (const { hand, angle, reach } of handLayout) {
      const rgb = kindRgb(hand.kind);
      const segments = 20;
      const capCount = Math.min(hand.capabilities.length, 8);

      // Build tentacle path with organic wave
      const points: Array<[number, number]> = [];
      for (let s = 0; s <= segments; s++) {
        const frac = s / segments;
        const wave = Math.sin(t * 0.003 + frac * 4 + angle * 2) * (8 + frac * 12);
        const perpAngle = angle + Math.PI / 2;
        const baseX = cx + Math.cos(angle) * reach * frac;
        const baseY = cy + Math.sin(angle) * reach * frac;
        const px = baseX + Math.cos(perpAngle) * wave * frac;
        const py = baseY + Math.sin(perpAngle) * wave * frac;
        points.push([px, py]);
      }

      // Tentacle body (tapered stroke)
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let s = 1; s < points.length - 1; s++) {
        const xc = (points[s][0] + points[s + 1][0]) / 2;
        const yc = (points[s][1] + points[s + 1][1]) / 2;
        ctx.quadraticCurveTo(points[s][0], points[s][1], xc, yc);
      }
      const last = points[points.length - 1];
      ctx.lineTo(last[0], last[1]);

      const grad = ctx.createLinearGradient(cx, cy, last[0], last[1]);
      grad.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.8)`);
      grad.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.3)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 6 * (1 - 0); // base width at root
      ctx.lineCap = 'round';

      // Draw with taper effect
      for (let s = 0; s < points.length - 1; s++) {
        const frac = s / points.length;
        const width = 7 * (1 - frac * 0.7);
        ctx.beginPath();
        ctx.moveTo(points[s][0], points[s][1]);
        ctx.lineTo(points[s + 1][0], points[s + 1][1]);
        ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.8 - frac * 0.5})`;
        ctx.lineWidth = width;
        ctx.stroke();
      }

      // Suction cups along tentacle
      for (let c = 0; c < capCount; c++) {
        const frac = 0.25 + (c / capCount) * 0.65;
        const idx = Math.floor(frac * (points.length - 1));
        const [sx, sy] = points[idx];
        const cupSize = 3.5 - c * 0.2;
        const pulse = 1 + Math.sin(t * 0.004 + c) * 0.2;

        ctx.beginPath();
        ctx.arc(sx, sy, cupSize * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.6)`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.9)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Hand end node (glowing dot)
      const endIdx = points.length - 1;
      const [ex, ey] = points[endIdx];
      const glowR = 12 + Math.sin(t * 0.003 + angle) * 2;

      ctx.beginPath();
      ctx.arc(ex, ey, glowR, 0, Math.PI * 2);
      const glow = ctx.createRadialGradient(ex, ey, 0, ex, ey, glowR);
      glow.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.9)`);
      glow.addColorStop(0.6, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.4)`);
      glow.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
      ctx.fillStyle = glow;
      ctx.fill();

      // Hand label
      ctx.fillStyle = '#374151';
      ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(hand.displayName || hand.id, ex, ey + glowR + 14);
      ctx.fillStyle = '#9ca3af';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText(`${hand.capabilities.length} tools`, ex, ey + glowR + 26);
    }

    // Octopus head (body)
    ctx.beginPath();
    ctx.ellipse(cx, cy, headRx, headRy, 0, 0, Math.PI * 2);
    const headGrad = ctx.createRadialGradient(cx - headRx * 0.3, cy - headRy * 0.3, 0, cx, cy, headRy);
    headGrad.addColorStop(0, 'rgba(99, 102, 241, 0.95)');
    headGrad.addColorStop(0.7, 'rgba(79, 70, 229, 0.9)');
    headGrad.addColorStop(1, 'rgba(55, 48, 163, 0.85)');
    ctx.fillStyle = headGrad;
    ctx.fill();

    // Head glow
    ctx.beginPath();
    ctx.ellipse(cx, cy, headRx + 4, headRy + 4, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Eyes
    const eyeOff = headRx * 0.35;
    const eyeR = 4;
    ctx.beginPath();
    ctx.arc(cx - eyeOff, cy - headRy * 0.15, eyeR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + eyeOff, cy - headRy * 0.15, eyeR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    // Pupils
    const blinkPhase = Math.sin(t * 0.001);
    const pupilR = 2.2;
    ctx.beginPath();
    ctx.arc(cx - eyeOff + blinkPhase * 0.5, cy - headRy * 0.15, pupilR, 0, Math.PI * 2);
    ctx.fillStyle = '#1e1b4b';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + eyeOff + blinkPhase * 0.5, cy - headRy * 0.15, pupilR, 0, Math.PI * 2);
    ctx.fillStyle = '#1e1b4b';
    ctx.fill();

    // Status indicator
    const statusColor = STATUS_COLORS[brain.status ?? 'idle'] ?? STATUS_COLORS.idle;
    ctx.beginPath();
    ctx.arc(cx + headRx * 0.8, cy - headRy * 0.8, 5, 0, Math.PI * 2);
    ctx.fillStyle = statusColor;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Model name below head
    ctx.fillStyle = '#6366f1';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(shortModel(brain.model), cx, cy + headRy + 18);
  }, [brain, handLayout, cx, cy, size]);

  useEffect(() => {
    let running = true;
    const loop = (timestamp: number) => {
      if (!running) return;
      timeRef.current = timestamp;
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

function shortModel(model: string): string {
  const parts = model.split('/');
  const name = parts[parts.length - 1];
  if (name.length > 18) return name.slice(0, 16) + '…';
  return name;
}

// ============================================================
// OctopusPreview — wizard Step 4 preview
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
  return <OctopusView data={data} size={300} />;
}
