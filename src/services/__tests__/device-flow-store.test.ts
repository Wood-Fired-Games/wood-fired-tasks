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

    it('accepts null hostname', () => {
      const s = createSession({ clientId: 'cid', hostname: null });
      expect(s.hostname).toBeNull();
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
});
