/**
 * Phase 30 Plan 01 Task 1 — device-flow-store unit tests.
 *
 * Exercises the in-memory store that backs the RFC 8628 device-authorization
 * endpoints (Plans 30-02 / 30-04 layer browser + mint on top). Focuses on the
 * invariants the route handlers depend on:
 *
 *   - createSession produces RFC-compliant device_code + user_code shapes
 *   - user_code alphabet is provably free of 0/O/I/1/L confusables
 *   - approve / deny / remove are state-machine-safe (idempotent + reject
 *     non-pending transitions)
 *   - startCleanup prunes expired sessions and the setInterval handle is
 *     `.unref()`'d so vitest does not hang
 *   - _resetForTests gives suites a fresh module-scope between cases
 *
 * The store uses real `randomBytes` for the device_code (no mock needed —
 * 32 bytes of randomness is fine for unit tests) and rejection-samples
 * the user_code so the alphabet assertion is meaningful.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSession,
  findByDeviceCode,
  findByUserCode,
  approve,
  deny,
  remove,
  startCleanup,
  _resetForTests,
  sanitizeHostname,
  tokenName,
  recordMintedToken,
  SESSION_TTL_MS,
  CLEANUP_TICK_MS,
  USER_CODE_ALPHABET,
} from '../device-flow-store.js';

// Locked alphabet per CLI-01: no 0/O/1/I/L confusables.
const FORBIDDEN_CHARS = '0OI1L';

describe('device-flow-store', () => {
  beforeEach(() => {
    _resetForTests();
  });

  describe('constants', () => {
    it('exports SESSION_TTL_MS = 600_000 (10 min, RFC 8628 default)', () => {
      expect(SESSION_TTL_MS).toBe(600_000);
    });

    it('exports CLEANUP_TICK_MS = 60_000 (60s prune cadence)', () => {
      expect(CLEANUP_TICK_MS).toBe(60_000);
    });

    it('USER_CODE_ALPHABET is the 31-symbol no-confusable set', () => {
      expect(USER_CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
      expect(USER_CODE_ALPHABET).toHaveLength(31);
      // None of the forbidden chars appear.
      for (const c of FORBIDDEN_CHARS) {
        expect(USER_CODE_ALPHABET).not.toContain(c);
      }
    });
  });

  describe('createSession', () => {
    it('returns the expected shape with status=pending and null mint fields', () => {
      const s = createSession({ clientId: 'cid', hostname: 'laptop' });
      expect(s.status).toBe('pending');
      expect(s.clientId).toBe('cid');
      expect(s.hostname).toBe('laptop');
      expect(s.interval).toBe(5);
      expect(s.lastPollAt).toBe(0);
      expect(s.approvedUserId).toBeNull();
      expect(s.mintedTokenId).toBeNull();
      expect(s.mintedToken).toBeNull();
      expect(s.createdAt).toBeTypeOf('number');
      expect(s.expiresAt).toBe(s.createdAt + SESSION_TTL_MS);
      // device_code is base64url, ≥43 chars (32 random bytes => 43 chars).
      expect(s.deviceCode).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      // user_code is 8 chars from the locked alphabet.
      expect(s.userCode).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
    });

    it('null hostname is sanitized to "unknown" at create time (Plan 30-04)', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      expect(s.hostname).toBe('unknown');
    });

    it('non-null hostname is sanitized at create time (Plan 30-04)', () => {
      const s = createSession({ clientId: 'cid', hostname: 'Some Host!' });
      expect(s.hostname).toBe('some-host');
    });

    it('user_code alphabet contains no 0/O/1/I/L across 10_000 generations', () => {
      for (let i = 0; i < 10_000; i++) {
        const s = createSession({ clientId: 'cid', hostname: null });
        for (const c of s.userCode) {
          expect(FORBIDDEN_CHARS).not.toContain(c);
        }
      }
    });

    it('user_code uniqueness: 1000 sessions produce 1000 distinct codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        codes.add(createSession({ clientId: 'cid', hostname: null }).userCode);
      }
      expect(codes.size).toBe(1000);
    });

    it('device_code uniqueness: 1000 sessions produce 1000 distinct codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        codes.add(
          createSession({ clientId: 'cid', hostname: null }).deviceCode,
        );
      }
      expect(codes.size).toBe(1000);
    });
  });

  describe('findByDeviceCode / findByUserCode', () => {
    it('findByDeviceCode returns the session for a known code', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      const found = findByDeviceCode(s.deviceCode);
      expect(found).toBeDefined();
      expect(found?.userCode).toBe(s.userCode);
    });

    it('findByUserCode returns the session for a known code', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      const found = findByUserCode(s.userCode);
      expect(found).toBeDefined();
      expect(found?.deviceCode).toBe(s.deviceCode);
    });

    it('findByDeviceCode returns undefined for unknown code', () => {
      expect(findByDeviceCode('not-a-real-code')).toBeUndefined();
    });

    it('findByUserCode returns undefined for unknown code', () => {
      expect(findByUserCode('XXXX-NOPE')).toBeUndefined();
    });
  });

  describe('approve', () => {
    it('transitions pending → approved and stamps approvedUserId', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      expect(approve(s.userCode, 42)).toBe(true);
      const after = findByDeviceCode(s.deviceCode);
      expect(after?.status).toBe('approved');
      expect(after?.approvedUserId).toBe(42);
    });

    it('is idempotent: re-approving an already-approved session returns true', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      expect(approve(s.userCode, 42)).toBe(true);
      expect(approve(s.userCode, 42)).toBe(true);
    });

    it('returns false for unknown userCode', () => {
      expect(approve('NOPE-NOPE', 1)).toBe(false);
    });

    it('returns false for a denied session', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      expect(deny(s.userCode)).toBe(true);
      expect(approve(s.userCode, 1)).toBe(false);
    });
  });

  describe('deny', () => {
    it('transitions pending → denied; returns true', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      expect(deny(s.userCode)).toBe(true);
      expect(findByDeviceCode(s.deviceCode)?.status).toBe('denied');
    });

    it('returns false on second call (already-denied)', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      expect(deny(s.userCode)).toBe(true);
      expect(deny(s.userCode)).toBe(false);
    });

    it('returns false for unknown userCode', () => {
      expect(deny('NOPE-NOPE')).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes from both maps', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      remove(s.deviceCode);
      expect(findByDeviceCode(s.deviceCode)).toBeUndefined();
      expect(findByUserCode(s.userCode)).toBeUndefined();
    });

    it('is a no-op for unknown deviceCode', () => {
      // Should not throw.
      remove('does-not-exist');
    });
  });

  describe('startCleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('prunes expired sessions on each tick', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      // Force expiry — mutate via findByDeviceCode (returned ref points at
      // the stored object).
      const ref = findByDeviceCode(s.deviceCode);
      expect(ref).toBeDefined();
      if (ref) {
        ref.expiresAt = Date.now() - 1;
      }
      const handle = startCleanup();
      vi.advanceTimersByTime(CLEANUP_TICK_MS + 10);
      expect(findByDeviceCode(s.deviceCode)).toBeUndefined();
      expect(findByUserCode(s.userCode)).toBeUndefined();
      handle.stop();
    });

    it('leaves non-expired sessions alone', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      const handle = startCleanup();
      vi.advanceTimersByTime(CLEANUP_TICK_MS + 10);
      expect(findByDeviceCode(s.deviceCode)).toBeDefined();
      handle.stop();
    });

    it('stop() is idempotent (no throw on second call)', () => {
      const handle = startCleanup();
      handle.stop();
      // Second call should be a no-op, not throw.
      handle.stop();
    });
  });

  describe('_resetForTests', () => {
    it('clears both maps', () => {
      const s1 = createSession({ clientId: 'cid', hostname: null });
      const s2 = createSession({ clientId: 'cid', hostname: null });
      _resetForTests();
      expect(findByDeviceCode(s1.deviceCode)).toBeUndefined();
      expect(findByUserCode(s2.userCode)).toBeUndefined();
    });
  });

  /**
   * Phase 30 Plan 04 Task 1 — sanitization + mint-recording helpers.
   *
   * The store owns the lifecycle of session state, so the PAT-mint metadata
   * (sanitized hostname + minted token) lives here even though the actual
   * mint happens in the verify handler (Plan 30-04 Task 2).
   */
  describe('sanitization + mint recording (Plan 30-04)', () => {
    describe('sanitizeHostname', () => {
      it('null → "unknown"', () => {
        expect(sanitizeHostname(null)).toBe('unknown');
      });

      it('empty string → "unknown"', () => {
        expect(sanitizeHostname('')).toBe('unknown');
      });

      it("apostrophes collapse to '-' (\"Stuart's Laptop\" → \"stuart-s-laptop\")", () => {
        expect(sanitizeHostname("Stuart's Laptop")).toBe('stuart-s-laptop');
      });

      it('weird input is trimmed + collapsed', () => {
        expect(sanitizeHostname('   --weird___name!!!  ')).toBe('weird-name');
      });

      it('long input is truncated to 32 chars and lowercased', () => {
        const out = sanitizeHostname('A'.repeat(100));
        expect(out).toHaveLength(32);
        expect(out).toBe('a'.repeat(32));
      });

      it('uppercase is lowercased; hyphens preserved', () => {
        expect(sanitizeHostname('UPPER-case')).toBe('upper-case');
      });

      it('dots collapse to "-"', () => {
        expect(sanitizeHostname('a.b.c')).toBe('a-b-c');
      });

      it('whitespace-only input → "unknown"', () => {
        expect(sanitizeHostname('   ')).toBe('unknown');
      });

      it('input that sanitizes to only hyphens → "unknown"', () => {
        expect(sanitizeHostname('!!!')).toBe('unknown');
      });
    });

    describe('tokenName', () => {
      it('produces "cli-<host>-<YYYY-MM-DD>" with explicit UTC date', () => {
        // May 23, 2026 — Date.UTC month is 0-indexed (4 = May).
        const d = new Date(Date.UTC(2026, 4, 23));
        expect(tokenName('laptop', d)).toBe('cli-laptop-2026-05-23');
      });

      it('uses "unknown" segment when sanitized host is "unknown"', () => {
        const d = new Date(Date.UTC(2026, 0, 1));
        expect(tokenName('unknown', d)).toBe('cli-unknown-2026-01-01');
      });

      it('uses UTC (not local) for the date segment', () => {
        // 2026-05-23T23:30Z is still 2026-05-23 in UTC even if local TZ rolls.
        const d = new Date(Date.UTC(2026, 4, 23, 23, 30, 0));
        expect(tokenName('laptop', d)).toBe('cli-laptop-2026-05-23');
      });

      it('pads single-digit month and day', () => {
        const d = new Date(Date.UTC(2026, 0, 5)); // Jan 5
        expect(tokenName('h', d)).toBe('cli-h-2026-01-05');
      });

      it('defaults to current Date when now is omitted', () => {
        const out = tokenName('host');
        expect(out).toMatch(/^cli-host-\d{4}-\d{2}-\d{2}$/);
      });
    });

    describe('recordMintedToken', () => {
      it('happy path: approve then record → session populated', () => {
        const s = createSession({ clientId: 'cid', hostname: 'laptop' });
        expect(approve(s.userCode, 7)).toBe(true);
        expect(
          recordMintedToken(s.userCode, { tokenId: 42, token: 'wft_pat_XYZ' }),
        ).toBe(true);
        const after = findByDeviceCode(s.deviceCode);
        expect(after?.mintedTokenId).toBe(42);
        expect(after?.mintedToken).toBe('wft_pat_XYZ');
      });

      it('returns false when session is still pending (approve not called)', () => {
        const s = createSession({ clientId: 'cid', hostname: 'laptop' });
        expect(
          recordMintedToken(s.userCode, { tokenId: 1, token: 'wft_pat_X' }),
        ).toBe(false);
        // Session must remain untouched.
        const after = findByDeviceCode(s.deviceCode);
        expect(after?.mintedTokenId).toBeNull();
        expect(after?.mintedToken).toBeNull();
      });

      it('returns false for unknown userCode', () => {
        expect(
          recordMintedToken('UNKNOWN1', {
            tokenId: 1,
            token: 'wft_pat_X',
          }),
        ).toBe(false);
      });

      it('returns false when session is denied', () => {
        const s = createSession({ clientId: 'cid', hostname: 'laptop' });
        expect(deny(s.userCode)).toBe(true);
        expect(
          recordMintedToken(s.userCode, { tokenId: 1, token: 'wft_pat_X' }),
        ).toBe(false);
      });

      it('is idempotent: second call with same args still returns true', () => {
        const s = createSession({ clientId: 'cid', hostname: 'laptop' });
        approve(s.userCode, 7);
        expect(
          recordMintedToken(s.userCode, { tokenId: 9, token: 'wft_pat_A' }),
        ).toBe(true);
        expect(
          recordMintedToken(s.userCode, { tokenId: 9, token: 'wft_pat_A' }),
        ).toBe(true);
        const after = findByDeviceCode(s.deviceCode);
        expect(after?.mintedTokenId).toBe(9);
        expect(after?.mintedToken).toBe('wft_pat_A');
      });
    });
  });
});
