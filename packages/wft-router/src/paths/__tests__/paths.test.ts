/**
 * Tests for the cross-platform default path resolver.
 *
 * Coverage targets (per task #423 AC):
 *   - Linux, darwin, win32 branches with mocked env (no real filesystem
 *     access — pure resolver only).
 *   - Resolver returns absolute paths for `config`, `data`, `state` on
 *     every platform branch.
 *   - Env-var overrides (`WFT_ROUTER_CONFIG`, `WFT_ROUTER_DATA_DIR`,
 *     `WFT_ROUTER_STATE_DIR`) win over defaults when absolute, and are
 *     ignored when relative.
 *   - BSD (`freebsd`) is treated as XDG-shaped, same as Linux.
 *
 * Vendor-neutrality: no provider/AI/chat/CI name appears in fixtures or
 * test descriptions.
 */

import { join, posix, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePaths } from '../index.js';

/** Convenience: the directory name baked into every default. */
const APP_DIR = 'wft-router';

describe('resolvePaths — Linux (XDG)', () => {
  const linuxHome = '/home/operator';

  it('returns XDG fallbacks when env is empty', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: {},
      home: linuxHome,
    });

    expect(paths.config).toBe(join(linuxHome, '.config', APP_DIR));
    expect(paths.data).toBe(join(linuxHome, '.local', 'share', APP_DIR));
    expect(paths.state).toBe(join(linuxHome, '.local', 'state', APP_DIR));
  });

  it('honors XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME when set', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: {
        XDG_CONFIG_HOME: '/xdg/config',
        XDG_DATA_HOME: '/xdg/data',
        XDG_STATE_HOME: '/xdg/state',
      },
      home: linuxHome,
    });

    expect(paths.config).toBe(join('/xdg/config', APP_DIR));
    expect(paths.data).toBe(join('/xdg/data', APP_DIR));
    expect(paths.state).toBe(join('/xdg/state', APP_DIR));
  });

  it('ignores empty-string XDG values and uses fallbacks', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', XDG_STATE_HOME: '' },
      home: linuxHome,
    });

    expect(paths.config).toBe(join(linuxHome, '.config', APP_DIR));
    expect(paths.data).toBe(join(linuxHome, '.local', 'share', APP_DIR));
    expect(paths.state).toBe(join(linuxHome, '.local', 'state', APP_DIR));
  });

  it('returns absolute paths for every field', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: {},
      home: linuxHome,
    });

    expect(posix.isAbsolute(paths.config)).toBe(true);
    expect(posix.isAbsolute(paths.data)).toBe(true);
    expect(posix.isAbsolute(paths.state)).toBe(true);
  });
});

describe('resolvePaths — env overrides (Linux branch)', () => {
  const linuxHome = '/home/operator';

  it('absolute WFT_ROUTER_CONFIG wins over default config', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: { WFT_ROUTER_CONFIG: '/etc/wft-router' },
      home: linuxHome,
    });

    expect(paths.config).toBe('/etc/wft-router');
    // The other two fields are unaffected.
    expect(paths.data).toBe(join(linuxHome, '.local', 'share', APP_DIR));
    expect(paths.state).toBe(join(linuxHome, '.local', 'state', APP_DIR));
  });

  it('absolute WFT_ROUTER_DATA_DIR wins over default data', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: { WFT_ROUTER_DATA_DIR: '/var/lib/wft-router' },
      home: linuxHome,
    });

    expect(paths.data).toBe('/var/lib/wft-router');
    expect(paths.config).toBe(join(linuxHome, '.config', APP_DIR));
    expect(paths.state).toBe(join(linuxHome, '.local', 'state', APP_DIR));
  });

  it('absolute WFT_ROUTER_STATE_DIR wins over default state', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: { WFT_ROUTER_STATE_DIR: '/var/run/wft-router' },
      home: linuxHome,
    });

    expect(paths.state).toBe('/var/run/wft-router');
    expect(paths.config).toBe(join(linuxHome, '.config', APP_DIR));
    expect(paths.data).toBe(join(linuxHome, '.local', 'share', APP_DIR));
  });

  it('relative WFT_ROUTER_CONFIG is ignored (falls back to default)', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: { WFT_ROUTER_CONFIG: 'relative/path' },
      home: linuxHome,
    });

    expect(paths.config).toBe(join(linuxHome, '.config', APP_DIR));
  });

  it('empty-string WFT_ROUTER_CONFIG is ignored (falls back to default)', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: { WFT_ROUTER_CONFIG: '' },
      home: linuxHome,
    });

    expect(paths.config).toBe(join(linuxHome, '.config', APP_DIR));
  });

  it('all three overrides apply independently when all are set', () => {
    const paths = resolvePaths({
      platform: 'linux',
      env: {
        WFT_ROUTER_CONFIG: '/etc/wft-router',
        WFT_ROUTER_DATA_DIR: '/var/lib/wft-router',
        WFT_ROUTER_STATE_DIR: '/var/run/wft-router',
      },
      home: linuxHome,
    });

    expect(paths.config).toBe('/etc/wft-router');
    expect(paths.data).toBe('/var/lib/wft-router');
    expect(paths.state).toBe('/var/run/wft-router');
  });
});

describe('resolvePaths — macOS (Application Support)', () => {
  const macHome = '/Users/operator';

  it('places config and data under the same Application Support directory', () => {
    const paths = resolvePaths({
      platform: 'darwin',
      env: {},
      home: macHome,
    });

    const appSupport = join(macHome, 'Library', 'Application Support', APP_DIR);
    expect(paths.config).toBe(appSupport);
    expect(paths.data).toBe(appSupport);
  });

  it('nests state under the Application Support directory', () => {
    const paths = resolvePaths({
      platform: 'darwin',
      env: {},
      home: macHome,
    });

    const appSupport = join(macHome, 'Library', 'Application Support', APP_DIR);
    expect(paths.state).toBe(join(appSupport, 'state'));
  });

  it('ignores XDG vars on darwin (Apple convention wins)', () => {
    const paths = resolvePaths({
      platform: 'darwin',
      env: {
        XDG_CONFIG_HOME: '/xdg/config',
        XDG_DATA_HOME: '/xdg/data',
        XDG_STATE_HOME: '/xdg/state',
      },
      home: macHome,
    });

    const appSupport = join(macHome, 'Library', 'Application Support', APP_DIR);
    expect(paths.config).toBe(appSupport);
    expect(paths.data).toBe(appSupport);
    expect(paths.state).toBe(join(appSupport, 'state'));
  });

  it('honors WFT_ROUTER_* env overrides on darwin', () => {
    const paths = resolvePaths({
      platform: 'darwin',
      env: {
        WFT_ROUTER_CONFIG: '/etc/wft-router',
        WFT_ROUTER_DATA_DIR: '/var/lib/wft-router',
        WFT_ROUTER_STATE_DIR: '/var/run/wft-router',
      },
      home: macHome,
    });

    expect(paths.config).toBe('/etc/wft-router');
    expect(paths.data).toBe('/var/lib/wft-router');
    expect(paths.state).toBe('/var/run/wft-router');
  });

  it('returns absolute paths for every field', () => {
    const paths = resolvePaths({
      platform: 'darwin',
      env: {},
      home: macHome,
    });

    expect(posix.isAbsolute(paths.config)).toBe(true);
    expect(posix.isAbsolute(paths.data)).toBe(true);
    expect(posix.isAbsolute(paths.state)).toBe(true);
  });
});

describe('resolvePaths — Windows (AppData)', () => {
  // On Windows, `os.homedir()` returns a backslash-style path. We test
  // against `path.join`'s OUTPUT for the same inputs rather than hard-
  // coding separators so the assertions stay correct regardless of which
  // host the test suite runs on. (The default `node:path` import joins
  // with the current OS's separator; the win32 path SHAPE is what we're
  // verifying here, not Windows separator-rendering — that's the
  // platform-specific `node:path` impl's job at runtime.)
  const winHome = 'C:\\Users\\operator';

  it('uses APPDATA for config and LOCALAPPDATA for data + state when set', () => {
    const paths = resolvePaths({
      platform: 'win32',
      env: {
        APPDATA: 'C:\\Users\\operator\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
      },
      home: winHome,
    });

    expect(paths.config).toBe(
      join('C:\\Users\\operator\\AppData\\Roaming', APP_DIR),
    );
    expect(paths.data).toBe(
      join('C:\\Users\\operator\\AppData\\Local', APP_DIR),
    );
    expect(paths.state).toBe(
      join('C:\\Users\\operator\\AppData\\Local', APP_DIR, 'state'),
    );
  });

  it('falls back to ~\\AppData\\Roaming and ~\\AppData\\Local when env is empty', () => {
    const paths = resolvePaths({
      platform: 'win32',
      env: {},
      home: winHome,
    });

    expect(paths.config).toBe(join(winHome, 'AppData', 'Roaming', APP_DIR));
    expect(paths.data).toBe(join(winHome, 'AppData', 'Local', APP_DIR));
    expect(paths.state).toBe(
      join(winHome, 'AppData', 'Local', APP_DIR, 'state'),
    );
  });

  it('ignores empty-string APPDATA/LOCALAPPDATA and uses fallbacks', () => {
    const paths = resolvePaths({
      platform: 'win32',
      env: { APPDATA: '', LOCALAPPDATA: '' },
      home: winHome,
    });

    expect(paths.config).toBe(join(winHome, 'AppData', 'Roaming', APP_DIR));
    expect(paths.data).toBe(join(winHome, 'AppData', 'Local', APP_DIR));
    expect(paths.state).toBe(
      join(winHome, 'AppData', 'Local', APP_DIR, 'state'),
    );
  });

  it('honors WFT_ROUTER_* overrides on win32 (when absolute)', () => {
    const paths = resolvePaths({
      platform: 'win32',
      env: {
        APPDATA: 'C:\\Users\\operator\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
        WFT_ROUTER_CONFIG: 'D:\\config\\wft-router',
        WFT_ROUTER_STATE_DIR: 'D:\\state\\wft-router',
      },
      home: winHome,
    });

    expect(paths.config).toBe('D:\\config\\wft-router');
    expect(paths.state).toBe('D:\\state\\wft-router');
    // data is untouched by the overrides above, so it still resolves via LOCALAPPDATA.
    expect(paths.data).toBe(
      join('C:\\Users\\operator\\AppData\\Local', APP_DIR),
    );
  });

  it('treats Windows absolute drive-letter paths as absolute for override gating', () => {
    // win32.isAbsolute('D:\\x') === true. The default `node:path` on a
    // linux test host uses the POSIX impl whose isAbsolute('D:\\x')
    // === false, which would cause the override to be silently dropped.
    // Sanity-check the platform-aware impl directly here.
    expect(win32.isAbsolute('D:\\config\\wft-router')).toBe(true);
  });
});

describe('resolvePaths — BSD (XDG-shaped)', () => {
  const bsdHome = '/home/operator';

  it('treats freebsd the same as linux (XDG fallbacks)', () => {
    const paths = resolvePaths({
      platform: 'freebsd',
      env: {},
      home: bsdHome,
    });

    expect(paths.config).toBe(join(bsdHome, '.config', APP_DIR));
    expect(paths.data).toBe(join(bsdHome, '.local', 'share', APP_DIR));
    expect(paths.state).toBe(join(bsdHome, '.local', 'state', APP_DIR));
  });

  it('treats openbsd the same as linux (XDG_CONFIG_HOME honored)', () => {
    const paths = resolvePaths({
      platform: 'openbsd',
      env: { XDG_CONFIG_HOME: '/xdg/config' },
      home: bsdHome,
    });

    expect(paths.config).toBe(join('/xdg/config', APP_DIR));
  });
});
