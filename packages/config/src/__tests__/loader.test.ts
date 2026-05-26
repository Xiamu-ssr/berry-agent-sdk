import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSdkConfig, SdkConfigError } from '../loader.js';

let dir: string;
function write(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, 'utf-8');
  return p;
}

const validConfig = {
  models: {
    providers: {
      anthropic_main: {
        presetId: 'anthropic_official',
        apiKey: 'sk-test',
      },
    },
    models: {
      'claude-opus-4.7': {
        providers: [{ providerId: 'anthropic_main' }],
      },
    },
    tiers: {
      strong: 'claude-opus-4.7',
      balanced: 'claude-opus-4.7',
      fast: 'claude-opus-4.7',
    },
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'berry-sdk-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadSdkConfig — path handling', () => {
  it('throws when path is missing', () => {
    // @ts-expect-error deliberate misuse
    expect(() => loadSdkConfig(undefined)).toThrow(SdkConfigError);
    // @ts-expect-error deliberate misuse
    expect(() => loadSdkConfig(undefined)).toThrow(/explicit config file path is required/);
  });

  it('throws when path is empty string', () => {
    expect(() => loadSdkConfig('')).toThrow(SdkConfigError);
  });

  it('throws when path is not a string', () => {
    // @ts-expect-error deliberate misuse
    expect(() => loadSdkConfig(123)).toThrow(SdkConfigError);
  });

  it('throws when file does not exist, naming the path', () => {
    const missing = join(dir, 'nope.json');
    expect(() => loadSdkConfig(missing)).toThrow(new RegExp(missing.replace(/\//g, '\\/')));
  });
});

describe('loadSdkConfig — JSON validity', () => {
  it('throws on invalid JSON', () => {
    const p = write('bad.json', '{ not valid json');
    expect(() => loadSdkConfig(p)).toThrow(/not valid JSON/);
  });

  it('throws when top level is not an object (array)', () => {
    const p = write('arr.json', JSON.stringify([]));
    expect(() => loadSdkConfig(p)).toThrow(/must be a JSON object at the top level/);
  });

  it('throws when top level is not an object (number)', () => {
    const p = write('num.json', '42');
    expect(() => loadSdkConfig(p)).toThrow(/must be a JSON object at the top level/);
  });
});

describe('loadSdkConfig — schema strictness', () => {
  it('rejects unknown top-level fields', () => {
    const p = write('extra.json', JSON.stringify({ ...validConfig, bogus: true }));
    expect(() => loadSdkConfig(p)).toThrow(/unknown top-level field "bogus"/);
  });

  it('rejects missing models field', () => {
    const p = write('nomodels.json', JSON.stringify({}));
    expect(() => loadSdkConfig(p)).toThrow(/missing required field "models"/);
  });

  it('rejects models.providers missing', () => {
    const bad = { models: { models: {}, tiers: {} } };
    const p = write('noprov.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/invalid "models\.providers"/);
  });

  it('rejects models.models missing', () => {
    const bad = { models: { providers: {}, tiers: {} } };
    const p = write('nobind.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/invalid "models\.models"/);
  });

  it('rejects models.tiers missing', () => {
    const bad = { models: { providers: {}, models: {} } };
    const p = write('notiers.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/invalid "models\.tiers"/);
  });

  it('rejects explicit provider/model ids that disagree with registry keys', () => {
    const bad = {
      models: {
        providers: { p1: { id: 'other-provider', presetId: 'x', apiKey: 'sk' } },
        models: { 'm-1': { id: 'other-model', providers: [{ providerId: 'p1' }] } },
        tiers: { strong: 'm-1' },
      },
    };
    const p = write('id-mismatch.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/models\.providers\.p1\.id must match provider key "p1"/);
    expect(() => loadSdkConfig(p)).toThrow(/models\.models\.m-1\.id must match model key "m-1"/);
  });
});

describe('loadSdkConfig — provider validation', () => {
  it('rejects provider without presetId', () => {
    const bad = {
      models: {
        providers: { p1: { apiKey: 'sk' } },
        models: {},
        tiers: {},
      },
    };
    const p = write('no-preset.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/p1\.presetId must be a non-empty string/);
  });

  it('rejects provider without apiKey', () => {
    const bad = {
      models: {
        providers: { p1: { presetId: 'x' } },
        models: {},
        tiers: {},
      },
    };
    const p = write('no-key.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/p1\.apiKey must be a string/);
  });

  it('rejects provider that is not an object', () => {
    const bad = {
      models: {
        providers: { p1: 'oops' },
        models: {},
        tiers: {},
      },
    };
    const p = write('nonobj.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/p1 must be an object/);
  });
});

describe('loadSdkConfig — binding validation', () => {
  it('rejects binding without providers array', () => {
    const bad = {
      models: {
        providers: { p1: { presetId: 'x', apiKey: 'sk' } },
        models: { 'm-1': {} },
        tiers: {},
      },
    };
    const p = write('no-arr.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/m-1\.providers must be a non-empty array/);
  });

  it('rejects binding referencing unknown providerId', () => {
    const bad = {
      models: {
        providers: { p1: { presetId: 'x', apiKey: 'sk' } },
        models: { 'm-1': { providers: [{ providerId: 'does_not_exist' }] } },
        tiers: { strong: 'm-1', balanced: 'm-1', fast: 'm-1' },
      },
    };
    const p = write('dangling.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/unknown providerId "does_not_exist"/);
  });

  it('rejects binding with non-object provider ref', () => {
    const bad = {
      models: {
        providers: { p1: { presetId: 'x', apiKey: 'sk' } },
        models: { 'm-1': { providers: ['p1'] } },
        tiers: {},
      },
    };
    const p = write('string-ref.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/must be objects with a string "providerId"/);
  });
});

describe('loadSdkConfig — tier validation', () => {
  it('rejects tier referencing unknown model', () => {
    const bad = {
      models: {
        providers: { p1: { presetId: 'x', apiKey: 'sk' } },
        models: { 'm-1': { providers: [{ providerId: 'p1' }] } },
        tiers: { strong: 'does_not_exist' },
      },
    };
    const p = write('tier-dangle.json', JSON.stringify(bad));
    expect(() => loadSdkConfig(p)).toThrow(/models\.tiers\.strong points at unknown model "does_not_exist"/);
  });
});

describe('loadSdkConfig — happy path', () => {
  it('returns a typed BerrySdkConfig for a valid file', () => {
    const p = write('good.json', JSON.stringify(validConfig));
    const cfg = loadSdkConfig(p);
    expect(cfg.models.providers.anthropic_main!.apiKey).toBe('sk-test');
    expect(cfg.models.providers.anthropic_main!.id).toBe('anthropic_main');
    expect(cfg.models.models['claude-opus-4.7']!.id).toBe('claude-opus-4.7');
    expect(cfg.models.tiers.strong).toBe('claude-opus-4.7');
  });

  it('re-reads disk every call (no cache)', () => {
    const p = write('live.json', JSON.stringify(validConfig));
    const first = loadSdkConfig(p);
    expect(first.models.providers.anthropic_main!.apiKey).toBe('sk-test');

    const bumped = JSON.parse(JSON.stringify(validConfig));
    bumped.models.providers.anthropic_main.apiKey = 'sk-rotated';
    writeFileSync(p, JSON.stringify(bumped), 'utf-8');

    const second = loadSdkConfig(p);
    expect(second.models.providers.anthropic_main!.apiKey).toBe('sk-rotated');
  });
});

describe('SdkConfigError', () => {
  it('carries the path alongside the message', () => {
    const p = join(dir, 'missing.json');
    try {
      loadSdkConfig(p);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SdkConfigError);
      expect((err as SdkConfigError).path).toBe(p);
      expect((err as SdkConfigError).name).toBe('SdkConfigError');
    }
  });
});

describe('loadSdkConfig — safe namespace', () => {
  it('accepts valid safe config', () => {
    const cfg = { ...validConfig, safe: { classifier: { model: 'tier:fast' } } };
    const p = write('safe.json', JSON.stringify(cfg));
    const result = loadSdkConfig(p);
    expect(result.safe!.classifier!.model).toBe('tier:fast');
  });

  it('accepts safe with full classifier config', () => {
    const cfg = {
      ...validConfig,
      safe: {
        classifier: {
          model: 'tier:fast',
          enabled: true,
          blockRules: ['rm -rf'],
          allowExceptions: ['git push'],
          skipStage2: true,
          maxConsecutiveDenials: 5,
          maxTotalDenials: 50,
        },
      },
    };
    const p = write('safe-full.json', JSON.stringify(cfg));
    const result = loadSdkConfig(p);
    expect(result.safe!.classifier!.blockRules).toEqual(['rm -rf']);
    expect(result.safe!.classifier!.enabled).toBe(true);
    expect(result.safe!.classifier!.skipStage2).toBe(true);
  });

  it('rejects safe.classifier.model as non-string', () => {
    const cfg = { ...validConfig, safe: { classifier: { model: 123 } } };
    const p = write('safe-bad.json', JSON.stringify(cfg));
    expect(() => loadSdkConfig(p)).toThrow(/safe\.classifier\.model/);
  });

  it('rejects safe as non-object', () => {
    const cfg = { ...validConfig, safe: 'nope' };
    const p = write('safe-str.json', JSON.stringify(cfg));
    expect(() => loadSdkConfig(p)).toThrow(/safe/);
  });

  it('accepts config without safe', () => {
    const p = write('no-safe.json', JSON.stringify(validConfig));
    const result = loadSdkConfig(p);
    expect(result.safe).toBeUndefined();
  });
});

describe('loadSdkConfig — tools-common namespace', () => {
  it('accepts valid tools-common config', () => {
    const cfg = {
      ...validConfig,
      'tools-common': {
        tavily: { apiKey: 'tvly-xxx' },
        webFetch: { trustedDomains: ['github.com'] },
      },
    };
    const p = write('tc.json', JSON.stringify(cfg));
    const result = loadSdkConfig(p);
    expect(result['tools-common']!.tavily!.apiKey).toBe('tvly-xxx');
  });

  it('rejects tools-common.tavily.apiKey as non-string', () => {
    const cfg = { ...validConfig, 'tools-common': { tavily: { apiKey: 42 } } };
    const p = write('tc-bad.json', JSON.stringify(cfg));
    expect(() => loadSdkConfig(p)).toThrow(/tools-common\.tavily\.apiKey/);
  });

  it('rejects tools-common as non-object', () => {
    const cfg = { ...validConfig, 'tools-common': [] };
    const p = write('tc-arr.json', JSON.stringify(cfg));
    expect(() => loadSdkConfig(p)).toThrow(/tools-common/);
  });
});

describe('loadSdkConfig — observe namespace', () => {
  it('accepts valid observe config', () => {
    const cfg = {
      ...validConfig,
      observe: { dbPath: '/tmp/observe.db', retentionDays: 30, storeFullContent: true },
    };
    const p = write('obs.json', JSON.stringify(cfg));
    const result = loadSdkConfig(p);
    expect(result.observe!.dbPath).toBe('/tmp/observe.db');
    expect(result.observe!.retentionDays).toBe(30);
    expect(result.observe!.storeFullContent).toBe(true);
  });

  it('rejects observe.retentionDays as non-number', () => {
    const cfg = { ...validConfig, observe: { retentionDays: 'forever' } };
    const p = write('obs-bad.json', JSON.stringify(cfg));
    expect(() => loadSdkConfig(p)).toThrow(/observe\.retentionDays/);
  });

  it('rejects observe as non-object', () => {
    const cfg = { ...validConfig, observe: 42 };
    const p = write('obs-num.json', JSON.stringify(cfg));
    expect(() => loadSdkConfig(p)).toThrow(/observe/);
  });
});
