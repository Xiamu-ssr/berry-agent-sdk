import { afterEach, describe, expect, it } from 'vitest';
import { createCommandEnvironment } from '../command-environment.js';

const previousSecret = process.env.BERRY_AGENT_TEST_SECRET;
const previousPath = process.env.PATH;

afterEach(() => {
  if (previousSecret === undefined) delete process.env.BERRY_AGENT_TEST_SECRET;
  else process.env.BERRY_AGENT_TEST_SECRET = previousSecret;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
});

describe('createCommandEnvironment', () => {
  it('does not inherit arbitrary host secrets by default', () => {
    process.env.BERRY_AGENT_TEST_SECRET = 'secret';

    const env = createCommandEnvironment();

    expect(env.BERRY_AGENT_TEST_SECRET).toBeUndefined();
    expect(env.PATH).toBeTruthy();
  });

  it('allows explicit scoped credential injection', () => {
    process.env.BERRY_AGENT_TEST_SECRET = 'host-secret';

    const env = createCommandEnvironment({
      env: { BERRY_AGENT_TEST_SECRET: 'scoped-secret' },
    });

    expect(env.BERRY_AGENT_TEST_SECRET).toBe('scoped-secret');
  });

  it('can remove inherited defaults', () => {
    process.env.PATH = '/bin';

    const env = createCommandEnvironment({ env: { PATH: undefined } });

    expect(env.PATH).toBeUndefined();
  });
});
