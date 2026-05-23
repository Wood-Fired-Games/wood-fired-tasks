// Type-level smoke tests for the Phase 28 identity boundary projections.
//
// These assertions are evaluated by the TypeScript compiler, not at runtime —
// vitest discovers the file but the bodies are intentionally empty (the type
// system has already done the work by the time `vitest` runs).
//
// If any of these assertions fail to compile, `tsc --noEmit` will surface the
// error and `npm test` will refuse to load the file.

import { describe, it, expectTypeOf } from 'vitest';
import type {
  AuthenticatedUser,
  AuthMethod,
  AuthResult,
} from '../identity.js';

describe('AuthenticatedUser', () => {
  it('has the exact camelCase boundary shape', () => {
    expectTypeOf<AuthenticatedUser>().toEqualTypeOf<{
      id: number;
      displayName: string;
      email: string | null;
      isLegacy: boolean;
      isServiceAccount: boolean;
    }>();
  });

  it('rejects snake_case row shape (negative)', () => {
    const snakeRow = {
      id: 1,
      displayName: 'x',
      email: null,
      is_legacy: 0,
      is_service_account: 0,
    };
    // @ts-expect-error — a snake_case `is_legacy: number` row must NOT be
    // assignable to `AuthenticatedUser` (which requires camelCase booleans).
    const _bad: AuthenticatedUser = snakeRow;
    void _bad;
  });

  it('rejects number where boolean required (negative)', () => {
    const _bad: AuthenticatedUser = {
      id: 1,
      displayName: 'x',
      email: null,
      // @ts-expect-error — `isLegacy: 0` (number) must NOT satisfy `boolean`.
      isLegacy: 0,
      isServiceAccount: false,
    };
    void _bad;
  });
});

describe('AuthMethod', () => {
  it('is the exact union "pat" | "session" | "legacy"', () => {
    expectTypeOf<AuthMethod>().toEqualTypeOf<'pat' | 'session' | 'legacy'>();
  });

  it('rejects other strings (negative)', () => {
    // @ts-expect-error — 'oidc' is not a valid AuthMethod in Phase 28.
    const _bad: AuthMethod = 'oidc';
    void _bad;
  });
});

describe('AuthResult', () => {
  it('has user, authMethod, and nullable tokenId', () => {
    expectTypeOf<AuthResult>().toEqualTypeOf<{
      user: AuthenticatedUser;
      authMethod: AuthMethod;
      tokenId: number | null;
    }>();
  });
});
