/**
 * Phase 4 (#795) — best-effort update-available cache writer.
 *
 * Records whether a newer published version of the CLI exists into the
 * update-check cache ({@link writeUpdateCache} at {@link getUpdateCheckPath},
 * #591/#592), so the `tasks statusline` render path can surface an
 * "update available" hint by READING the cache — never by hitting the
 * network on the hot path.
 *
 * Design contract:
 *
 *   1. REUSES the existing `update-notifier` dependency (exactly as
 *      src/cli/commands/self-update.ts's `defaultNotify` does). We read
 *      `updateNotifier({ pkg }).update`, which is the result of
 *      update-notifier's own async, daily-TTL'd, persisted registry check —
 *      `{ current, latest, type }` when a newer version is known, otherwise
 *      `undefined`. NO new network / version-compare code is written here.
 *
 *   2. GATED on {@link isUpdateCheckEnabled} (#797) BEFORE doing anything.
 *      When the feature is disabled (config `update_check = false` or
 *      `WFT_NO_UPDATE_CHECK`), the writer returns immediately and touches
 *      nothing.
 *
 *   3. BEST-EFFORT. Any failure — update-notifier missing, offline, throws,
 *      or returns nothing usable — leaves the prior cache UNTOUCHED and never
 *      throws. We only call {@link writeUpdateCache} when we have a concrete
 *      `{ current, latest }` pair to persist.
 *
 *   4. OFF the render hot path. The intended call site is a fire-and-forget
 *      invocation at MCP server boot (src/mcp/index.ts) and/or CLI startup —
 *      NOT `tasks statusline`.
 *
 * Note on cache shape: the persisted schema is owned by #592
 * ({@link UpdateCacheInput} = `{ latestVersion, currentVersion, updateAvailable }`
 * with `fetchedAt` auto-stamped). That is the on-disk equivalent of the
 * spec's `{ update_available, current, latest, checked_at }`; we do not
 * redefine it here.
 */
import { writeUpdateCache } from '../cache/count-cache.js';
import { isUpdateCheckEnabled } from '../config/update-check.js';
import { VERSION } from '../../utils/version.js';

const PACKAGE_NAME = 'wood-fired-tasks';

/** The subset of update-notifier's `UpdateInfo` we consume. */
interface UpdateInfo {
  current: string;
  latest: string;
  type?: string;
}

/** Minimal shape of the `update-notifier` factory we rely on. */
type NotifierFactory = (opts: unknown) => { update?: UpdateInfo };

/**
 * Injectable seam returning update-notifier's cached `update` info (or
 * undefined when no newer version is known / the check hasn't completed).
 * Mirrors self-update.ts's lazy, types-less, best-effort import so a missing
 * dep or offline box degrades silently instead of throwing.
 */
export type FetchUpdateInfoFn = (currentVersion: string) => Promise<UpdateInfo | undefined>;

const defaultFetchUpdateInfo: FetchUpdateInfoFn = async (currentVersion) => {
  // Indirect specifier so TS doesn't try to resolve a (types-less) module;
  // update-notifier ships no .d.ts, and the check is best-effort anyway.
  const specifier = 'update-notifier';
  const mod = (await import(specifier)) as { default?: NotifierFactory } & NotifierFactory;
  const updateNotifier: NotifierFactory = mod.default ?? (mod as unknown as NotifierFactory);
  const notifier = updateNotifier({
    pkg: { name: PACKAGE_NAME, version: currentVersion },
  });
  return notifier.update;
};

export interface WriteUpdateCheckDeps {
  /** Override the update-notifier read (tests inject a recording stub). */
  fetchUpdateInfo?: FetchUpdateInfoFn;
  /** Override the enablement gate (tests force disabled). */
  isEnabled?: () => boolean;
  /** Override the installed version (tests pin it). */
  currentVersion?: string;
}

/**
 * Best-effort update-available cache write.
 *
 * - Returns `false` (a no-op) when the feature is disabled or no usable
 *   update info is available — in both cases the prior cache is untouched.
 * - Returns `true` only after a successful {@link writeUpdateCache}.
 *
 * NEVER throws: all errors are swallowed so a fire-and-forget caller at
 * boot is never blocked or crashed by the check.
 */
export async function writeUpdateCheck(deps: WriteUpdateCheckDeps = {}): Promise<boolean> {
  const isEnabled = deps.isEnabled ?? isUpdateCheckEnabled;

  // Gate FIRST — disabled means do absolutely nothing (no import, no read).
  try {
    if (!isEnabled()) return false;
  } catch {
    // A busted gate must not crash the caller; fail safe to "do nothing".
    return false;
  }

  const fetchUpdateInfo = deps.fetchUpdateInfo ?? defaultFetchUpdateInfo;
  const currentVersion = deps.currentVersion ?? VERSION;

  try {
    const info = await fetchUpdateInfo(currentVersion);
    // No newer version known yet (offline, check pending, or up to date) →
    // leave the prior cache untouched.
    if (!info || !info.latest || !info.current) return false;

    writeUpdateCache({
      currentVersion: info.current,
      latestVersion: info.latest,
      updateAvailable: info.latest !== info.current,
    });
    return true;
  } catch {
    // Offline / import failure / write failure — best-effort, never throw.
    return false;
  }
}

/**
 * Fire-and-forget trigger for non-blocking call sites (MCP boot, CLI
 * startup). Kicks off {@link writeUpdateCheck} without awaiting and
 * guarantees the returned promise never rejects, so a caller can invoke it
 * with `void triggerUpdateCheck()` and move on immediately.
 */
export function triggerUpdateCheck(deps: WriteUpdateCheckDeps = {}): void {
  void writeUpdateCheck(deps).catch(() => {
    /* best-effort: swallow everything */
  });
}
