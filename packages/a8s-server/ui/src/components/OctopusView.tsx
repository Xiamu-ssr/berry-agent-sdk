import { Tag, Tooltip } from '@arco-design/web-react';

// ============================================================
// OctopusView — 高质量 SVG 八爪鱼 mascot
// ============================================================
// 大圆头(章鱼特征的馒头形) + 大眼 + 8 条粗壮弯曲触手
// 每条触手是真正的粗壮有机形状(closed path,非线条)

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

const KIND_COLORS: Record<string, string> = {
  local: '#22c55e', workspace: '#22c55e', web: '#3b82f6',
  system: '#6b7280', mcp: '#a855f7', shell: '#f97316',
};

function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? '#6366f1';
}

const CAP_ICONS: Record<string, string> = {
  shell: '⌨️', read_file: '📄', write_file: '✏️', edit_file: '✂️',
  list_files: '📁', grep: '🔍', find_files: '🗂', web_fetch: '🌐',
  web_search: '🔎', exec: '⚡', save_memory: '💾', memory_search: '🧠',
};

function capIcon(name: string): string {
  if (name.startsWith('mcp:')) return '🔌';
  return CAP_ICONS[name] ?? '⚙️';
}

interface OctopusViewProps {
  data: OctopusData;
  size?: number;
  className?: string;
}

export function OctopusView({ data, size = 420, className }: OctopusViewProps) {
  const { brain, hands, skills } = data;
  const n = hands.length;

  return (
    <div className={`inline-flex flex-col items-center gap-2 ${className ?? ''}`} style={{ width: size }}>
      <style>{STYLES}</style>

      <div style={{ position: 'relative', width: size, height: size }}>
        {/* The octopus SVG — centered */}
        <svg
          viewBox="0 0 400 420"
          width={size * 0.55}
          height={size * 0.6}
          style={{ position: 'absolute', left: '50%', top: '32%', transform: 'translate(-50%, -50%)' }}
        >
          <defs>
            <radialGradient id="octo-body" cx="45%" cy="35%" r="55%">
              <stop offset="0%" stopColor="#6d5cad" />
              <stop offset="50%" stopColor="#4c3d8f" />
              <stop offset="100%" stopColor="#2d1f6b" />
            </radialGradient>
            <radialGradient id="octo-belly" cx="50%" cy="40%" r="50%">
              <stop offset="0%" stopColor="#8b7cc8" />
              <stop offset="100%" stopColor="#5a4a9a" />
            </radialGradient>
          </defs>

          {/* Tentacles — 8 thick organic shapes, spread like a real octopus */}
          <g className="octo-tentacles">
            {/* Left far */}
            <path className="octo-t t1" d="M120,250 C90,280 40,330 30,370 C25,390 35,400 50,395 C65,388 75,360 95,320 C105,295 125,270 140,255Z" fill="url(#octo-body)" />
            {/* Left mid */}
            <path className="octo-t t2" d="M140,260 C120,295 85,350 80,390 C78,410 90,418 105,410 C118,400 120,370 135,330 C145,305 155,280 160,265Z" fill="url(#octo-belly)" />
            {/* Left inner */}
            <path className="octo-t t3" d="M165,268 C155,305 140,365 145,400 C148,420 162,425 172,415 C180,405 172,375 175,340 C178,310 180,285 180,270Z" fill="url(#octo-body)" />
            {/* Center left */}
            <path className="octo-t t4" d="M190,270 C188,310 185,370 195,405 C200,422 215,425 222,413 C228,400 218,370 215,340 C212,310 208,285 205,272Z" fill="url(#octo-belly)" />
            {/* Center right */}
            <path className="octo-t t5" d="M215,270 C218,310 222,370 230,405 C235,422 248,422 253,410 C258,398 248,368 242,338 C238,310 230,285 225,272Z" fill="url(#octo-body)" />
            {/* Right inner */}
            <path className="octo-t t6" d="M240,268 C250,305 260,365 258,400 C256,420 244,425 234,415 C226,404 238,372 240,340 C242,310 242,285 242,270Z" fill="url(#octo-belly)" />
            {/* Right mid */}
            <path className="octo-t t7" d="M260,260 C280,295 315,350 320,390 C322,410 310,418 295,410 C282,400 280,370 265,330 C255,305 248,280 245,265Z" fill="url(#octo-body)" />
            {/* Right far */}
            <path className="octo-t t8" d="M275,250 C305,280 355,330 365,370 C370,390 360,400 345,395 C330,388 320,358 300,320 C290,295 278,270 265,255Z" fill="url(#octo-belly)" />

            {/* Suction cups (rows of light dots along tentacles) */}
            <g opacity="0.35" fill="#b8a9e0">
              <circle cx="60" cy="360" r="4" /><circle cx="70" cy="340" r="4.5" /><circle cx="82" cy="318" r="5" />
              <circle cx="95" cy="380" r="4" /><circle cx="105" cy="358" r="4.5" /><circle cx="115" cy="335" r="5" />
              <circle cx="155" cy="385" r="4" /><circle cx="160" cy="360" r="4.5" /><circle cx="165" cy="338" r="5" />
              <circle cx="205" cy="390" r="4" /><circle cx="205" cy="368" r="4.5" /><circle cx="205" cy="345" r="5" />
              <circle cx="240" cy="388" r="4" /><circle cx="242" cy="365" r="4.5" /><circle cx="240" cy="342" r="5" />
              <circle cx="260" cy="382" r="4" /><circle cx="255" cy="358" r="4.5" /><circle cx="248" cy="336" r="5" />
              <circle cx="305" cy="375" r="4" /><circle cx="295" cy="355" r="4.5" /><circle cx="283" cy="332" r="5" />
              <circle cx="345" cy="365" r="4" /><circle cx="330" cy="345" r="4.5" /><circle cx="315" cy="320" r="5" />
            </g>
          </g>

          {/* Head — large dome shape (octopus mantle) */}
          <ellipse cx="200" cy="175" rx="110" ry="120" fill="url(#octo-body)" className="octo-head" />

          {/* Head highlight (glossy sheen) */}
          <ellipse cx="170" cy="135" rx="50" ry="35" fill="white" opacity="0.07" transform="rotate(-10 170 135)" />

          {/* Face — large expressive eyes */}
          <g>
            {/* Left eye white */}
            <ellipse cx="160" cy="185" rx="28" ry="30" fill="white" />
            {/* Right eye white */}
            <ellipse cx="240" cy="185" rx="28" ry="30" fill="white" />
            {/* Left iris */}
            <circle cx="163" cy="188" r="16" fill="#1a1145" className="octo-iris" />
            {/* Right iris */}
            <circle cx="243" cy="188" r="16" fill="#1a1145" className="octo-iris" />
            {/* Left pupil highlight */}
            <circle cx="158" cy="182" r="5" fill="white" opacity="0.9" />
            <circle cx="168" cy="192" r="3" fill="white" opacity="0.5" />
            {/* Right pupil highlight */}
            <circle cx="238" cy="182" r="5" fill="white" opacity="0.9" />
            <circle cx="248" cy="192" r="3" fill="white" opacity="0.5" />
          </g>

          {/* Mouth (small gentle smile) */}
          <path d="M188,220 Q200,232 212,220" stroke="#2d1f6b" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </svg>

        {/* Capability bubbles orbiting around */}
        {hands.map((hand, i) => {
          const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
          const rx = 42;
          const ry = 36;
          const bx = 50 + Math.cos(angle) * rx;
          const by = 42 + Math.sin(angle) * ry;
          const color = kindColor(hand.kind);
          const icon = hand.capabilities.length > 0 ? capIcon(hand.capabilities[0]) : '⚙️';

          return (
            <div
              key={hand.id}
              className="octo-bubble"
              style={{
                position: 'absolute',
                left: `${bx}%`, top: `${by}%`,
                transform: 'translate(-50%, -50%)',
                animationDelay: `${i * 0.4}s`,
              }}
            >
              <div className="octo-bubble-ring" style={{ borderColor: color }}>
                <span style={{ fontSize: 20 }}>{icon}</span>
              </div>
              <div className="octo-lbl">{hand.displayName || hand.id}</div>
              <div className="octo-sub">{hand.capabilities.length} tools</div>
            </div>
          );
        })}

        {/* Model name */}
        <div style={{
          position: 'absolute', bottom: size * 0.06, left: '50%',
          transform: 'translateX(-50%)',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: 12, fontWeight: 600, color: '#6366f1',
          whiteSpace: 'nowrap',
        }}>
          {shortModel(brain.model)}
        </div>
      </div>

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

const STYLES = `
  .octo-head {
    animation: oBreathe 3.5s ease-in-out infinite;
    transform-origin: 200px 175px;
  }
  @keyframes oBreathe {
    0%,100% { transform: scale(1); }
    50% { transform: scale(1.015); }
  }
  .octo-iris {
    animation: oLook 5s ease-in-out infinite;
  }
  @keyframes oLook {
    0%,100% { transform: translateX(0); }
    30% { transform: translateX(2px); }
    70% { transform: translateX(-2px); }
  }
  .octo-t {
    animation: oWave 3s ease-in-out infinite;
    transform-origin: top center;
  }
  .t1 { animation-delay: 0s; }
  .t2 { animation-delay: 0.2s; }
  .t3 { animation-delay: 0.4s; }
  .t4 { animation-delay: 0.6s; }
  .t5 { animation-delay: 0.8s; }
  .t6 { animation-delay: 1.0s; }
  .t7 { animation-delay: 1.2s; }
  .t8 { animation-delay: 1.4s; }
  @keyframes oWave {
    0%,100% { transform: rotate(0deg); }
    30% { transform: rotate(3deg); }
    70% { transform: rotate(-3deg); }
  }
  .octo-bubble {
    animation: oFloat 3.5s ease-in-out infinite;
  }
  @keyframes oFloat {
    0%,100% { transform: translate(-50%,-50%) translateY(0); }
    50% { transform: translate(-50%,-50%) translateY(-5px); }
  }
  .octo-bubble-ring {
    width: 48px; height: 48px; border-radius: 50%;
    background: white; border: 2.5px solid;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 3px 12px rgba(0,0,0,0.08);
    margin: 0 auto;
  }
  .octo-lbl {
    text-align: center; font-size: 11px; font-weight: 600;
    color: #374151; margin-top: 5px; white-space: nowrap;
  }
  .octo-sub {
    text-align: center; font-size: 9px; color: #9ca3af;
  }
`;

function shortModel(m: string): string {
  const p = m.split('/');
  const n = p[p.length - 1];
  return n.length > 20 ? n.slice(0, 18) + '…' : n;
}

// ============================================================
// OctopusPreview — for wizard
// ============================================================

export interface OctopusPreviewProps {
  model: string;
  hands: Array<{ id: string; name: string; machineId: string; toolGroups: string[]; mcpServerRefs: string[] }>;
}

export function OctopusPreview({ model, hands }: OctopusPreviewProps) {
  const data: OctopusData = {
    brain: { model, status: 'idle' },
    hands: hands.map((h) => ({
      id: h.id, kind: 'local', displayName: h.name,
      capabilities: [
        ...(h.toolGroups.includes('workspace') ? ['shell', 'read_file', 'write_file', 'edit_file'] : []),
        ...(h.toolGroups.includes('web') ? ['web_fetch', 'web_search'] : []),
        'exec',
        ...h.mcpServerRefs.map((s) => `mcp:${s}`),
      ],
    })),
  };
  return <OctopusView data={data} size={280} />;
}
