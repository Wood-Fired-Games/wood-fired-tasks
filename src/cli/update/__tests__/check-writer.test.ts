import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { writeUpdateCheck, triggerUpdateCheck } from '../check-writer.js';
import { getUpdateCheckPath } from '../../cache/paths.js';

// Hoisted mock state so the `update-notifier` module mock can read it.
const notifierState = vi.hoisted(() => ({
  update: undefined as { current: string; latest: string; type?: string } | undefined,
  calls: 0,
  pkgSeen: undefined as unknown,
}));

// Mock the real `update-notifier` dependency. The writer lazy-imports it via
// an indirect specifier; vitest's module registry still intercepts it.
vi.mock('update-notifier', () => {
  const factory = (opts: unknown) => {
    notifierState.calls += 1;
    notifierState.pkgSeen = (opts as { pkg?: unknown }).pkg;
    return { update: notifierState.update };
  };
  return { default: factory };
});

let origEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  origEnv = {
    WFT_CACHE_PATH: process.env.WFT_CACHE_PATH,
    WFT_NO_UPDATE_CHECK: process.env.WFT_NO_UPDATE_CHECK,
  };
  notifierState.update = undefined;
  notifierState.calls = 0;
  notifierState.pkgSeen = undefined;
  tmpDir = mkdtempSync(join(os.tmpdir(), 'wft-update-writer-'));
  // Isolate the cache to a temp dir so we never touch a real user cache.
  process.env.WFT_CACHE_PATH = tmpDir;
  delete process.env.WFT_NO_UPDATE_CHECK;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeUpdateCheck', () => {
  it('writes the update-available cache when a newer version exists', async () => {
    notifierState.update = { current: '1.0.0', latest: '2.0.0', type: 'major' };

    const wrote = await writeUpdateCheck({ isEnabled: () => true, currentVersion: '1.0.0' });

    expect(wrote).toBe(true);
    const cachePath = getUpdateCheckPath();
    expect(existsSync(cachePath)).toBe(true);

    const persisted = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(persisted.currentVersion).toBe('1.0.0');
    expect(persisted.latestVersion).toBe('2.0.0');
    expect(persisted.updateAvailable).toBe(true);
    expect(typeof persisted.fetchedAt).toBe('number');
  });

  it('reuses update-notifier (no new network/version-compare code)', async () => {
    notifierState.update = { current: '1.0.0', latest: '2.0.0' };

    await writeUpdateCheck({ isEnabled: () => true, currentVersion: '1.0.0' });

    // The mocked update-notifier factory was invoked with our pkg.
    expect(notifierState.calls).toBe(1);
    expect(notifierState.pkgSeen).toMatchObject({ name: 'wood-fired-tasks', version: '1.0.0' });
  });

  it('records updateAvailable=false when already on the latest version', async () => {
    notifierState.update = { current: '2.0.0', latest: '2.0.0' };

    const wrote = await writeUpdateCheck({ isEnabled: () => true, currentVersion: '2.0.0' });

    expect(wrote).toBe(true);
    const persisted = JSON.parse(readFileSync(getUpdateCheckPath(), 'utf8'));
    expect(persisted.updateAvailable).toBe(false);
  });

  it('is skipped entirely when disabled — no cache write, no notifier call', async () => {
    notifierState.update = { current: '1.0.0', latest: '2.0.0' };

    const wrote = await writeUpdateCheck({ isEnabled: () => false, currentVersion: '1.0.0' });

    expect(wrote).toBe(false);
    expect(notifierState.calls).toBe(0);
    expect(existsSync(getUpdateCheckPath())).toBe(false);
  });

  it('respects the real isUpdateCheckEnabled gate via WFT_NO_UPDATE_CHECK', async () => {
    process.env.WFT_NO_UPDATE_CHECK = '1';
    notifierState.update = { current: '1.0.0', latest: '2.0.0' };

    // No isEnabled override → uses the real resolver, which the env disables.
    const wrote = await writeUpdateCheck({ currentVersion: '1.0.0' });

    expect(wrote).toBe(false);
    expect(notifierState.calls).toBe(0);
    expect(existsSync(getUpdateCheckPath())).toBe(false);
  });

  it('best-effort: no update info leaves the prior cache untouched', async () => {
    // Seed a prior cache value the writer must NOT clobber.
    const cachePath = getUpdateCheckPath();
    const prior = JSON.stringify({
      currentVersion: '1.0.0',
      latestVersion: '1.5.0',
      updateAvailable: true,
      fetchedAt: 123,
    });
    writeFileSync(cachePath, prior);

    notifierState.update = undefined; // notifier knows of no newer version

    const wrote = await writeUpdateCheck({ isEnabled: () => true, currentVersion: '1.0.0' });

    expect(wrote).toBe(false);
    expect(readFileSync(cachePath, 'utf8')).toBe(prior);
  });

  it('best-effort: notifier throwing leaves the prior cache untouched and never throws', async () => {
    const cachePath = getUpdateCheckPath();
    const prior = JSON.stringify({
      currentVersion: '1.0.0',
      latestVersion: '1.5.0',
      updateAvailable: true,
      fetchedAt: 123,
    });
    writeFileSync(cachePath, prior);

    const wrote = await writeUpdateCheck({
      isEnabled: () => true,
      currentVersion: '1.0.0',
      fetchUpdateInfo: async () => {
        throw new Error('offline');
      },
    });

    expect(wrote).toBe(false);
    expect(readFileSync(cachePath, 'utf8')).toBe(prior);
  });
});

describe('triggerUpdateCheck', () => {
  it('is fire-and-forget and never throws even if the check rejects', () => {
    expect(() =>
      triggerUpdateCheck({
        isEnabled: () => true,
        currentVersion: '1.0.0',
        fetchUpdateInfo: async () => {
          throw new Error('boom');
        },
      }),
    ).not.toThrow();
  });
});
