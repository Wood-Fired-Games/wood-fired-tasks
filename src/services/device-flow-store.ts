/**
 * Phase 30 Plan 01 Task 1 — RFC 8628 device-authorization in-memory store.
 *
 * Two module-scope maps form the entire state machine:
 *   - `byDeviceCode: Map<string, DeviceFlowSession>` — the authoritative store
 *   - `byUserCode:   Map<string, string>`           — reverse index → deviceCode
 *
 * Lifecycle (RFC 8628 §3):
 *   1. CLI POSTs `/auth/device/code` → handler calls `createSession` →
 *      pending session inserted; CLI starts polling
 *   2. Browser leg (Plan 30-02) calls `approve(userCode, userId)` →
 *      session transitions pending → approved
 *   3. Next CLI poll on `/auth/device/token` (Plan 30-04) sees `approved`,
 *      mints a PAT, sets `mintedTokenId`/`mintedToken`, then `remove`s the
 *      session (one-shot consumption — RFC 8628 anti-replay §5.2)
 *
 * Cleanup: `startCleanup()` schedules a `setInterval` that prunes expired
 * sessions every `CLEANUP_TICK_MS` ms. The interval handle is `.unref()`'d
 * so vitest does not hang when the test process never explicitly calls
 * `.stop()`. The interval is OPT-IN — server boot wires it; test harnesses
 * that never `startCleanup()` remain timer-clean and rely on
 * `_resetForTests()` between cases.
 *
 * Trust boundary: anonymous internet → POST /auth/device/{code,token}.
 * The device_code is 256 bits of base64url'd `randomBytes(32)`, the
 * user_code is 8 chars × 31 symbols ≈ 8.5×10^11 keyspace. Combined with
 * the 600 s TTL and Fastify rate-limit on `/auth/*` (server.ts:262-281),
 * brute-force is not a tractable threat (Threat T-30-01-01 / T-30-01-02).
 *
 * Plan-level scope: this module manages SESSION STATE only. PAT minting,
 * hostname sanitization, and route wiring live in Plans 30-02 / 30-04 / 30-08.
 *
 * @see .planning/phases/30-cli-authentication/30-01-PLAN.md
 */
import { randomBytes } from 'node:crypto';

/** RFC 8628 §3.2 default `expires_in` — 10 minutes. */
export const SESSION_TTL_MS = 600_000;

/** Cleanup cadence — every 60 s we prune entries past their TTL. */
export const CLEANUP_TICK_MS = 60_000;

/**
 * 31-symbol user_code alphabet — RFC 8628 §6.1 recommends a "subset that
 * humans can read and type easily". We follow the convention shared by
 * Google, GitHub, and AWS device flows: ditch `0/O/1/I/L` so the code
 * survives faxing, photographing, and dictation over the phone.
 */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface DeviceFlowSession {
  /** 32 bytes of `randomBytes` → base64url, ≥43 chars (256 bits entropy). */
  deviceCode: string;
  /** 8 chars from USER_CODE_ALPHABET, ≈8.5×10^11 keyspace. */
  userCode: string;
  /**
   * Sanitized hostname captured from the CLI's `/auth/device/code` request.
   * Plan 30-04 uses this to auto-name the minted PAT. `null` when the CLI
   * didn't supply one.
   */
  hostname: string | null;
  /** OAuth client_id supplied at create time — audit + tamper detection. */
  clientId: string;
  /** Date.now() ms at session creation. */
  createdAt: number;
  /** createdAt + SESSION_TTL_MS. Cleanup compares against this. */
  expiresAt: number;
  /**
   * Polling cadence in seconds. Starts at 5. Each `slow_down` response from
   * `/auth/device/token` bumps this by exactly +5 (RFC 8628 §3.5 — additive,
   * not multiplicative).
   */
  interval: number;
  /**
   * Date.now() ms of the most recent `/auth/device/token` poll. 0 = never
   * polled (the rate gate must let the first poll through unconditionally).
   */
  lastPollAt: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** Set by Plan 30-02's verify handler when the user approves. */
  approvedUserId: number | null;
  /** Set by Plan 30-04 on successful mint. */
  mintedTokenId: number | null;
  /** Set by Plan 30-04 on successful mint — the `wft_pat_*` plaintext. */
  mintedToken: string | null;
}

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

/**
 * Authoritative store. Keyed by deviceCode because that's the only key the
 * CLI's polling endpoint sees. The reverse index (`byUserCode`) carries
 * deviceCode values so a single deviceCode is the source of truth even
 * after the user has typed the user_code into the browser.
 */
const byDeviceCode = new Map<string, DeviceFlowSession>();
const byUserCode = new Map<string, string>();

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/**
 * 32 random bytes → base64url. Node's `randomBytes(32).toString('base64url')`
 * produces 43 chars (256 bits, unpadded). RFC 8628 only mandates "high
 * entropy"; 256 bits is the same envelope used by Google's device flow.
 */
function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Rejection-sampled 8-char user_code drawn from USER_CODE_ALPHABET. The
 * straightforward `randomBytes(8) % 31` would bias the distribution
 * (256 mod 31 = 8, so 0..7 each appear 9 times vs 8 for the rest). We
 * sample one byte at a time and reject any byte ≥ 31 * 8 = 248. The
 * expected loop count is ~8.25 (8 / (248/256)) — fast enough to ignore.
 *
 * On collision with an existing user_code, the caller (`createSession`)
 * loops up to a handful of times before giving up. With 8.5×10^11 codes
 * and a TTL of 10 min, a sustained collision is implausible.
 */
function generateUserCode(): string {
  const out: string[] = [];
  while (out.length < 8) {
    const buf = randomBytes(16);
    for (const byte of buf) {
      if (out.length === 8) break;
      if (byte < 248) {
        // byte % 31 ∈ [0, 30] is always an in-range index of the 31-char alphabet.
        const ch = USER_CODE_ALPHABET[byte % 31];
        if (ch !== undefined) out.push(ch);
      }
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateSessionArgs {
  clientId: string;
  hostname: string | null;
}

/**
 * Insert a fresh pending session into both maps and return it. user_code
 * collisions trigger a retry (rejection sampling); in practice this never
 * fires given the 8.5×10^11 keyspace, but the loop is defense-in-depth.
 */
export function createSession(args: CreateSessionArgs): DeviceFlowSession {
  const now = Date.now();
  const deviceCode = generateDeviceCode();
  let userCode = generateUserCode();
  // Loop on the astronomically-unlikely user_code collision.
  let tries = 0;
  while (byUserCode.has(userCode)) {
    userCode = generateUserCode();
    if (++tries > 32) {
      // 32 collisions in a row is a smoke alarm, not a real possibility.
      throw new Error('device-flow-store: user_code generation collided');
    }
  }
  const session: DeviceFlowSession = {
    deviceCode,
    userCode,
    // Plan 30-04: hostname is sanitized at create time so the PAT-name
    // helper (`tokenName`) can read `session.hostname` verbatim without
    // re-sanitizing. Producing `'unknown'` for null/empty input keeps the
    // downstream name format stable (`cli-unknown-YYYY-MM-DD`).
    hostname: sanitizeHostname(args.hostname),
    clientId: args.clientId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    interval: 5,
    lastPollAt: 0,
    status: 'pending',
    approvedUserId: null,
    mintedTokenId: null,
    mintedToken: null,
  };
  byDeviceCode.set(deviceCode, session);
  byUserCode.set(userCode, deviceCode);
  return session;
}

/** Returns the session for `dc`, or `undefined` if not found. */
export function findByDeviceCode(dc: string): DeviceFlowSession | undefined {
  return byDeviceCode.get(dc);
}

/** Resolve user_code → session via the reverse index. */
export function findByUserCode(uc: string): DeviceFlowSession | undefined {
  const dc = byUserCode.get(uc);
  if (dc === undefined) return undefined;
  return byDeviceCode.get(dc);
}

/**
 * Transition a pending session to `approved` and stamp `approvedUserId`.
 * Idempotent: a second call with the same `(userCode, userId)` on an
 * already-approved session returns `true` (the browser may double-submit).
 * Any other non-pending state (`denied`, `expired`) returns `false`.
 */
export function approve(userCode: string, userId: number): boolean {
  const session = findByUserCode(userCode);
  if (!session) return false;
  if (session.status === 'approved' && session.approvedUserId === userId) {
    return true;
  }
  if (session.status !== 'pending') return false;
  session.status = 'approved';
  session.approvedUserId = userId;
  return true;
}

/**
 * Transition a pending session to `denied`. Terminal — no recovery; the
 * CLI will see `access_denied` on its next poll. Returns false if not
 * found or already in a non-pending state.
 */
export function deny(userCode: string): boolean {
  const session = findByUserCode(userCode);
  if (!session) return false;
  if (session.status !== 'pending') return false;
  session.status = 'denied';
  return true;
}

/**
 * Delete the session from both maps. Called by Plan 30-04 immediately
 * after a successful mint so a replayed device_code returns `expired_token`
 * (RFC 8628 §5.2 anti-replay).
 */
export function remove(deviceCode: string): void {
  const session = byDeviceCode.get(deviceCode);
  if (!session) return;
  byDeviceCode.delete(deviceCode);
  byUserCode.delete(session.userCode);
}

/**
 * Schedule the periodic cleanup tick. Returns a handle whose `.stop()`
 * clears the interval (idempotently — `clearInterval` on an already-cleared
 * id is a no-op, and we null the slot for belt-and-braces).
 *
 * The interval is `.unref()`'d so a stray test that never calls `.stop()`
 * doesn't keep the vitest process alive. Production (`src/index.ts`)
 * keeps the process alive via the Fastify listener, so .unref() is purely
 * a test ergonomics knob with zero ops cost.
 */
export function startCleanup(): { stop: () => void } {
  const id = setInterval(() => {
    const now = Date.now();
    for (const [dc, session] of byDeviceCode) {
      if (now > session.expiresAt) {
        byDeviceCode.delete(dc);
        byUserCode.delete(session.userCode);
      }
    }
  }, CLEANUP_TICK_MS);
  id.unref();
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Plan 30-04 — sanitization + PAT-mint metadata
// ---------------------------------------------------------------------------

/**
 * Maximum length of a sanitized hostname segment. The minted PAT name has
 * shape `cli-<sanitized>-YYYY-MM-DD` (length 32 + 14 = 46 chars max). 32
 * is wide enough to be human-recognizable in the web token list but tight
 * enough to keep the full PAT name comfortably under the 255-char schema
 * limit even after the date suffix.
 */
const HOSTNAME_MAX_LEN = 32;

/**
 * Coerce a raw hostname into the deterministic, name-safe form used by the
 * auto-minted PAT (Plan 30-04 Task 2).
 *
 * Pipeline:
 *   1. null OR (trimmed === '') → `'unknown'`.
 *   2. Lowercase.
 *   3. Replace any run of `[^a-z0-9-]+` with a single `-` (this folds
 *      whitespace, dots, punctuation, accented letters, etc.).
 *   4. Collapse runs of `-+` to a single `-`.
 *   5. Strip leading + trailing `-`.
 *   6. Truncate to `HOSTNAME_MAX_LEN` chars.
 *   7. If the result is empty (e.g. input was `'!!!'`) → `'unknown'`.
 *
 * This is intentionally LOSSY (Unicode → `-`) — the PAT name is for
 * humans skimming a list, not for round-tripping the hostname.
 */
export function sanitizeHostname(raw: string | null): string {
  if (raw === null) return 'unknown';
  const trimmed = raw.trim();
  if (trimmed === '') return 'unknown';
  let out = trimmed.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  out = out.replace(/-+/g, '-');
  out = out.replace(/^-+|-+$/g, '');
  if (out.length > HOSTNAME_MAX_LEN) {
    out = out.slice(0, HOSTNAME_MAX_LEN);
    // Truncation could leave a trailing '-' if the cut landed mid-run.
    out = out.replace(/-+$/, '');
  }
  return out === '' ? 'unknown' : out;
}

/**
 * Compose the auto-minted PAT name: `cli-<sanitized>-YYYY-MM-DD`.
 *
 * The date segment is built from UTC (not local time) so a CI runner in
 * `Pacific/Apia` and a developer laptop in `Europe/London` minting on the
 * same calendar day produce the same name. The token-name collision policy
 * (decision in plan §truths) intentionally PERMITS duplicates, so any UTC
 * skew is a feature, not a bug.
 *
 * @param sanitizedHostname Pre-sanitized via `sanitizeHostname`. We trust
 *                           the caller — we do NOT re-sanitize here so
 *                           the function stays pure / mock-friendly.
 * @param now                Defaults to the current wall-clock. Tests pass
 *                           an explicit `Date.UTC(...)` for determinism.
 */
export function tokenName(sanitizedHostname: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `cli-${sanitizedHostname}-${yyyy}-${mm}-${dd}`;
}

/**
 * Stash the minted PAT (id + plaintext) on the session so the polling
 * `/auth/device/token` endpoint can return it once.
 *
 * Pre-condition: the session must have been transitioned to `approved`
 * via `approve(userCode, userId)` first. This guards against an out-of-
 * order caller minting a PAT while the user is still in the `pending`
 * (or worse, `denied`) state.
 *
 * Idempotency: a second call with the same args is treated as a no-op
 * (returns true). This makes the verify handler safe against an accidental
 * double-submit without leaking a fresh token.
 *
 * Returns false (no mutation) when:
 *   - session not found (unknown userCode), OR
 *   - session.status !== 'approved'.
 */
export function recordMintedToken(
  userCode: string,
  args: { tokenId: number; token: string },
): boolean {
  const session = findByUserCode(userCode);
  if (!session) return false;
  if (session.status !== 'approved') return false;
  session.mintedTokenId = args.tokenId;
  session.mintedToken = args.token;
  return true;
}

/**
 * Test-only helper. Clears both maps without touching any active cleanup
 * interval. Call from `beforeEach` to isolate cases.
 *
 * @internal
 */
export function _resetForTests(): void {
  byDeviceCode.clear();
  byUserCode.clear();
}
