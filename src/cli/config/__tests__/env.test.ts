import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCredentials } from '../../auth/credentials.js';
import type { Credentials } from '../../auth/credentials.js';
import { env } from '../env.js';

/**
 * Task #1605 — base-URL precedence pin. Before this fix, `env.API_BASE_URL`
 * only ever consulted `API_BASE_URL`/the localhost default and IGNORED
 * `credentials.active.server`, so after a `tasks setup --local`/`--remote`
 * mode conversion the CLI data plane (this getter) and `tasks whoami`
 * (reads credentials.active.server directly) could report two different
 * servers — the split-brain bug. These tests pin the full chain:
 *   explicit env (incl. .env) > credentials.active.server > localhost default.
 */

let tmpDir: string;
let origEnv: Record<string, string | undefined>;

const sampleCreds: Credentials = {
  active: {
    token: 'wft_pat_ENV_TEST_TOKEN',
    token_id: 1,
    server: 'https://tasks.example.com',
    user_id: 1,
    display_name: 'Test User',
    email: 'test@example.com',
    logged_in_at: '2026-01-01T00:00:00Z',
  },
};

function snapshotEnv() {
  return {
    API_BASE_URL: process.env['API_BASE_URL'],
    WFT_CREDENTIALS_PATH: process.env['WFT_CREDENTIALS_PATH'],
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
  };
}

function restoreEnv(snap: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('env.API_BASE_URL precedence (task #1605)', () => {
  beforeEach(() => {
    origEnv = snapshotEnv();
    tmpDir = mkdtempSync(join(tmpdir(), 'wft-env-baseurl-'));
    // Route the credentials lookup into a per-test tmp dir so a real
    // developer machine's ~/.config/wood-fired-tasks/credentials never
    // leaks into these assertions.
    process.env['WFT_CREDENTIALS_PATH'] = join(tmpDir, 'credentials');
    delete process.env['API_BASE_URL'];
  });

  afterEach(() => {
    restoreEnv(origEnv);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('defaults to http://localhost:3000 when neither env nor credentials are present', () => {
    expect(env.API_BASE_URL).toBe('http://localhost:3000');
  });

  it('uses credentials.active.server when API_BASE_URL is unset (closes the split-brain bug)', () => {
    writeCredentials(sampleCreds);
    expect(env.API_BASE_URL).toBe('https://tasks.example.com');
  });

  it('API_BASE_URL env wins over credentials.active.server', () => {
    writeCredentials(sampleCreds);
    process.env['API_BASE_URL'] = 'http://env-wins.example:9999';
    expect(env.API_BASE_URL).toBe('http://env-wins.example:9999');
  });

  it('a checked-out .env-sourced API_BASE_URL still beats credentials.active.server', () => {
    // env.ts's dotenv.config() call populates process.env from a checked-out
    // .env at import time (only for keys not already set) — from this
    // getter's perspective a .env-sourced value and a real shell export are
    // indistinguishable, and both are an "explicit env source" that must
    // outrank the credentials file (which merely remembers the last login).
    writeCredentials(sampleCreds);
    process.env['API_BASE_URL'] = 'http://localhost:3000'; // e.g. .env.example's default
    expect(env.API_BASE_URL).toBe('http://localhost:3000');
  });

  it('falls back to the default when the credentials file is malformed (does not throw)', () => {
    writeFileSync(process.env['WFT_CREDENTIALS_PATH'] as string, 'not valid toml [[[', {
      mode: 0o600,
    });
    expect(() => env.API_BASE_URL).not.toThrow();
    expect(env.API_BASE_URL).toBe('http://localhost:3000');
  });

  it('re-resolves on each access (picks up a credentials file written mid-run)', () => {
    expect(env.API_BASE_URL).toBe('http://localhost:3000');
    writeCredentials(sampleCreds);
    expect(env.API_BASE_URL).toBe('https://tasks.example.com');
  });
});
