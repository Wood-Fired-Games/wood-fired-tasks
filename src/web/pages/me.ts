/**
 * Phase 29 Plan 07 — profile page renderer.
 *
 * Displays the current session.user (displayName, email, last sign-in)
 * + a "Manage tokens" link + a CSRF-protected POST logout form.
 *
 * Auth method is rendered in a human-friendly label table; `session`
 * is the canonical value here because /me requires a session, but the
 * field is also reachable from PAT-only callers in development — keep
 * the mapping table exhaustive.
 */
import { html, layout } from '../html.js';
import type { AuthenticatedUser, AuthMethod } from '../../types/identity.js';

const AUTH_METHOD_LABEL: Record<AuthMethod, string> = {
  session: 'Google (browser session)',
  pat: 'Personal Access Token',
  legacy: 'Legacy API key',
};

export interface RenderMeOptions {
  user: AuthenticatedUser;
  authMethod: AuthMethod;
  csrf: string;
  /** Epoch ms of the most recent sign-in (null when unknown). */
  authenticatedAt: number | null;
}

export function renderMe(opts: RenderMeOptions): string {
  const lastSignIn = opts.authenticatedAt
    ? new Date(opts.authenticatedAt).toISOString()
    : 'unknown';
  const body = html`
    <h1>${opts.user.displayName}</h1>
    <table>
      <tr><th>Email</th><td>${opts.user.email ?? '—'}</td></tr>
      <tr><th>Auth method</th><td>${AUTH_METHOD_LABEL[opts.authMethod]}</td></tr>
      <tr><th>Last sign-in</th><td>${lastSignIn}</td></tr>
    </table>
    <p><a href="/me/tokens">Manage tokens</a></p>
    <form method="post" action="/auth/logout">
      <input type="hidden" name="_csrf" value="${opts.csrf}">
      <button type="submit">Sign out</button>
    </form>
  `;
  return layout({ title: 'Profile', body });
}
