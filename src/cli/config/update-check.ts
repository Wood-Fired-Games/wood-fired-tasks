/**
 * CLI update-check enablement resolver (v2.0 Phase 4).
 *
 * Owns the single read-only answer to "should the update-available feature
 * run?" — consumed by the background update-check writer (#795) and the
 * update-hint status-line segment (#596/#597). Keeping this in one place
 * means the writer and the renderer can never disagree about whether the
 * feature is on.
 *
 * The feature can be disabled by EITHER of two layered off-switches:
 *
 *   1. A persisted config-dir flag `update_check = false` in the CLI config
 *      file (TOML), the durable per-user opt-out written by `tasks setup`
 *      (#798 owns that write wiring).
 *   2. The env var `WFT_NO_UPDATE_CHECK=1` — the ad-hoc / CI override.
 *
 * Precedence (DOCUMENTED CONTRACT):
 *
 *   The ENV VAR WINS. `WFT_NO_UPDATE_CHECK` is the ad-hoc override and is
 *   evaluated first; when it is set to a truthy value the feature is OFF
 *   regardless of the config flag, and when it is explicitly set to a
 *   falsy value ("0"/"false"/"") it FORCES the feature ON, overriding a
 *   persisted `update_check = false`. This lets CI and power users flip the
 *   feature for a single invocation without touching (or being blocked by)
 *   the on-disk config. Only when the env var is UNSET does the persisted
 *   config flag decide; and only when neither is set does the default
 *   (ON) apply.
 *
 *   Resolution order:
 *     env set & truthy   → OFF
 *     env set & falsy    → ON   (forces on, beats config flag)
 *     env unset, flag=false → OFF
 *     env unset, flag=true/absent → ON  (default)
 *
 * The config-file location mirrors the credentials convention
 * (see src/cli/auth/credentials.ts) so all CLI user config lives together:
 *   `$WFT_CONFIG_PATH` > `$XDG_CONFIG_HOME/wood-fired-tasks/config`
 *   (when XDG_CONFIG_HOME is an ABSOLUTE path per the XDG Base Directory
 *   spec) > `~/.config/wood-fired-tasks/config`.
 *
 * This module's PUBLIC DELIVERABLE is the read-only resolver
 * {@link isUpdateCheckEnabled}. A small {@link setUpdateCheckFlag} writer
 * helper is co-located because the flag's read+write naturally belong
 * together, but the resolver performs NO writes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

/** Env var name for the ad-hoc / CI off-switch. */
export const UPDATE_CHECK_ENV = 'WFT_NO_UPDATE_CHECK';

/**
 * Resolve the absolute CLI config file path.
 *
 * Mirrors {@link getCredentialsPath} so the config flag lives beside the
 * credentials file in the same config dir.
 *
 * Precedence:
 *   1. `$WFT_CONFIG_PATH` (verbatim) when set & non-empty.
 *   2. `$XDG_CONFIG_HOME/wood-fired-tasks/config` when XDG_CONFIG_HOME is absolute.
 *   3. `~/.config/wood-fired-tasks/config`.
 */
export function getConfigPath(): string {
  const override = process.env['WFT_CONFIG_PATH'];
  if (override && override.length > 0) return override;

  const xdg = process.env['XDG_CONFIG_HOME'];
  const configHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
  return path.join(configHome, 'wood-fired-tasks', 'config');
}

/**
 * Interpret a string env value as a boolean off-switch.
 * Truthy: "1", "true", "yes", "on" (case-insensitive). Anything else
 * (including "0", "false", "no", "off", "") is falsy.
 */
function envIsTruthy(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Read the persisted `update_check` flag from the config file.
 *
 * Returns the boolean when present & boolean-typed, otherwise `undefined`
 * (file missing, unreadable, malformed TOML, key absent, or wrong type —
 * all of which mean "no explicit opt-out persisted"). This is intentionally
 * lenient: a busted config file must NEVER crash the status-line render or
 * the background check; it just means the default applies.
 */
export function readUpdateCheckFlag(filePath: string = getConfigPath()): boolean | undefined {
  if (!existsSync(filePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed && typeof parsed === 'object' && 'update_check' in parsed) {
    const v = (parsed as Record<string, unknown>)['update_check'];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/**
 * READ-ONLY RESOLVER — the deliverable.
 *
 * Reports whether the update-available feature is enabled. Performs no
 * writes. See the module-level JSDoc for the full precedence contract;
 * in short: env beats config flag, default is ON.
 *
 * @param filePath optional override for the config file (testing).
 */
export function isUpdateCheckEnabled(filePath: string = getConfigPath()): boolean {
  // 1. Env var wins unconditionally when SET (the ad-hoc override).
  const envRaw = process.env[UPDATE_CHECK_ENV];
  if (envRaw !== undefined) {
    // `WFT_NO_UPDATE_CHECK` is a NO-switch: truthy → disabled, falsy → forced on.
    return !envIsTruthy(envRaw);
  }

  // 2. Persisted config flag. `update_check = false` → disabled.
  const flag = readUpdateCheckFlag(filePath);
  if (flag === false) return false;

  // 3. Default ON (flag absent or explicitly true).
  return true;
}

/**
 * Co-located writer helper for the persisted `update_check` flag.
 *
 * NOT part of the read resolver's contract — provided so the flag's
 * read+write live together. #798 (`tasks setup` opt-out wiring) is the
 * intended caller. Preserves any other keys already in the config file and
 * writes atomically (tmp + rename).
 */
export function setUpdateCheckFlag(enabled: boolean, filePath: string = getConfigPath()): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>;
    } catch {
      // Malformed file is overwritten with a clean one carrying just the flag.
      existing = {};
    }
  }
  existing['update_check'] = enabled;

  mkdirSync(path.dirname(filePath), { recursive: true });
  const header =
    '# Wood Fired Tasks CLI config. Managed by `tasks setup`.\n' +
    '# `update_check = false` disables the update-available feature.\n\n';
  const body = header + stringify(existing);

  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body);
  renameSync(tmp, filePath);
}
