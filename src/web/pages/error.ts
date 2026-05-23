/**
 * Phase 29 Plan 07 — generic error page renderer.
 *
 * Separate from `/auth/error` (which has its own inline page in
 * `src/api/routes/auth/auth-error.ts`). This module is the reusable
 * version for non-OIDC HTML failure modes — e.g. unexpected 500s from
 * /me/tokens, future error surfaces. Status code is the caller's choice
 * (the renderer just returns the body).
 */
import { html, layout } from '../html.js';

export interface RenderErrorOptions {
  message: string;
  /** Optional categorical code shown as a small footer. */
  reason?: string;
}

export function renderError(opts: RenderErrorOptions): string {
  const reasonFragment = opts.reason
    ? html`<p class="error-code">Error code: ${opts.reason}</p>`
    : '';
  const body = html`
    <h1>Something went wrong</h1>
    <p>${opts.message}</p>
    <p><a href="/">Return home</a></p>
    ${reasonFragment}
  `;
  return layout({ title: 'Error', body });
}
