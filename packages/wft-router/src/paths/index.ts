/**
 * Cross-platform default path resolver for wft-router.
 *
 * The router needs three on-disk locations at runtime — config (where
 * `triggers.yaml` lives), state (cursor, dispatch log, idempotency store),
 * and an optional data dir reserved for future use. The exact filesystem
 * layout is platform-conditional: XDG on Linux/BSD, Application Support on
 * macOS, AppData on Windows. See docs/event-router-design.md §"Platform-
 * neutral default paths" (lines 121-132) and §"Contract" outputs (lines
 * 110-112) for the design-of-record.
 *
 * Vendor-neutrality (guardrails 1-2, 7, design doc lines 699-702):
 *   - No platform is treated as the "real" one — the resolver branches on
 *     `process.platform` and gives every supported OS first-class defaults.
 *   - No `/usr/local`, no `~/.config`, no `%APPDATA%` is hard-coded as a
 *     cross-platform normative path; each appears only inside its own
 *     platform branch.
 *   - All defaults are env-overridable via `WFT_ROUTER_CONFIG`,
 *     `WFT_ROUTER_DATA_DIR`, `WFT_ROUTER_STATE_DIR`.
 *
 * Test seam: `resolvePaths(input)` is a pure function of its inputs. The
 * `getPaths()` convenience wrapper reads the live process state. Tests must
 * pin platform/env/home via `resolvePaths` so they can exercise every
 * branch on a single CI host.
 */

import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/**
 * Inputs that fully determine the resolved paths. Exposed as a test seam
 * so platform-specific branches can be exercised without spawning under a
 * different OS.
 */
export interface ResolvePathsInput {
  /** Equivalent of `process.platform`. Anything not 'darwin' or 'win32' is treated as Linux/BSD (XDG). */
  platform: NodeJS.Platform;
  /** Equivalent of `process.env`. Read for XDG_*, APPDATA, LOCALAPPDATA, and the `WFT_ROUTER_*` overrides. */
  env: NodeJS.ProcessEnv;
  /** Equivalent of `os.homedir()`. Used to build platform-default fallbacks. */
  home: string;
}

/**
 * Per-purpose absolute paths the wft-router uses at runtime. Each field is
 * always returned as an absolute path (see docs/event-router-design.md
 * §"Contract" — outputs list, lines 110-112).
 */
export interface RouterPaths {
  /** Where `triggers.yaml` and other user-authored config files live. Overridable via `WFT_ROUTER_CONFIG`. */
  config: string;
  /**
   * Optional data directory reserved for future use. The current spec does
   * not require it, but a `data` resolver is provided for symmetry with
   * platform conventions so callers don't have to invent one later.
   * Overridable via `WFT_ROUTER_DATA_DIR`.
   */
  data: string;
  /** Where the cursor file, dispatch log, and idempotency store live. Overridable via `WFT_ROUTER_STATE_DIR`. */
  state: string;
}

/**
 * The directory name used inside each platform-default root. Lives as a
 * single constant so the project's brand identifier — and any future
 * rename — has exactly one source of truth.
 */
const APP_DIR = 'wft-router';

/**
 * Returns true if `value` is an absolute path under the conventions of
 * the TARGET platform — not necessarily the host the test runs on. We
 * dispatch to `path.win32.isAbsolute` for win32 inputs (so drive-letter
 * paths like `D:\x` count as absolute even when this code runs under
 * Linux) and `path.posix.isAbsolute` for everything else.
 */
function isAbsoluteForPlatform(
  value: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'win32') {
    return win32.isAbsolute(value);
  }
  return posix.isAbsolute(value);
}

/**
 * Apply an env-var override if it is a non-empty ABSOLUTE path (per the
 * target platform's rules). Relative overrides are deliberately ignored —
 * silently resolving them against the daemon's cwd would be a footgun (the
 * daemon's cwd is set by systemd / launchd / the service supervisor, not
 * by the operator who exported the env var). Callers that want a
 * relative-to-cwd path should pre-resolve it before exporting.
 */
function applyOverride(
  envValue: string | undefined,
  fallback: string,
  platform: NodeJS.Platform,
): string {
  if (
    envValue !== undefined &&
    envValue.length > 0 &&
    isAbsoluteForPlatform(envValue, platform)
  ) {
    return envValue;
  }
  return fallback;
}

/**
 * Pure path resolver — branches on `input.platform`, consults `input.env`
 * for XDG / AppData / `WFT_ROUTER_*` overrides, and falls back to
 * `input.home`-anchored platform defaults otherwise.
 *
 * Defaults by platform (see docs/event-router-design.md §"Platform-neutral
 * default paths"):
 *
 * | Platform   | config                                    | data                                | state                                            |
 * |------------|-------------------------------------------|-------------------------------------|--------------------------------------------------|
 * | Linux/BSD  | `$XDG_CONFIG_HOME/wft-router`             | `$XDG_DATA_HOME/wft-router`         | `$XDG_STATE_HOME/wft-router`                     |
 * |            | fallback `~/.config/wft-router`           | fallback `~/.local/share/wft-router`| fallback `~/.local/state/wft-router`             |
 * | macOS      | `~/Library/Application Support/wft-router`| (same as config — Apple convention) | `~/Library/Application Support/wft-router/state` |
 * | Windows    | `%APPDATA%\wft-router`                    | `%LOCALAPPDATA%\wft-router`         | `%LOCALAPPDATA%\wft-router\state`                |
 * |            | fallback `~\AppData\Roaming\wft-router`   | fallback `~\AppData\Local\wft-router`| fallback `~\AppData\Local\wft-router\state`     |
 *
 * Env overrides (all platforms): `WFT_ROUTER_CONFIG`, `WFT_ROUTER_DATA_DIR`,
 * `WFT_ROUTER_STATE_DIR`. Each only applies when set to a non-empty
 * absolute path; non-absolute overrides are ignored.
 *
 * @returns An absolute path for every field in {@link RouterPaths}.
 */
export function resolvePaths(input: ResolvePathsInput): RouterPaths {
  const { platform, env, home } = input;

  let defaults: RouterPaths;

  if (platform === 'darwin') {
    // Apple convention: Application Support hosts both config and data.
    // State is nested under it so we don't collide with user-authored
    // config files at the top level.
    const appSupport = join(home, 'Library', 'Application Support', APP_DIR);
    defaults = {
      config: appSupport,
      data: appSupport,
      state: join(appSupport, 'state'),
    };
  } else if (platform === 'win32') {
    // Windows splits roaming (config) from local (data + state). When the
    // env vars are missing — rare, but possible under stripped service
    // accounts — fall back to the canonical ~\AppData\{Roaming,Local}
    // layout under the user's home directory.
    const roamingDefault = join(home, 'AppData', 'Roaming', APP_DIR);
    const localDefault = join(home, 'AppData', 'Local', APP_DIR);
    const roaming =
      env.APPDATA !== undefined && env.APPDATA.length > 0
        ? join(env.APPDATA, APP_DIR)
        : roamingDefault;
    const local =
      env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA.length > 0
        ? join(env.LOCALAPPDATA, APP_DIR)
        : localDefault;
    defaults = {
      config: roaming,
      data: local,
      state: join(local, 'state'),
    };
  } else {
    // Linux/BSD (XDG). Anything not explicitly darwin/win32 lands here —
    // *BSD all follow the XDG Base Directory spec, so treating
    // freebsd/openbsd/netbsd/sunos/aix as XDG-shaped is the correct
    // default. See https://specifications.freedesktop.org/basedir-spec/.
    const xdgConfig =
      env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
        ? join(env.XDG_CONFIG_HOME, APP_DIR)
        : join(home, '.config', APP_DIR);
    const xdgData =
      env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
        ? join(env.XDG_DATA_HOME, APP_DIR)
        : join(home, '.local', 'share', APP_DIR);
    const xdgState =
      env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.length > 0
        ? join(env.XDG_STATE_HOME, APP_DIR)
        : join(home, '.local', 'state', APP_DIR);
    defaults = { config: xdgConfig, data: xdgData, state: xdgState };
  }

  return {
    config: applyOverride(env.WFT_ROUTER_CONFIG, defaults.config, platform),
    data: applyOverride(env.WFT_ROUTER_DATA_DIR, defaults.data, platform),
    state: applyOverride(env.WFT_ROUTER_STATE_DIR, defaults.state, platform),
  };
}

/**
 * Default resolver — reads `process.platform`, `process.env`, and
 * `os.homedir()` at call time and returns the resolved paths for the
 * running process. Thin wrapper over {@link resolvePaths}; tests should
 * call `resolvePaths` directly with pinned inputs instead of mocking the
 * process surface.
 */
export function getPaths(): RouterPaths {
  return resolvePaths({
    platform: process.platform,
    env: process.env,
    home: homedir(),
  });
}
