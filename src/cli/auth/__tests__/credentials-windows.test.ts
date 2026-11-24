/**
 * Credentials file access on Windows (WFT #2609).
 *
 * On Windows the credentials file is limited to its owner with `icacls`
 * (POSIX mode bits do not apply there). These tests cover the command
 * construction directly, and the write path by simulating `win32` with a
 * mocked `execFileSync`. They do not run `icacls` itself.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerOnlyAclArgs, windowsAccountName } from '../owner-only-file.js';
import type { Credentials } from '../credentials.js';

const CREDS: Credentials = {
  active: {
    token: 'wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
    token_id: 7,
    server: 'https://tasks.example.com',
    user_id: 3,
    display_name: 'Someone',
    email: null,
    logged_in_at: '2026-11-24T00:00:00.000Z',
  },
};

describe('ownerOnlyAclArgs', () => {
  it('removes inherited entries and grants full control to the account alone', () => {
    expect(ownerOnlyAclArgs('C:\\Users\\a\\credentials.tmp', 'HOST\\a')).toEqual([
      'C:\\Users\\a\\credentials.tmp',
      '/inheritance:r',
      '/grant:r',
      'HOST\\a:F',
    ]);
  });

  it('passes a path with spaces as one argument (no shell quoting involved)', () => {
    const args = ownerOnlyAclArgs('C:\\Users\\A B\\cred file', 'A B');
    expect(args[0]).toBe('C:\\Users\\A B\\cred file');
    expect(args[3]).toBe('A B:F');
  });

  it('refuses an empty account name', () => {
    expect(() => ownerOnlyAclArgs('C:\\x', '')).toThrow(/account/);
  });
});

describe('windowsAccountName', () => {
  it('uses DOMAIN\\user when USERDOMAIN and USERNAME are set', () => {
    expect(windowsAccountName({ USERDOMAIN: 'HOST', USERNAME: 'a' }, 'fallback')).toBe('HOST\\a');
  });

  it('falls back to the OS user name when the environment has none', () => {
    expect(windowsAccountName({}, 'fallback')).toBe('fallback');
  });
});

describe('writeCredentials on Windows (simulated)', () => {
  const realPlatform = process.platform;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wft-cred-win-'));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.doUnmock('node:child_process');
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  async function loadAsWindows(execFileSync: (...args: unknown[]) => unknown) {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      execFileSync,
    }));
    return import('../credentials.js');
  }

  it('limits the file to its owner before the token is written, then moves it into place', async () => {
    const target = path.join(dir, 'credentials');
    const calls: { cmd: unknown; args: string[]; contentAtCall: string }[] = [];
    const exec = vi.fn((cmd: unknown, args: unknown) => {
      const a = args as string[];
      calls.push({ cmd, args: a, contentAtCall: readFileSync(a[0] as string, 'utf8') });
      return Buffer.from('');
    });
    const { writeCredentials } = await loadAsWindows(exec);

    writeCredentials(CREDS, target);

    expect(calls).toHaveLength(1);
    const call = calls[0] as (typeof calls)[number];
    expect(call.cmd).toBe('icacls');
    expect(call.args[0]).not.toBe(target);
    expect(path.dirname(call.args[0] as string)).toBe(dir);
    expect(call.args.slice(1, 3)).toEqual(['/inheritance:r', '/grant:r']);
    expect(call.args[3]).toMatch(/:F$/);
    // Nothing secret was on disk when access was limited.
    expect(call.contentAtCall).not.toContain(CREDS.active.token);
    expect(readFileSync(target, 'utf8')).toContain(CREDS.active.token);
    expect(readdirSync(dir)).toEqual(['credentials']);
  });

  it('refuses to write the token when access cannot be limited, and leaves no file behind', async () => {
    const target = path.join(dir, 'credentials');
    const exec = vi.fn(() => {
      throw new Error('icacls failed');
    });
    const { writeCredentials } = await loadAsWindows(exec);

    expect(() => writeCredentials(CREDS, target)).toThrow(/owner/i);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('writeCredentials on POSIX', () => {
  it.runIf(process.platform !== 'win32')('never runs icacls', async () => {
    vi.resetModules();
    const exec = vi.fn();
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      execFileSync: exec,
    }));
    const { writeCredentials } = await import('../credentials.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wft-cred-posix-'));
    try {
      writeCredentials(CREDS, path.join(dir, 'credentials'));
      expect(exec).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
