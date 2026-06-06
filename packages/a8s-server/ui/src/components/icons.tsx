// ============================================================
// Icons — minimal line icons for the Snow Mountain console nav.
// ============================================================
// Stroke-based, inherit currentColor, 1.6 stroke. Kept inline (no icon
// dependency) so the bundle stays tiny and the visual language is ours.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  };
}

/** Brand mark — a snow-capped peak. */
export function PeakMark(props: IconProps) {
  return (
    <svg {...base({ width: 22, height: 22, ...props })}>
      <path d="M3 19h18L14.5 6.5l-3 5-2-3L3 19Z" />
      <path d="M12.2 9.6l2.3 2.9 1.2-2 1.4 2.6" stroke="white" strokeWidth={1.2} opacity={0.9} />
    </svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function AgentIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l.9-5.4A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

export function WorkerIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <circle cx="7" cy="7.5" r="0.8" fill="currentColor" />
      <circle cx="7" cy="16.5" r="0.8" fill="currentColor" />
    </svg>
  );
}

export function MachineIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export function LeaseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 3h9l6 6v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M8 13h8M8 17h5" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function ModelIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </svg>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M11.2 11.2 20 20M16 16l2-2M18 18l2-2" />
    </svg>
  );
}

export function AuditIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 4h6M9 4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2" />
      <path d="M9 9h6M9 13h6M9 17h3" />
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <svg {...base({ width: 16, height: 16, ...props })}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** Hand — the capability an agent grasps. */
export function HandIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 11V6a1.5 1.5 0 0 1 3 0v4" />
      <path d="M10 10V4.5a1.5 1.5 0 0 1 3 0V10" />
      <path d="M13 10V6a1.5 1.5 0 0 1 3 0v6" />
      <path d="M16 8.5A1.5 1.5 0 0 1 19 9v4a7 7 0 0 1-7 7 7 7 0 0 1-5-2l-3-3.5a1.5 1.5 0 0 1 2.2-2L7 13" />
    </svg>
  );
}

/** Skill — a booklet of knowledge. */
export function SkillIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5a2 2 0 0 1 2-2h7v16H6a2 2 0 0 0-2 2V5Z" />
      <path d="M13 3h5a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2h-5" />
      <path d="M7 7h3M7 10h3" />
    </svg>
  );
}
