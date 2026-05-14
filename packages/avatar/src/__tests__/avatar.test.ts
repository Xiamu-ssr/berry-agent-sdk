import { describe, expect, it } from 'vitest';
import { createAvatarFromText } from '../index.js';

describe('@berry-agent/avatar', () => {
  it('creates stable pixel avatars from text', () => {
    const a = createAvatarFromText('calm code auditor for security review', { namespace: 'agent' });
    const b = createAvatarFromText('calm code auditor for security review', { namespace: 'agent' });

    expect(a.seed).toBe(b.seed);
    expect(a.svg).toBe(b.svg);
    expect(a.dataUri).toContain('data:image/svg+xml');
    expect(a.svg).toContain('<svg');
  });

  it('uses namespace as part of identity', () => {
    const agent = createAvatarFromText('orange', { namespace: 'agent' });
    const team = createAvatarFromText('orange', { namespace: 'team' });

    expect(agent.seed).not.toBe(team.seed);
  });
});
