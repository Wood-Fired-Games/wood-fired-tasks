import { join, posix, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePaths } from '../../src/paths/index.js';

// fix-10 / platform-neutral-paths: the spec's path table resolves correctly on
// Linux, macOS, and Windows; `WFT_ROUTER_CONFIG` overrides on all three. The
// resolver's pure `resolvePaths(input)` seam is driven with a pinned
// platform/env/home tuple per OS — no real `process.platform` mutation — so a
// single CI host exercises every branch deterministically.

/** The brand dir baked into every platform default. */
const APP_DIR = 'wft-router';

/** Is this path absolute under the conventions of `platform`? */
function isAbsoluteFor(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

/**
 * The three target platforms with a home dir and the concrete default the
 * spec's table prescribes for each — driving one parametrized assertion block
 * across Linux (XDG), macOS (Application Support), and Windows (AppData).
 */
const PLATFORM_TABLE = [
  {
    platform: 'linux' as NodeJS.Platform,
    home: '/home/operator',
    defaultConfig: join('/home/operator', '.config', APP_DIR),
  },
  {
    platform: 'darwin' as NodeJS.Platform,
    home: '/Users/operator',
    defaultConfig: join('/Users/operator', 'Library', 'Application Support', APP_DIR),
  },
  {
    platform: 'win32' as NodeJS.Platform,
    home: 'C:\\Users\\operator',
    defaultConfig: join('C:\\Users\\operator', 'AppData', 'Roaming', APP_DIR),
  },
];

describe('fix-10 / platform-neutral-paths', () => {
  it('resolves the spec path table to absolute paths on Linux, macOS, and Windows', () => {
    for (const { platform, home, defaultConfig } of PLATFORM_TABLE) {
      const paths = resolvePaths({ platform, env: {}, home });

      // The spec's table value for `config` is what the resolver returns.
      expect(paths.config).toBe(defaultConfig);

      // Every field is absolute under THAT platform's path conventions (the
      // win32 branch yields drive-letter paths even when CI runs on Linux).
      expect(isAbsoluteFor(paths.config, platform)).toBe(true);
      expect(isAbsoluteFor(paths.data, platform)).toBe(true);
      expect(isAbsoluteFor(paths.state, platform)).toBe(true);
    }
  });

  it('honours an absolute WFT_ROUTER_CONFIG override on all three platforms', () => {
    // An absolute override per-platform: a POSIX path for linux/darwin, a
    // drive-letter path for win32 (so override-gating uses the right rules).
    const overrides: Record<string, string> = {
      linux: '/etc/wft-router',
      darwin: '/etc/wft-router',
      win32: 'D:\\config\\wft-router',
    };

    for (const { platform, home, defaultConfig } of PLATFORM_TABLE) {
      const WFT_ROUTER_CONFIG = overrides[platform];
      const paths = resolvePaths({
        platform,
        env: { WFT_ROUTER_CONFIG },
        home,
      });

      // The override wins over the platform default config.
      expect(paths.config).toBe(WFT_ROUTER_CONFIG);
      expect(paths.config).not.toBe(defaultConfig);
      // It only touches `config` — data/state still resolve via the defaults.
      expect(paths.config).not.toBe(paths.data);
    }
  });
});
