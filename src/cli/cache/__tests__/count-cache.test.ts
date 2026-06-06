import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { getCountCachePath, getUpdateCheckPath } from '../paths.js';
import {
  readTtl,
  writeAtomic,
  readCountCache,
  writeCountCache,
  readUpdateCache,
  writeUpdateCache,
  type CountCache,
} from '../count-cache.js';

// Isolate the whole module under a per-test tmpdir by pointing
// WFT_CACHE_PATH at it (paths.ts honours that env verbatim). This keeps the
// real ~/.cache untouched and lets us assert on the exact on-disk layout.
let tmpDir: string;
let origCachePath: string | undefined;

beforeEach(() => {
  origCachePath = process.env.WFT_CACHE_PATH;
  tmpDir = mkdtempSync(join(os.tmpdir(), 'wft-count-cache-'));
  process.env.WFT_CACHE_PATH = tmpDir;
});

afterEach(() => {
  if (origCachePath === undefined) delete process.env.WFT_CACHE_PATH;
  else process.env.WFT_CACHE_PATH = origCachePath;
  rmSync(tmpDir, { recursive: true, force: true });
});

const TTL = 60_000; // 60s

describe('readTtl freshness', () => {
  const file = () => join(tmpDir, 'generic.json');

  it("returns 'fresh' when fetchedAt is within the TTL", () => {
    const now = 1_000_000;
    writeAtomic(file(), { a: 1 }, now);
    const r = readTtl<{ a: number; fetchedAt: number }>(file(), TTL, now + 30_000);
    expect(r.state).toBe('fresh');
    if (r.state === 'fresh') {
      expect(r.value.a).toBe(1);
      expect(r.ageMs).toBe(30_000);
    }
  });

  it("returns 'fresh' exactly at the TTL boundary", () => {
    const now = 1_000_000;
    writeAtomic(file(), { a: 1 }, now);
    const r = readTtl(file(), TTL, now + TTL);
    expect(r.state).toBe('fresh');
  });

  it("returns 'stale' when fetchedAt is older than the TTL", () => {
    const now = 1_000_000;
    writeAtomic(file(), { a: 1 }, now);
    const r = readTtl<{ a: number; fetchedAt: number }>(file(), TTL, now + TTL + 1);
    expect(r.state).toBe('stale');
    if (r.state === 'stale') {
      expect(r.value.a).toBe(1);
      expect(r.ageMs).toBe(TTL + 1);
    }
  });

  it("returns 'missing' when the file does not exist", () => {
    const r = readTtl(join(tmpDir, 'nope.json'), TTL);
    expect(r.state).toBe('missing');
  });

  it("returns 'missing' (never throws) on malformed JSON", () => {
    const f = file();
    writeFileSync(f, '{ this is not: valid json', 'utf8');
    expect(() => readTtl(f, TTL)).not.toThrow();
    expect(readTtl(f, TTL).state).toBe('missing');
  });

  it("returns 'missing' when fetchedAt is absent or non-numeric", () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ a: 1 }), 'utf8');
    expect(readTtl(f, TTL).state).toBe('missing');
    writeFileSync(f, JSON.stringify({ a: 1, fetchedAt: 'soon' }), 'utf8');
    expect(readTtl(f, TTL).state).toBe('missing');
  });
});

describe('writeAtomic durability', () => {
  it('writes a sibling .tmp file then renames onto the final path', () => {
    const f = join(tmpDir, 'sub', 'atomic.json');
    writeAtomic(f, { hello: 'world' }, 42);

    // Final file present, contains stamped envelope.
    expect(existsSync(f)).toBe(true);
    const onDisk = JSON.parse(readFileSync(f, 'utf8'));
    expect(onDisk).toEqual({ hello: 'world', fetchedAt: 42 });

    // No .tmp residue left behind after a successful rename.
    const leftovers = readdirSync(join(tmpDir, 'sub')).filter((n) => n.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('stamps fetchedAt from the injected clock and returns the envelope', () => {
    const env = writeAtomic(join(tmpDir, 'stamp.json'), { x: 9 }, 12345);
    expect(env).toEqual({ x: 9, fetchedAt: 12345 });
  });
});

describe('count-cache typed wrappers', () => {
  const projectKey = 'proj/with:weird*chars';

  it('round-trips fresh through getCountCachePath', () => {
    const now = 5_000_000;
    const written = writeCountCache(
      projectKey,
      { projectId: 7, projectName: 'Demo', open: 3, doneClosed: 11 },
      now,
    );
    expect(written.fetchedAt).toBe(now);

    // Verify it landed at the sanitized count-cache path under the tmpdir.
    const expectedPath = getCountCachePath(projectKey);
    expect(expectedPath.startsWith(tmpDir)).toBe(true);
    expect(existsSync(expectedPath)).toBe(true);

    const r = readCountCache(projectKey, TTL, now + 1000);
    expect(r.state).toBe('fresh');
    if (r.state === 'fresh') {
      const v: CountCache = r.value;
      expect(v.open).toBe(3);
      expect(v.doneClosed).toBe(11);
      expect(v.projectName).toBe('Demo');
    }
  });

  it('reports stale past the TTL and missing for an unknown key', () => {
    const now = 5_000_000;
    writeCountCache(projectKey, { projectId: 7, projectName: 'Demo', open: 1, doneClosed: 0 }, now);
    expect(readCountCache(projectKey, TTL, now + TTL + 1).state).toBe('stale');
    expect(readCountCache('never-written', TTL, now).state).toBe('missing');
  });

  it("returns 'missing' on a corrupt count-cache file", () => {
    writeCountCache(projectKey, { projectId: 7, projectName: 'Demo', open: 1, doneClosed: 0 });
    writeFileSync(getCountCachePath(projectKey), 'not json at all', 'utf8');
    expect(readCountCache(projectKey, TTL).state).toBe('missing');
  });
});

describe('v2.0 rollup: update-available cache shares the same TTL engine', () => {
  it('round-trips the update cache via getUpdateCheckPath', () => {
    const now = 9_000_000;
    const written = writeUpdateCache(
      { latestVersion: '2.1.0', currentVersion: '2.0.0', updateAvailable: true },
      now,
    );
    expect(written.fetchedAt).toBe(now);

    const expectedPath = getUpdateCheckPath();
    expect(expectedPath.startsWith(tmpDir)).toBe(true);
    expect(existsSync(expectedPath)).toBe(true);

    const r = readUpdateCache(TTL, now + 5000);
    expect(r.state).toBe('fresh');
    if (r.state === 'fresh') {
      expect(r.value.updateAvailable).toBe(true);
      expect(r.value.latestVersion).toBe('2.1.0');
    }

    // Stale + corrupt paths share the count-cache behaviour (same engine).
    expect(readUpdateCache(TTL, now + TTL + 1).state).toBe('stale');
    writeFileSync(expectedPath, '<<corrupt>>', 'utf8');
    expect(readUpdateCache(TTL).state).toBe('missing');
  });

  it('keeps count and update caches in distinct files', () => {
    writeCountCache('k', { projectId: 1, projectName: 'N', open: 0, doneClosed: 0 });
    writeUpdateCache({ latestVersion: '1.0.0', currentVersion: '1.0.0', updateAvailable: false });
    expect(getCountCachePath('k')).not.toBe(getUpdateCheckPath());
    expect(existsSync(getCountCachePath('k'))).toBe(true);
    expect(existsSync(getUpdateCheckPath())).toBe(true);
  });
});
