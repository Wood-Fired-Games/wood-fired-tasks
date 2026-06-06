import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  isUpdateCheckEnabled,
  getConfigPath,
  readUpdateCheckFlag,
  setUpdateCheckFlag,
  UPDATE_CHECK_ENV,
} from '../update-check.js';

// Env-snapshot + temp-config-dir style mirrored from
// src/cli/auth/__tests__/credentials.test.ts and
// src/cli/cache/__tests__/paths.test.ts.
const STUB_HOME = '/home/stub-user';

let origEnv: Record<string, string | undefined>;
let tmpDir: string;

function snapshotEnv() {
  return {
    WFT_NO_UPDATE_CHECK: process.env.WFT_NO_UPDATE_CHECK,
    WFT_CONFIG_PATH: process.env.WFT_CONFIG_PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
  };
}

function restoreEnv(snap: typeof origEnv) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Write a config file with the given update_check value and point the
 *  resolver at it via WFT_CONFIG_PATH. Returns the file path. */
function writeFlag(value: boolean | string): string {
  const file = join(tmpDir, 'config');
  writeFileSync(file, `update_check = ${value}\n`);
  process.env.WFT_CONFIG_PATH = file;
  return file;
}

beforeEach(() => {
  origEnv = snapshotEnv();
  delete process.env.WFT_NO_UPDATE_CHECK;
  delete process.env.WFT_CONFIG_PATH;
  delete process.env.XDG_CONFIG_HOME;
  vi.spyOn(os, 'homedir').mockReturnValue(STUB_HOME);
  tmpDir = mkdtempSync(join(os.tmpdir(), 'wft-update-check-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(origEnv);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('isUpdateCheckEnabled — default ON', () => {
  it('returns true when no env and no config flag set', () => {
    process.env.WFT_CONFIG_PATH = join(tmpDir, 'does-not-exist');
    expect(isUpdateCheckEnabled()).toBe(true);
  });

  it('returns true when the config flag is explicitly update_check = true', () => {
    writeFlag(true);
    expect(isUpdateCheckEnabled()).toBe(true);
  });
});

describe('isUpdateCheckEnabled — config flag off-switch', () => {
  it('returns false when config flag update_check = false', () => {
    writeFlag(false);
    expect(isUpdateCheckEnabled()).toBe(false);
  });

  it('ignores a malformed config file and falls back to default ON', () => {
    const file = join(tmpDir, 'config');
    writeFileSync(file, 'this is = not [ valid toml');
    process.env.WFT_CONFIG_PATH = file;
    expect(isUpdateCheckEnabled()).toBe(true);
  });

  it('ignores a non-boolean update_check value (default ON)', () => {
    writeFlag('"false"'); // string, not boolean
    expect(isUpdateCheckEnabled()).toBe(true);
  });
});

describe('isUpdateCheckEnabled — env off-switch', () => {
  it('returns false when WFT_NO_UPDATE_CHECK=1', () => {
    process.env[UPDATE_CHECK_ENV] = '1';
    process.env.WFT_CONFIG_PATH = join(tmpDir, 'does-not-exist');
    expect(isUpdateCheckEnabled()).toBe(false);
  });

  it.each(['true', 'yes', 'on', 'TRUE', ' 1 '])('treats %j as a truthy off-switch', (val) => {
    process.env[UPDATE_CHECK_ENV] = val;
    process.env.WFT_CONFIG_PATH = join(tmpDir, 'does-not-exist');
    expect(isUpdateCheckEnabled()).toBe(false);
  });
});

describe('isUpdateCheckEnabled — precedence (env wins)', () => {
  it('env truthy disables even when config flag is true', () => {
    writeFlag(true);
    process.env[UPDATE_CHECK_ENV] = '1';
    expect(isUpdateCheckEnabled()).toBe(false);
  });

  it('env falsy ("0") forces ON even when config flag is false', () => {
    writeFlag(false);
    process.env[UPDATE_CHECK_ENV] = '0';
    expect(isUpdateCheckEnabled()).toBe(true);
  });

  it('env falsy ("false") forces ON even when config flag is false', () => {
    writeFlag(false);
    process.env[UPDATE_CHECK_ENV] = 'false';
    expect(isUpdateCheckEnabled()).toBe(true);
  });

  it('unset env defers to config flag', () => {
    writeFlag(false);
    delete process.env[UPDATE_CHECK_ENV];
    expect(isUpdateCheckEnabled()).toBe(false);
  });
});

describe('getConfigPath precedence', () => {
  it('returns WFT_CONFIG_PATH verbatim when set', () => {
    process.env.WFT_CONFIG_PATH = '/custom/cfg';
    expect(getConfigPath()).toBe('/custom/cfg');
  });

  it('uses $XDG_CONFIG_HOME/wood-fired-tasks/config when absolute', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-cfg-abs';
    expect(getConfigPath()).toBe('/tmp/xdg-cfg-abs/wood-fired-tasks/config');
  });

  it('falls back to ~/.config/wood-fired-tasks/config', () => {
    expect(getConfigPath()).toBe(join(STUB_HOME, '.config', 'wood-fired-tasks', 'config'));
  });
});

describe('readUpdateCheckFlag', () => {
  it('returns undefined when the file does not exist', () => {
    expect(readUpdateCheckFlag(join(tmpDir, 'nope'))).toBeUndefined();
  });

  it('returns the boolean when present', () => {
    const file = writeFlag(false);
    expect(readUpdateCheckFlag(file)).toBe(false);
  });
});

describe('setUpdateCheckFlag writer (round-trip)', () => {
  it('persists the flag so the resolver reads it back', () => {
    const file = join(tmpDir, 'config');
    setUpdateCheckFlag(false, file);
    expect(readUpdateCheckFlag(file)).toBe(false);
    process.env.WFT_CONFIG_PATH = file;
    expect(isUpdateCheckEnabled()).toBe(false);

    setUpdateCheckFlag(true, file);
    expect(isUpdateCheckEnabled()).toBe(true);
  });

  it('preserves other keys in the config file', () => {
    const file = join(tmpDir, 'config');
    writeFileSync(file, 'some_other = "keep me"\n');
    setUpdateCheckFlag(false, file);
    expect(readUpdateCheckFlag(file)).toBe(false);
    // The unrelated key must survive the write.
    expect(readFileSync(file, 'utf8')).toContain('some_other');
  });
});
