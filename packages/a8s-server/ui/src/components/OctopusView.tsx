import { Tag, Tooltip } from '@arco-design/web-react';

// ============================================================
// OctopusView — 高质量矢量八爪鱼 mascot + CSS 动画
// ============================================================

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

const CAP_ICONS: Record<string, string> = {
  shell: '⌨️', read_file: '📄', write_file: '✏️',
  edit_file: '✂️', list_files: '📁', grep: '🔍',
  find_files: '🗂', web_fetch: '🌐', web_search: '🔎',
  exec: '⚡', save_memory: '💾', memory_search: '🧠',
  memory_get: '📥',
};

function capIcon(name: string): string {
  if (name.startsWith('mcp:')) return '🔌';
  return CAP_ICONS[name] ?? '⚙️';
}

export function OctopusView({ data, size = 420, className }: OctopusViewProps) {
  const { brain, hands, skills } = data;
  const n = hands.length;

  return (
    <div className={`octopus-container ${className ?? ''}`} style={{ width: size, height: size, position: 'relative' }}>
      <style>{octopusStyles}</style>

      {/* SVG octopus mascot (center) */}
      <div className="octopus-body" style={{ position: 'absolute', left: '50%', top: '38%', transform: 'translate(-50%, -50%)' }}>
        <svg width={size * 0.35} height={size * 0.5} viewBox="0 0 140 200" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Head */}
          <ellipse cx="70" cy="55" rx="45" ry="52" fill="url(#headGrad)" className="octo-head" />
          <ellipse cx="55" cy="38" rx="12" ry="8" fill="rgba(255,255,255,0.08)" transform="rotate(-15 55 38)" />

          {/* Glasses */}
          <circle cx="55" cy="52" r="12" stroke="#374151" strokeWidth="2.5" fill="rgba(255,255,255,0.05)" />
          <circle cx="85" cy="52" r="12" stroke="#374151" strokeWidth="2.5" fill="rgba(255,255,255,0.05)" />
          <line x1="67" y1="52" x2="73" y2="52" stroke="#374151" strokeWidth="2.5" />
          <line x1="43" y1="52" x2="38" y2="48" stroke="#374151" strokeWidth="2" strokeLinecap="round" />
          <line x1="97" y1="52" x2="102" y2="48" stroke="#374151" strokeWidth="2" strokeLinecap="round" />

          {/* Eyes */}
          <circle cx="55" cy="52" r="5" fill="white" />
          <circle cx="85" cy="52" r="5" fill="white" />
          <circle cx="56" cy="52" r="2.8" fill="#1e1b4b" className="octo-pupil" />
          <circle cx="86" cy="52" r="2.8" fill="#1e1b4b" className="octo-pupil" />
          <circle cx="57" cy="50.5" r="1" fill="white" />
          <circle cx="87" cy="50.5" r="1" fill="white" />

          {/* Tentacles (8, with organic curves) */}
          <path d="M35 95 Q25 130 20 160 Q18 175 25 180 Q30 172 28 155 Q32 125 40 100" fill="#1e1b4b" opacity="0.9" className="octo-tentacle t1" />
          <path d="M42 100 Q35 135 33 165 Q32 180 38 182 Q42 174 40 158 Q42 128 48 105" fill="#1a1845" opacity="0.85" className="octo-tentacle t2" />
          <path d="M50 103 Q47 140 48 168 Q48 184 54 185 Q57 177 55 162 Q54 132 56 108" fill="#1e1b4b" opacity="0.9" className="octo-tentacle t3" />
          <path d="M58 105 Q58 142 60 170 Q61 186 67 186 Q69 178 67 164 Q66 134 64 108" fill="#1a1845" opacity="0.85" className="octo-tentacle t4" />
          <path d="M72 105 Q74 142 76 170 Q77 186 83 185 Q84 177 82 163 Q80 133 78 108" fill="#1e1b4b" opacity="0.9" className="octo-tentacle t5" />
          <path d="M84 103 Q88 138 90 165 Q91 182 97 180 Q99 172 96 157 Q93 128 90 105" fill="#1a1845" opacity="0.85" className="octo-tentacle t6" />
          <path d="M94 100 Q100 132 105 160 Q107 176 113 173 Q114 165 110 150 Q104 122 98 98" fill="#1e1b4b" opacity="0.9" className="octo-tentacle t7" />
          <path d="M102 95 Q112 125 118 152 Q121 168 127 164 Q127 156 122 142 Q114 115 106 93" fill="#1a1845" opacity="0.85" className="octo-tentacle t8" />

          {/* Suction cups on tentacles */}
          <circle cx="24" cy="150" r="2" fill="rgba(100,100,140,0.3)" />
          <circle cx="26" cy="140" r="2.2" fill="rgba(100,100,140,0.25)" />
          <circle cx="36" cy="148" r="2" fill="rgba(100,100,140,0.3)" />
          <circle cx="38" cy="138" r="2.2" fill="rgba(100,100,140,0.25)" />
          <circle cx="50" cy="150" r="2" fill="rgba(100,100,140,0.3)" />
          <circle cx="52" cy="140" r="2.2" fill="rgba(100,100,140,0.25)" />
          <circle cx="62" cy="152" r="2" fill="rgba(100,100,140,0.3)" />
          <circle cx="64" cy="142" r="2.2" fill="rgba(100,100,140,0.25)" />
          <circle cx="78" cy="152" r="2" fill="rgba(100,100,140,0.3)" />
          <circle cx="80" cy="142" r="2.2" fill="rgba(100,100,140,0.25)" />
          <circle cx="92" cy="148" r="2" fill="rgba(100,100,140,0.3)" />
          <circle cx="94" cy="138" r="2.2" fill="rgba(100,100,140,0.25)" />
          <circle cx="107" cy="145" r="2" fill="rgba(100,100,140,0.3)" />
          <circle cx="109" cy="135" r="2.2" fill="rgba(100,100,140,0.25)" />
          <circle cx="120" cy="140" r="2" fill="rgba(100,100,140,0.3)" />
          <circle cx="118" cy="130" r="2.2" fill="rgba(100,100,140,0.25)" />

          <defs>
            <radialGradient id="headGrad" cx="0.4" cy="0.35" r="0.65">
              <stop offset="0%" stopColor="#2d2b55" />
              <stop offset="60%" stopColor="#1e1b4b" />
              <stop offset="100%" stopColor="#0f0a2e" />
            </radialGradient>
          </defs>
        </svg>
      </div>

      {/* Model label */}
      <div
        className="text-center"
        style={{
          position: 'absolute', left: '50%', bottom: size * 0.08,
          transform: 'translateX(-50%)',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: 12, fontWeight: 600, color: '#6366f1',
        }}
      >
        {shortModel(brain.model)}
      </div>

      {/* Capability bubbles orbiting */}
      {hands.map((hand, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
        const orbitR = size * 0.38;
        const bx = 50 + Math.cos(angle) * 38;
        const by = 42 + Math.sin(angle) * 34;
        const color = kindColor(hand.kind);
        const icon = hand.capabilities.length > 0 ? capIcon(hand.capabilities[0]) : '⚙️';

        return (
          <div
            key={hand.id}
            className="octo-bubble"
            style={{
              position: 'absolute',
              left: `${bx}%`,
              top: `${by}%`,
              transform: 'translate(-50%, -50%)',
              animationDelay: `${i * 0.3}s`,
            }}
          >
            <div
              className="octo-bubble-circle"
              style={{ borderColor: color }}
            >
              <span style={{ fontSize: 18 }}>{icon}</span>
            </div>
            <div className="octo-bubble-label">{hand.displayName || hand.id}</div>
            <div className="octo-bubble-count">{hand.capabilities.length} tools</div>
          </div>
        );
      })}

      {/* Skills below */}
      {skills && skills.length > 0 && (
        <div className="flex flex-wrap gap-1 justify-center" style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
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

const octopusStyles = `
  .octopus-container { overflow: visible; }

  .octo-head {
    animation: octo-breathe 3s ease-in-out infinite;
    transform-origin: center 55px;
  }
  @keyframes octo-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02); }
  }

  .octo-pupil {
    animation: octo-look 4s ease-in-out infinite;
  }
  @keyframes octo-look {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(1px); }
    75% { transform: translateX(-1px); }
  }

  .octo-tentacle {
    animation: octo-wave 2.5s ease-in-out infinite;
    transform-origin: top center;
  }
  .octo-tentacle.t1 { animation-delay: 0s; }
  .octo-tentacle.t2 { animation-delay: 0.15s; }
  .octo-tentacle.t3 { animation-delay: 0.3s; }
  .octo-tentacle.t4 { animation-delay: 0.45s; }
  .octo-tentacle.t5 { animation-delay: 0.6s; }
  .octo-tentacle.t6 { animation-delay: 0.75s; }
  .octo-tentacle.t7 { animation-delay: 0.9s; }
  .octo-tentacle.t8 { animation-delay: 1.05s; }
  @keyframes octo-wave {
    0%, 100% { transform: rotate(0deg) scaleY(1); }
    25% { transform: rotate(2deg) scaleY(1.02); }
    75% { transform: rotate(-2deg) scaleY(0.98); }
  }

  .octo-bubble {
    animation: octo-float 3s ease-in-out infinite;
  }
  @keyframes octo-float {
    0%, 100% { transform: translate(-50%, -50%) translateY(0); }
    50% { transform: translate(-50%, -50%) translateY(-6px); }
  }

  .octo-bubble-circle {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: white;
    border: 2.5px solid;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    margin: 0 auto;
  }

  .octo-bubble-label {
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    color: #374151;
    margin-top: 6px;
    white-space: nowrap;
  }

  .octo-bubble-count {
    text-align: center;
    font-size: 9px;
    color: #9ca3af;
  }
`;

function shortModel(model: string): string {
  const parts = model.split('/');
  const name = parts[parts.length - 1];
  if (name.length > 20) return name.slice(0, 18) + '…';
  return name;
}

// ============================================================
// OctopusPreview — wizard live preview
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
