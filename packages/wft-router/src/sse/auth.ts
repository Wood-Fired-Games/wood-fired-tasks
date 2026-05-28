/**
 * Auth-header rule for the wft-router SSE client.
 *
 * Mirrors the precedence wired into `src/mcp/remote/rest-client.ts:80-84`:
 *
 *   - apiKey starts with `wft_pat_` → `Authorization: Bearer <apiKey>`
 *     (PAT path; the server's PAT strategy hashes the full string).
 *   - any other apiKey → `X-API-Key: <apiKey>` (legacy path).
 *
 * The two headers are mutually exclusive so the server's auth chain never
 * has to pick between two strategies for the same request — same contract
 * as the REST client.
 *
 * Isolated as its own module so the spec rule is asserted directly (no
 * fetch-mock round-trip needed) and so the SSE client never reaches across
 * into the root `src/` tree (standalone-package isolation, docs/event-
 * router-design.md §"Architecture").
 */

/**
 * Literal PAT prefix shared with `src/services/pat-hash.ts` and the remote
 * MCP rest-client (`src/mcp/remote/rest-client.ts:38`). Duplicated as a
 * constant inside the wft-router package so the SSE client doesn't drag in
 * the server-side PAT helpers.
 */
export const PAT_PREFIX = 'wft_pat_';

/**
 * Result shape: a single header name + value pair. The SSE client merges
 * this into the fetch headers verbatim.
 */
export interface AuthHeader {
  readonly name: string;
  readonly value: string;
}

/**
 * Pick the authentication header for a given API key.
 *
 * Mirrors `src/mcp/remote/rest-client.ts:80-84`:
 *   - `wft_pat_...` → `Authorization: Bearer <value>`
 *   - everything else → `X-API-Key: <value>`
 *
 * The full apiKey value flows through verbatim — the server's PAT strategy
 * needs the entire `wft_pat_<body>` string for the SHA-256 lookup.
 */
export function authHeader(apiKey: string): AuthHeader {
  if (apiKey.startsWith(PAT_PREFIX)) {
    return { name: 'Authorization', value: `Bearer ${apiKey}` };
  }
  return { name: 'X-API-Key', value: apiKey };
}
