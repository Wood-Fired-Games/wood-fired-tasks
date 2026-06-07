import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  chmodSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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

// Each test gets a fresh tmp dir so XDG_CONFIG_HOME or WFT_CREDENTIALS_PATH
// resolves into an isolated location — no cross-test bleed.
let tmpDir: string;
let origEnv: Record<string, string | undefined>;

const POSIX = process.platform !== 'win32';

function snapshotEnv() {
  return {
    WFT_CREDENTIALS_PATH: process.env.WFT_CREDENTIALS_PATH,
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
    token: 'wft_pat_ABCDEFG1234567890',
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
  tmpDir = mkdtempSync(join(tmpdir(), 'wft-creds-'));
  // Strip any env that could leak into getCredentialsPath / resolveAuth.
  delete process.env.WFT_CREDENTIALS_PATH;
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
  it('returns WFT_CREDENTIALS_PATH verbatim when set', () => {
    process.env.WFT_CREDENTIALS_PATH = '/var/secret/creds';
    expect(getCredentialsPath()).toBe('/var/secret/creds');
  });

  it('uses XDG_CONFIG_HOME when absolute', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-abs';
    expect(getCredentialsPath()).toBe('/tmp/xdg-abs/wood-fired-tasks/credentials');
  });

  it('falls through to $HOME/.config when XDG_CONFIG_HOME is relative (POSIX spec)', () => {
    process.env.XDG_CONFIG_HOME = 'relative-path';
    const expected = join(os.homedir(), '.config', 'wood-fired-tasks', 'credentials');
    expect(getCredentialsPath()).toBe(expected);
  });

  it('falls back to $HOME/.config when no env vars are set', () => {
    const expected = join(os.homedir(), '.config', 'wood-fired-tasks', 'credentials');
    expect(getCredentialsPath()).toBe(expected);
  });
});

describe('writeCredentials', () => {
  it('writes a TOML file with mode 0600 on POSIX', () => {
    const target = join(tmpDir, 'wood-fired-tasks', 'credentials');
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
    expect(body).toMatch(/^# Wood Fired Tasks CLI credentials/);
    expect(body).toContain('# Do NOT commit this file to version control.');
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

  it('is atomic: when rename fails, the target path stays absent and tmp is left behind', () => {
    // Force rename(2) to fail by making the target itself a non-empty
    // directory. POSIX rename of a regular file ONTO a non-empty dir fails
    // with ENOTEMPTY/EISDIR — exactly the "rename throws after tmp write"
    // codepath we want to exercise.
    const target = join(tmpDir, 'target-as-dir');
    mkdirSync(target, { recursive: true });
    // Drop a sentinel so the dir is non-empty (ENOTEMPTY on Linux).
    writeFileSync(join(target, 'sentinel'), 'x');

    expect(() => writeCredentials(sampleCreds, target)).toThrow();

    // Target is still a directory (untouched by the failed rename).
    expect(statSync(target).isDirectory()).toBe(true);
    // The tmp file SHOULD have been written to disk before the rename — that's
    // the contract: write-then-rename never leaves the final path corrupt.
    const tmps = readdirSync(dirname(target)).filter((n) => n.startsWith('target-as-dir.tmp.'));
    expect(tmps.length).toBeGreaterThanOrEqual(1);
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

  // WR-05 (Phase 30 review) — shape validation post-parse.
  describe('shape validation (WR-05)', () => {
    it('throws actionable error when [active] table is absent', () => {
      const target = join(tmpDir, 'no-active');
      writeFileSync(target, '# Hand-edited - removed the active block\n', { mode: 0o600 });
      if (POSIX) chmodSync(target, 0o600);
      expect(() => readCredentials(target)).toThrow(/invalid shape at `active`/);
      expect(() => readCredentials(target)).toThrow(/tasks login/);
    });

    it('throws when token is empty string', () => {
      const target = join(tmpDir, 'empty-token');
      writeFileSync(
        target,
        [
          '[active]',
          'token = ""',
          'token_id = 1',
          'server = "https://example.test"',
          'user_id = 1',
          'display_name = "X"',
          'email = "x@example.test"',
          'logged_in_at = "2026-05-23T00:00:00Z"',
        ].join('\n'),
        { mode: 0o600 },
      );
      if (POSIX) chmodSync(target, 0o600);
      expect(() => readCredentials(target)).toThrow(/invalid shape at `active\.token`/);
    });

    it('throws when token_id is not a positive integer', () => {
      const target = join(tmpDir, 'bad-token-id');
      writeFileSync(
        target,
        [
          '[active]',
          'token = "wft_pat_x"',
          'token_id = -3',
          'server = "https://example.test"',
          'user_id = 1',
          'display_name = "X"',
          'email = "x@example.test"',
          'logged_in_at = "2026-05-23T00:00:00Z"',
        ].join('\n'),
        { mode: 0o600 },
      );
      if (POSIX) chmodSync(target, 0o600);
      expect(() => readCredentials(target)).toThrow(/invalid shape at `active\.token_id`/);
    });

    it('throws when user_id is missing entirely', () => {
      const target = join(tmpDir, 'no-user-id');
      writeFileSync(
        target,
        [
          '[active]',
          'token = "wft_pat_x"',
          'token_id = 1',
          'server = "https://example.test"',
          // user_id intentionally omitted
          'display_name = "X"',
          'email = "x@example.test"',
          'logged_in_at = "2026-05-23T00:00:00Z"',
        ].join('\n'),
        { mode: 0o600 },
      );
      if (POSIX) chmodSync(target, 0o600);
      expect(() => readCredentials(target)).toThrow(/invalid shape at `active\.user_id`/);
    });

    it('accepts email = null (service-account / legacy user case)', () => {
      const target = join(tmpDir, 'null-email');
      writeFileSync(
        target,
        [
          '[active]',
          'token = "wft_pat_x"',
          'token_id = 1',
          'server = "https://example.test"',
          'user_id = 1',
          'display_name = "X"',
          // smol-toml encodes null as the absence of the key — we
          // write the canonical sample via writeCredentials so the
          // null is represented correctly.
        ].join('\n'),
        { mode: 0o600 },
      );
      // Use writeCredentials to produce a valid file with email=null
      // rather than hand-rolling the TOML.
      const validTarget = join(tmpDir, 'null-email-valid');
      writeCredentials(
        {
          active: {
            token: 'wft_pat_x',
            token_id: 1,
            server: 'https://example.test',
            user_id: 1,
            display_name: 'X',
            email: null,
            logged_in_at: '2026-05-23T00:00:00Z',
          },
        },
        validTarget,
      );
      const result = readCredentials(validTarget);
      expect(result?.active.email).toBeNull();
    });
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
    process.env.WFT_CREDENTIALS_PATH = join(tmpDir, 'creds');
    writeCredentials(sampleCreds, process.env.WFT_CREDENTIALS_PATH);
    process.env.API_KEY = 'legacykey';
    setTokenOverride('wft_pat_FLAG_OVERRIDE');
    const auth = await resolveAuth();
    expect(auth).toEqual({ kind: 'bearer', token: 'wft_pat_FLAG_OVERRIDE', origin: 'flag' });
  });

  it('credentials file is used when no override (kind=bearer, origin=file)', async () => {
    process.env.WFT_CREDENTIALS_PATH = join(tmpDir, 'creds');
    writeCredentials(sampleCreds, process.env.WFT_CREDENTIALS_PATH);
    process.env.API_KEY = 'legacykey';
    const auth = await resolveAuth();
    expect(auth).toEqual({ kind: 'bearer', token: sampleCreds.active.token, origin: 'file' });
  });

  it('ignores env.API_KEY: returns kind=none when only API_KEY is set (no override, no file)', async () => {
    // Bearer-PAT-only contract: the legacy API_KEY env var is no longer an
    // auth source.
    process.env.WFT_CREDENTIALS_PATH = join(tmpDir, 'missing-file');
    process.env.API_KEY = 'legacykey';
    const auth = await resolveAuth();
    expect(auth).toEqual({ kind: 'none' });
  });

  it('returns kind=none when nothing is set', async () => {
    process.env.WFT_CREDENTIALS_PATH = join(tmpDir, 'missing-file');
    const auth = await resolveAuth();
    expect(auth).toEqual({ kind: 'none' });
  });

  it('propagates readCredentials errors (does not fall through to env)', async () => {
    process.env.WFT_CREDENTIALS_PATH = join(tmpDir, 'broken');
    writeFileSync(process.env.WFT_CREDENTIALS_PATH, 'this is = not valid toml [[[', {
      mode: 0o600,
    });
    if (POSIX) chmodSync(process.env.WFT_CREDENTIALS_PATH, 0o600);
    process.env.API_KEY = 'should-not-be-used';
    await expect(resolveAuth()).rejects.toThrow(/malformed TOML/);
  });
});
