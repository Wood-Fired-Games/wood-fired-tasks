import { z } from 'zod';

/**
 * Canonical PAT scope taxonomy (Security Audit finding M1 — task #1620).
 *
 * A closed, flat set of three tiers ordered `read < write < admin`. This is
 * the FOUNDATION module for a five-task chain: #1621 (enforce scopes in the
 * auth chain), #1622 (declare required scopes per route), #1623 (align CLI
 * token surfaces), #1631 (enforce on the stdio MCP surface), and #1635
 * (project_id scoping) all import from here rather than re-declaring the
 * tier set. Do NOT add resource-qualified scopes (e.g. `"tasks:read"`)
 * without updating every consumer — the shape is intentionally a closed,
 * flat enum.
 *
 * This module is mint-time-validation ONLY (task #1620). It does not gate
 * any request — that is #1621's job.
 */
export const PAT_SCOPES = ['read', 'write', 'admin'] as const;

/** One of the three canonical taxonomy tiers. */
export type PatScope = (typeof PAT_SCOPES)[number];

/** Zod schema for a single scope string, validated against the closed taxonomy. */
export const PatScopeSchema = z.enum(PAT_SCOPES);

/** Ordinal rank backing {@link scopeSatisfies} — higher rank ⇒ broader access. */
const SCOPE_RANK: Record<PatScope, number> = {
  read: 0,
  write: 1,
  admin: 2,
};

/** True iff `value` is one of the three canonical taxonomy tiers. */
export function isPatScope(value: string): value is PatScope {
  return Object.prototype.hasOwnProperty.call(SCOPE_RANK, value);
}

/**
 * Filter `scopes` down to the subset that are NOT members of the taxonomy.
 * An empty result means every requested scope is valid.
 *
 * Used at both the mint-time API boundary (`POST /me/tokens`) and the
 * repository boundary (`ApiTokenRepository.insert`) to reject unknown scope
 * strings before a token is ever persisted.
 */
export function findUnknownScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !isPatScope(s));
}

/**
 * `satisfies`-style predicate: true when the `granted` tier is at or above
 * the `required` tier on the `read < write < admin` ordering.
 *
 * `admin` satisfies `read`, `write`, and `admin`; `write` satisfies `read`
 * and `write` but NOT `admin`; `read` satisfies only `read`.
 */
export function scopeSatisfies(granted: PatScope, required: PatScope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}
