/**
 * Phase 29 Plan 07 — login page renderer.
 *
 * Anonymous, server-rendered HTML. The single CTA is a link (not a form)
 * to /auth/login; GET is safe here because /auth/login initiates the
 * IdP redirect via Cache-Control: no-store and a session-stashed PKCE
 * verifier. No CSRF on the link itself — the IdP roundtrip's state
 * nonce covers the same threat class.
 */
import { html, layout } from '../html.js';

export interface RenderLoginOptions {
  /** Optional next-path to forward through the IdP roundtrip. */
  next?: string;
}

export function renderLogin(opts: RenderLoginOptions = {}): string {
  const href =
    typeof opts.next === 'string' && opts.next.length > 0
      ? `/auth/login?next=${encodeURIComponent(opts.next)}`
      : '/auth/login';
  const body = html`
    <h1>Sign in</h1>
    <p>Authenticate with your Google account to manage tasks and access tokens.</p>
    <p><a href="${href}" class="button">Sign in with Google</a></p>
  `;
  return layout({ title: 'Sign in', body });
}
