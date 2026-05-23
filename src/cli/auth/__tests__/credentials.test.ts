import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import os from 'node:os';

import {
  getCredentialsPath,
  readCredentials,
  writeCredentials,
  deleteCredentials,
  setTokenOverride,
  resolveAuth,
  type Credentials,
} from '../credentials.js';

// Each test gets a fresh tmp dir so XDG_CONFIG_HOME or WFB_CREDENTIALS_PATH
// resolves into an isolated location — no cross-test bleed.
let tmpDir: string;
let origEnv: Record<string, string | undefined>;

const POSIX = process.platform !== 'win32';

function snapshotEnv() {
  return {
    WFB_CREDENTIALS_PATH: process.env.WFB_CREDENTIALS_PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    API_KEY: process.env.API_KEY,
    HOME: process.env.HOME,
  };
}

function restoreEnv(snap: typeof origEnv) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const sampleCreds: Credentials = {
  active: {
    token: 'wfb_pat_ABCDEFG1234567890',
    token_id: 17,
    server: 'https://woodfiredbugs.local',
    user_id: 1,
    display_name: 'Stuart Jeff',
    email: 'stuart@woodfiredgames.com',
    logged_in_at: '2026-05-23T12:34:56Z',
  },
};

beforeEach(() => {
  origEnv = snapshotEnv();
  tmpDir = mkdtempSync(join(tmpdir(), 'wfb-creds-'));
  // Strip any env that could leak into getCredentialsPath / resolveAuth.
  delete process.env.WFB_CREDENTIALS_PATH;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.API_KEY;
  setTokenOverride(null);
});

afterEach(() => {
  setTokenOverride(null);
  restoreEnv(origEnv);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('getCredentialsPath', () => {
  it('returns WFB_CREDENTIALS_PATH verbatim when set', () => {
    process.env.WFB_CREDENTIALS_PATH = '/var/secret/creds';
    expect(getCredentialsPath()).toBe('/var/secret/creds');
  });

  it('uses XDG_CONFIG_HOME when absolute', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-abs';
    expect(getCredentialsPath()).toBe('/tmp/xdg-abs/wood-fired-bugs/credentials');
  });

  it('falls through to $HOME/.config when XDG_CONFIG_HOME is relative (POSIX spec)', () => {
    process.env.XDG_CONFIG_HOME = 'relative-path';
    const expected = join(os.homedir(), '.config', 'wood-fired-bugs', 'credentials');
    expect(getCredentialsPath()).toBe(expected);
  });

  it('falls back to $HOME/.config when no env vars are set', () => {
    const expected = join(os.homedir(), '.config', 'wood-fired-bugs', 'credentials');
    expect(getCredentialsPath()).toBe(expected);
  });
});

describe('writeCredentials', () => {
  it('writes a TOML file with mode 0600 on POSIX', () => {
    const target = join(tmpDir, 'wood-fired-bugs', 'credentials');
    writeCredentials(sampleCreds, target);
    expect(existsSync(target)).toBe(true);
    if (POSIX) {
      const mode = statSync(target).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('writes a leading comment block before the [active] table', () => {
    const target = join(tmpDir, 'cred-with-header');
    writeCredentials(sampleCreds, target);
    const body = readFileSync(target, 'utf8');
    expect(body).toMatch(/^# Wood Fired Bugs CLI credentials/);
    expect(body).toContain("# Do NOT commit this file to version control.");
    expect(body).toContain('[active]');
  });

  it('round-trips through readCredentials', () => {
    const target = join(tmpDir, 'roundtrip');
    writeCredentials(sampleCreds, target);
    const got = readCredentials(target);
    expect(got).not.toBeNull();
    expect(got!.active.token).toBe(sampleCreds.active.token);
    expect(got!.active.token_id).toBe(sampleCreds.active.token_id);
    expect(got!.active.server).toBe(sampleCreds.active.server);
    expect(got!.active.user_id).toBe(sampleCreds.active.user_id);
    expect(got!.active.display_name).toBe(sampleCreds.active.display_name);
    expect(got!.active.email).toBe(sampleCreds.active.email);
    expect(got!.active.logged_in_at).toBe(sampleCreds.active.logged_in_at);
  });

  it('creates parent directories if missing', () => {
    const target = join(tmpDir, 'nested', 'deeper', 'creds');
    writeCredentials(sampleCreds, target);
    expect(existsSync(target)).toBe(true);
  });

  it('is atomic: when rename fails, the target path stays absent', () => {
    const target = join(tmpDir, 'atomic-creds');
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated rename failure');
    });
    try {
      expect(() => writeCredentials(sampleCreds, target)).toThrow(/rename/);
      expect(existsSync(target)).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
  });
});

describe('readCredentials', () => {
  it('returns null when file does not exist', () => {
    expect(readCredentials(join(tmpDir, 'does-not-exist'))).toBeNull();
  });

  it.skipIf(!POSIX)('throws on insecure permissions (mode 0644)', () => {
    const target = join(tmpDir, 'insecure');
    writeFileSync(target, '[active]\ntoken = "x"\n', { mode: 0o644 });
    chmodSync(target, 0o644);
    expect(() => readCredentials(target)).toThrow(/insecure permissions/);
  });

  it('throws a clear error on malformed TOML', () => {
    const target = join(tmpDir, 'broken');
    writeFileSync(target, 'this is = not valid toml [[[', { mode: 0o600 });
    if (POSIX) chmodSync(target, 0o600);
    expect(() => readCredentials(target)).toThrow(/malformed TOML/);
  });
});

describe('deleteCredentials', () => {
  it('returns false (no throw) when file is absent', () => {
    expect(deleteCredentials(join(tmpDir, 'never-existed'))).toBe(false);
  });

  it('returns true and removes the file when present', () => {
    const target = join(tmpDir, 'will-delete');
    writeCredentials(sampleCreds, target);
    expect(existsSync(target)).toBe(true);
    expect(deleteCredentials(target)).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});

describe('resolveAuth precedence', () => {
  it('--token override wins (kind=bearer, origin=flag)', async () => {
    process.env.WFB_CREDENTIALS_PATH = join(tmpDir, 'creds');
    writeCredentials(sampleCreds, process.env.WFB_CREDENTIALS_PATH);
    process.env.API_KEY = 'legacykey';
    setTokenOverride('wfb_pat_FLAG_OVERRIDE');
    const auth = await resolveAuth();
    expect(auth).toEqual({ kind: 'bearer', token: 'wfb_pat_FLAG_OVERRIDE', origin: 'flag' });
  });

  it('credentials file is used when no override (kind=bearer, origin=file)', async () => {
    process.env.WFB_CREDENTIALS_PATH = join(tmpDir, 'creds');
    writeCredentials(sampleCreds, process.env.WFB_CREDENTIALS_PATH);
    process.env.API_KEY = 'legacykey';
    const auth = await resolveAuth();
    expect(auth).toEqual({ kind: 'bearer', token: sampleCreds.active.token, origin: 'file' });
  });

  it('falls back to env.API_KEY when no override and no file (kind=legacy)', async () => {
    process.env.WFB_CREDENTIALS_PATH = join(tmpDir, 'missing-file');
    process.env.API_KEY = 'legacykey';
    const auth = await resolveAuth();
    expect(auth).toEqual({ kind: 'legacy', key: 'legacykey' });
  });

  it('returns kind=none when nothing is set', async () => {
    process.env.WFB_CREDENTIALS_PATH = join(tmpDir, 'missing-file');
    const auth = await resolveAuth();
    expect(auth).toEqual({ kind: 'none' });
  });

  it('propagates readCredentials errors (does not fall through to env)', async () => {
    process.env.WFB_CREDENTIALS_PATH = join(tmpDir, 'broken');
    writeFileSync(process.env.WFB_CREDENTIALS_PATH, 'this is = not valid toml [[[', { mode: 0o600 });
    if (POSIX) chmodSync(process.env.WFB_CREDENTIALS_PATH, 0o600);
    process.env.API_KEY = 'should-not-be-used';
    await expect(resolveAuth()).rejects.toThrow(/malformed TOML/);
  });
});
