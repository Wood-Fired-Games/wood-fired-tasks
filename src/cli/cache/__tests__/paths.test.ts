import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';

import { getCacheDir, getCountCachePath, getUpdateCheckPath } from '../paths.js';

// Each test runs against a stubbed os.homedir() + a clean env so the
// three precedence branches resolve deterministically with no
// cross-test bleed. Mirrors the env-snapshot style of
// src/cli/auth/__tests__/credentials.test.ts.
const STUB_HOME = '/home/stub-user';

let origEnv: Record<string, string | undefined>;

function snapshotEnv() {
  return {
    WFT_CACHE_PATH: process.env.WFT_CACHE_PATH,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    HOME: process.env.HOME,
  };
}

function restoreEnv(snap: typeof origEnv) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  origEnv = snapshotEnv();
  // Strip any env that could leak into getCacheDir.
  delete process.env.WFT_CACHE_PATH;
  delete process.env.XDG_CACHE_HOME;
  // Stub os.homedir() so the ~/.cache fallback is deterministic and
  // independent of the machine running the suite.
  vi.spyOn(os, 'homedir').mockReturnValue(STUB_HOME);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(origEnv);
});

describe('getCacheDir precedence', () => {
  it('returns WFT_CACHE_PATH verbatim when set and non-empty', () => {
    process.env.WFT_CACHE_PATH = '/var/custom/cache';
    expect(getCacheDir()).toBe('/var/custom/cache');
  });

  it('ignores an empty WFT_CACHE_PATH and falls through', () => {
    process.env.WFT_CACHE_PATH = '';
    expect(getCacheDir()).toBe(join(STUB_HOME, '.cache', 'wood-fired-tasks'));
  });

  it('uses $XDG_CACHE_HOME/wood-fired-tasks when XDG_CACHE_HOME is absolute', () => {
    process.env.XDG_CACHE_HOME = '/tmp/xdg-cache-abs';
    expect(getCacheDir()).toBe('/tmp/xdg-cache-abs/wood-fired-tasks');
  });

  it('falls through to ~/.cache when XDG_CACHE_HOME is relative (XDG spec)', () => {
    process.env.XDG_CACHE_HOME = 'relative-cache';
    expect(getCacheDir()).toBe(join(STUB_HOME, '.cache', 'wood-fired-tasks'));
  });

  it('falls back to ~/.cache/wood-fired-tasks when no env vars are set', () => {
    expect(getCacheDir()).toBe(join(STUB_HOME, '.cache', 'wood-fired-tasks'));
  });

  it('override env wins over an absolute XDG_CACHE_HOME', () => {
    process.env.WFT_CACHE_PATH = '/override/wins';
    process.env.XDG_CACHE_HOME = '/tmp/xdg-cache-abs';
    expect(getCacheDir()).toBe('/override/wins');
  });
});

describe('getCountCachePath', () => {
  it('returns a per-project count file under the resolved cache dir', () => {
    process.env.XDG_CACHE_HOME = '/tmp/xdg-cache-abs';
    expect(getCountCachePath('42')).toBe('/tmp/xdg-cache-abs/wood-fired-tasks/count-42.json');
  });

  it('honors the override env for the count path too', () => {
    process.env.WFT_CACHE_PATH = '/override/wins';
    expect(getCountCachePath('proj')).toBe('/override/wins/count-proj.json');
  });

  it('sanitizes path separators and traversal in the project key', () => {
    process.env.WFT_CACHE_PATH = '/override/wins';
    // `../etc` and embedded slashes must not escape the cache dir.
    const p = getCountCachePath('../etc/passwd');
    expect(p).toBe('/override/wins/count-.._etc_passwd.json');
  });
});

describe('getUpdateCheckPath', () => {
  it('returns the sibling update-available cache path under the same dir', () => {
    process.env.XDG_CACHE_HOME = '/tmp/xdg-cache-abs';
    expect(getUpdateCheckPath()).toBe('/tmp/xdg-cache-abs/wood-fired-tasks/update-check.json');
  });

  it('sits beside the count cache under the same resolved dir', () => {
    process.env.WFT_CACHE_PATH = '/override/wins';
    expect(getUpdateCheckPath()).toBe('/override/wins/update-check.json');
    expect(getCountCachePath('x')).toBe('/override/wins/count-x.json');
  });

  it('falls back to ~/.cache when no env is set', () => {
    expect(getUpdateCheckPath()).toBe(
      join(STUB_HOME, '.cache', 'wood-fired-tasks', 'update-check.json'),
    );
  });
});
