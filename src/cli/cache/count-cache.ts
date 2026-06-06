/**
 * TTL cache module for the Phase 4 status-line infra.
 *
 * Two layers:
 *
 *   1. A generic TTL read / atomic-write engine ({@link readTtl},
 *      {@link writeAtomic}) that is payload-agnostic. It stores any
 *      JSON-serializable object as `{ ...payload, fetchedAt }` and on read
 *      returns a discriminated result keyed on the age of `fetchedAt`
 *      relative to a caller-supplied TTL.
 *
 *   2. Typed wrappers — the primary deliverable is the per-project task
 *      **count cache** ({@link readCountCache}, {@link writeCountCache})
 *      stored at {@link getCountCachePath}. The v2.0 rollup reuses the SAME
 *      engine to back the Phase 4 **update-available** cache
 *      ({@link readUpdateCache}, {@link writeUpdateCache}) at
 *      {@link getUpdateCheckPath}) — one TTL implementation, two payloads.
 *
 * Write durability mirrors src/cli/auth/credentials.ts: serialize to a
 * `.tmp.<pid>.<ts>` sibling, then `renameSync` onto the final path. POSIX
 * rename(2) is atomic within a single filesystem, so a concurrent reader
 * never observes a partially written file. The cache dir is `mkdir -p`'d
 * first (reusing {@link getCacheDir} via the path helpers).
 *
 * Reads NEVER throw: a missing file, an unreadable file, malformed JSON, or
 * a payload without a numeric `fetchedAt` all collapse to the `missing`
 * variant so the status-line render path can treat "no usable cache" as a
 * single, safe case.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getCountCachePath, getUpdateCheckPath } from './paths.js';

/** Wall-clock timestamp (ms since epoch) stamped onto every cache entry. */
interface TtlEnvelope {
  /** ms since epoch when the payload was fetched/written. */
  fetchedAt: number;
}

/**
 * Discriminated read result. `fresh` and `stale` both carry the decoded
 * payload (a stale entry is still usable — the caller may render it while a
 * background refresh runs); `missing` carries nothing.
 */
export type TtlResult<T> =
  | { state: 'fresh'; value: T; ageMs: number }
  | { state: 'stale'; value: T; ageMs: number }
  | { state: 'missing' };

/** Per-project task-count payload (the primary deliverable). */
export interface CountCache {
  projectId: number | string;
  projectName: string;
  open: number;
  doneClosed: number;
  /** ms since epoch — stamped by {@link writeAtomic}. */
  fetchedAt: number;
}

/** Phase 4 update-available payload (v2.0 rollup, same engine). */
export interface UpdateCache {
  /** The npm-dist-tag version the registry advertised as latest. */
  latestVersion: string;
  /** The version the user currently has installed. */
  currentVersion: string;
  /** Whether `latestVersion` is newer than `currentVersion`. */
  updateAvailable: boolean;
  /** ms since epoch — stamped by {@link writeAtomic}. */
  fetchedAt: number;
}

/**
 * Generic TTL read. Returns a discriminated {@link TtlResult}:
 *   - `missing` — no file, unreadable file, unparseable JSON, or a payload
 *     missing a numeric `fetchedAt`. NEVER throws.
 *   - `fresh`   — `now - fetchedAt <= ttlMs`.
 *   - `stale`   — `now - fetchedAt > ttlMs`.
 *
 * `now` is injectable purely for deterministic tests; it defaults to
 * `Date.now()`.
 */
export function readTtl<T extends TtlEnvelope>(
  filePath: string,
  ttlMs: number,
  now: number = Date.now(),
): TtlResult<T> {
  if (!existsSync(filePath)) return { state: 'missing' };

  let parsed: unknown;
  try {
    const body = readFileSync(filePath, 'utf8');
    parsed = JSON.parse(body);
  } catch {
    // Unreadable file or malformed JSON — treat as a cache miss rather
    // than propagating an exception into the status-line render path.
    return { state: 'missing' };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { fetchedAt?: unknown }).fetchedAt !== 'number' ||
    !Number.isFinite((parsed as TtlEnvelope).fetchedAt)
  ) {
    return { state: 'missing' };
  }

  const value = parsed as T;
  const ageMs = now - value.fetchedAt;
  return ageMs <= ttlMs ? { state: 'fresh', value, ageMs } : { state: 'stale', value, ageMs };
}

/**
 * Generic atomic write. Stamps `fetchedAt` onto `payload`, serializes to
 * JSON, writes a `.tmp.<pid>.<ts>` sibling, then `renameSync`s it onto
 * `filePath`. The parent dir is `mkdir -p`'d first.
 *
 * Returns the full envelope that was persisted (payload + the stamped
 * `fetchedAt`) so callers can echo the value without a follow-up read.
 *
 * `now` is injectable for deterministic tests; defaults to `Date.now()`.
 */
export function writeAtomic<T extends object>(
  filePath: string,
  payload: T,
  now: number = Date.now(),
): T & TtlEnvelope {
  mkdirSync(path.dirname(filePath), { recursive: true });

  const envelope: T & TtlEnvelope = { ...payload, fetchedAt: now };
  const body = JSON.stringify(envelope, null, 2);

  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, 'utf8');
  // Atomic on POSIX (single-fs rename(2)); MoveFileEx on Windows gives
  // similar semantics. If rename throws (e.g. cross-fs), the tmp sibling is
  // left behind — acceptable; the final path never sees partial state.
  renameSync(tmp, filePath);

  return envelope;
}

// ---------------------------------------------------------------------------
// Typed count-cache wrappers (primary deliverable)
// ---------------------------------------------------------------------------

/** Payload accepted by {@link writeCountCache} (fetchedAt is stamped). */
export type CountCacheInput = Omit<CountCache, 'fetchedAt'>;

/**
 * Read the per-project task-count cache for `projectKey`. See
 * {@link readTtl} for the freshness semantics.
 */
export function readCountCache(
  projectKey: string,
  ttlMs: number,
  now: number = Date.now(),
): TtlResult<CountCache> {
  return readTtl<CountCache>(getCountCachePath(projectKey), ttlMs, now);
}

/** Atomically persist the per-project task-count cache for `projectKey`. */
export function writeCountCache(
  projectKey: string,
  payload: CountCacheInput,
  now: number = Date.now(),
): CountCache {
  return writeAtomic<CountCacheInput>(getCountCachePath(projectKey), payload, now);
}

// ---------------------------------------------------------------------------
// Typed update-available wrappers (v2.0 rollup — same TTL engine)
// ---------------------------------------------------------------------------

/** Payload accepted by {@link writeUpdateCache} (fetchedAt is stamped). */
export type UpdateCacheInput = Omit<UpdateCache, 'fetchedAt'>;

/**
 * Read the Phase 4 update-available cache. Backed by the SAME TTL engine
 * as the count cache; see {@link readTtl} for freshness semantics.
 */
export function readUpdateCache(ttlMs: number, now: number = Date.now()): TtlResult<UpdateCache> {
  return readTtl<UpdateCache>(getUpdateCheckPath(), ttlMs, now);
}

/** Atomically persist the Phase 4 update-available cache. */
export function writeUpdateCache(payload: UpdateCacheInput, now: number = Date.now()): UpdateCache {
  return writeAtomic<UpdateCacheInput>(getUpdateCheckPath(), payload, now);
}
