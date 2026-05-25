import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  logAuthFailure,
  type AuthStrategy,
  type AuthFailureReason,
  type AuthFailureContext,
} from '../auth-audit.js';

// Sentinel secrets that should NEVER appear in the logged payload.
// The helper has no parameter slot for them — these constants exist only
// to assert via serialization that nothing leaks into the structured log.
const SENTINEL_SECRETS = [
  'wft_pat_DEADBEEFDEADBEEFDEADBEEFDEADBEEF',
  'sk-test-secret-value',
  'super-secret-password-123',
];

const ALL_STRATEGIES: AuthStrategy[] = ['pat', 'session', 'legacy'];
const ALL_REASON_CODES: AuthFailureReason[] = [
  'missing_credential',
  'malformed',
  'unknown_token',
  'revoked',
  'expired',
  'user_disabled',
  'wrong_prefix',
];

function makeMockLogger() {
  return { warn: vi.fn() };
}

function baseCtx(
  overrides: Partial<AuthFailureContext> = {},
): AuthFailureContext {
  return {
    strategy: 'pat',
    reasonCode: 'unknown_token',
    requestId: 'req-abc-123',
    peerIp: '1.2.3.4',
    ...overrides,
  };
}

describe('logAuthFailure', () => {
  let mock: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    mock = makeMockLogger();
  });

  it('emits exactly one warn call', () => {
    logAuthFailure(mock, baseCtx());
    expect(mock.warn).toHaveBeenCalledTimes(1);
  });

  it('structured payload contains strategy, reasonCode, requestId, peerIp', () => {
    logAuthFailure(
      mock,
      baseCtx({
        strategy: 'pat',
        reasonCode: 'unknown_token',
        requestId: 'r1',
        peerIp: '10.0.0.1',
      }),
    );
    const [payload] = mock.warn.mock.calls[0] as [Record<string, unknown>, string?];
    expect(payload).toMatchObject({
      strategy: 'pat',
      reasonCode: 'unknown_token',
      requestId: 'r1',
      peerIp: '10.0.0.1',
    });
  });

  it("structured payload includes tag: 'auth.failure'", () => {
    logAuthFailure(mock, baseCtx());
    const [payload] = mock.warn.mock.calls[0] as [Record<string, unknown>, string?];
    expect(payload.tag).toBe('auth.failure');
  });

  it('second arg is a human-readable message string', () => {
    logAuthFailure(mock, baseCtx());
    const args = mock.warn.mock.calls[0];
    expect(typeof args[1]).toBe('string');
    expect((args[1] as string).length).toBeGreaterThan(0);
  });

  it('logs at warn level (no info/error/debug calls)', () => {
    const fullLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    logAuthFailure(fullLogger, baseCtx());
    expect(fullLogger.warn).toHaveBeenCalledTimes(1);
    expect(fullLogger.info).not.toHaveBeenCalled();
    expect(fullLogger.error).not.toHaveBeenCalled();
    expect(fullLogger.debug).not.toHaveBeenCalled();
  });

  it.each(ALL_STRATEGIES)('accepts strategy %s without throwing', (strategy) => {
    expect(() => logAuthFailure(mock, baseCtx({ strategy }))).not.toThrow();
    const [payload] = mock.warn.mock.calls[0] as [Record<string, unknown>, string?];
    expect(payload.strategy).toBe(strategy);
  });

  it.each(ALL_REASON_CODES)(
    'accepts reasonCode %s without throwing',
    (reasonCode) => {
      expect(() => logAuthFailure(mock, baseCtx({ reasonCode }))).not.toThrow();
      const [payload] = mock.warn.mock.calls[0] as [Record<string, unknown>, string?];
      expect(payload.reasonCode).toBe(reasonCode);
    },
  );

  describe('no secret leak (fuzz across strategy × reasonCode)', () => {
    for (const strategy of ALL_STRATEGIES) {
      for (const reasonCode of ALL_REASON_CODES) {
        it(`payload contains no sentinel secret for (${strategy}, ${reasonCode})`, () => {
          const localMock = makeMockLogger();
          logAuthFailure(
            localMock,
            baseCtx({
              strategy,
              reasonCode,
              requestId: 'req-fuzz-1',
              peerIp: '198.51.100.7',
            }),
          );
          expect(localMock.warn).toHaveBeenCalledTimes(1);
          const serialized = JSON.stringify(localMock.warn.mock.calls[0]);
          for (const secret of SENTINEL_SECRETS) {
            expect(serialized).not.toContain(secret);
          }
        });
      }
    }
  });

  it('helper source file has no secret/token/credential/password parameter slot', () => {
    // The contract is enforced at the type level — there is no way to pass a
    // secret to logAuthFailure. This is a source-level sanity check: the
    // implementation file must not name a parameter or property after a
    // secret-shaped identifier.
    const here = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(here, '..', 'auth-audit.ts');
    const src = readFileSync(sourcePath, 'utf8');
    // No declaration like `secret:` / `token:` / `password:` / `credential:`
    // (i.e. as a property/parameter type — colon form).
    expect(src).not.toMatch(/\b(secret|token|password|credential)\s*:/i);
  });

  it('payload keys are exactly { tag, strategy, reasonCode, requestId, peerIp }', () => {
    logAuthFailure(mock, baseCtx());
    const [payload] = mock.warn.mock.calls[0] as [Record<string, unknown>, string?];
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual(
      ['peerIp', 'reasonCode', 'requestId', 'strategy', 'tag'].sort(),
    );
  });

  it('TypeScript signature rejects unknown strategy at compile time', () => {
    // The next call is intentionally a type error: 'unknown' is not in the
    // AuthStrategy literal union. The @ts-expect-error directive proves the
    // type system rejects it — if a future change widens AuthStrategy and
    // makes this valid, the directive itself becomes an error and this test
    // fails.
    logAuthFailure(mock, {
      // @ts-expect-error — 'unknown' is not assignable to AuthStrategy
      strategy: 'unknown',
      reasonCode: 'unknown_token',
      requestId: 'r1',
      peerIp: '1.2.3.4',
    });
  });

  it('TypeScript signature rejects unknown reasonCode at compile time', () => {
    logAuthFailure(mock, {
      strategy: 'pat',
      // @ts-expect-error — 'not_a_reason' is not assignable to AuthFailureReason
      reasonCode: 'not_a_reason',
      requestId: 'r1',
      peerIp: '1.2.3.4',
    });
  });
});
