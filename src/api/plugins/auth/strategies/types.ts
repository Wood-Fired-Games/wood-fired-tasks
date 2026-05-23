// Shared discriminated-union type for auth-strategy outcomes.
//
// Every strategy (PAT, session, legacy) implements
//   tryAuth(request, deps): Promise<StrategyOutcome>
//
// The chain plugin (Phase 28 Plan 04) composes the strategies and acts on
// each kind:
//
//   - 'skip'  — strategy did not see its credential (e.g. PAT: no
//               Authorization header; legacy: no x-api-key header).
//               Chain proceeds to the next strategy.
//   - 'match' — strategy matched. Chain populates request.user / authMethod
//               / tokenId, runs last_used_at write-through (PAT), and lets
//               the request proceed.
//   - 'fail'  — strategy saw its credential but rejected it. Chain
//               short-circuits with a 401 carrying the reasonCode in the
//               audit log via logAuthFailure (Phase 27 helper). Other
//               strategies are NOT tried.
//
// Splitting outcomes this way means strategies are pure async functions:
// they NEVER touch request.user, NEVER decorate, NEVER call request.log.warn
// (the chain owns side effects). This keeps Phase 29's session-strategy swap
// surgical and keeps unit tests free of Fastify boilerplate.
import type { AuthResult } from '../../../../types/identity.js';
import type { AuthFailureReason } from '../../../../services/auth-audit.js';

export type StrategyOutcome =
  | { kind: 'skip' }
  | { kind: 'match'; result: AuthResult; label?: string }
  | { kind: 'fail'; reasonCode: AuthFailureReason };
