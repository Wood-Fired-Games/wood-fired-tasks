/**
 * Phase 29 Plan 07 — token management page renderer.
 *
 * Sections (top → bottom):
 *   1. One-shot minted-token aside (only when `mintedToken` is set; flash
 *      caller MUST consume `getFlashAndClear` BEFORE rendering so a
 *      subsequent refresh does not re-display the full token).
 *   2. Active tokens table — name, prefix…suffix, created, last-used,
 *      expires, "Revoke" form per row.
 *   3. New-token form — name (required), scopes csv (optional),
 *      expiresAt datetime-local (optional). Posts to /api/v1/me/tokens
 *      with the CSRF token + `Accept: text/html` is implicit from the
 *      browser (the route handler's content-negotiation branch fires).
 *   4. Revoked tokens table (only when at least one revoked row exists),
 *      greyed out via the `revoked` CSS class.
 *
 * B1 fix (PLAN-CHECK B1): the "New token" form's action MUST be
 * `/api/v1/me/tokens` — that is the only mint endpoint. The cheerio
 * test under tokens-mint-html.test.ts asserts the form action.
 */
import { html, layout, unsafe } from '../html.js';

export interface TokenRow {
  id: number;
  name: string;
  prefix: string;
  suffix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

export interface RenderTokensOptions {
  tokens: TokenRow[];
  /** Set ONLY on the post-mint GET (flash-and-clear consumed). */
  mintedToken: { id: number; token: string } | undefined;
  csrf: string;
}

export function renderTokens(opts: RenderTokensOptions): string {
  const active = opts.tokens.filter((t) => t.revokedAt === null);
  const revoked = opts.tokens.filter((t) => t.revokedAt !== null);

  const mintedBlock = opts.mintedToken
    ? html`
      <aside class="minted-token">
        <h2>Token created</h2>
        <p><strong>This will not be shown again.</strong> Copy it now.</p>
        <p><code id="minted-token-value">${opts.mintedToken.token}</code></p>
        <button type="button" onclick="navigator.clipboard&amp;&amp;navigator.clipboard.writeText(document.getElementById('minted-token-value').textContent)">Copy</button>
      </aside>
    `
    : '';

  const activeRows = active.map(
    (t) => html`
      <tr>
        <td>${t.name}</td>
        <td><code>${t.prefix}…${t.suffix}</code></td>
        <td>${t.createdAt}</td>
        <td>${t.lastUsedAt ?? '—'}</td>
        <td>${t.expiresAt ?? '—'}</td>
        <td>
          <form method="post" action="/me/tokens/${t.id}/revoke" style="display:inline">
            <input type="hidden" name="_csrf" value="${opts.csrf}">
            <button type="submit">Revoke</button>
          </form>
        </td>
      </tr>
    `,
  );

  const revokedRows = revoked.map(
    (t) => html`
      <tr class="revoked">
        <td>${t.name}</td>
        <td><code>${t.prefix}…${t.suffix}</code></td>
        <td>${t.revokedAt}</td>
      </tr>
    `,
  );

  const revokedSection =
    revoked.length > 0
      ? html`
        <h2>Revoked tokens</h2>
        <table>
          <thead><tr><th>Name</th><th>Token</th><th>Revoked at</th></tr></thead>
          <tbody>${revokedRows.map((s) => unsafe(s))}</tbody>
        </table>
      `
      : '';

  const body = html`
    <h1>Personal access tokens</h1>
    ${unsafe(mintedBlock)}

    <h2>Active tokens</h2>
    <table>
      <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
      <tbody>${activeRows.map((s) => unsafe(s))}</tbody>
    </table>

    <h2>New token</h2>
    <form method="post" action="/api/v1/me/tokens">
      <input type="hidden" name="_csrf" value="${opts.csrf}">
      <label>Name <input type="text" name="name" required maxlength="100"></label>
      <label>Scopes (comma-separated, optional) <input type="text" name="scopes"></label>
      <label>Expires at (optional) <input type="datetime-local" name="expiresAt"></label>
      <button type="submit">Mint token</button>
    </form>

    ${unsafe(revokedSection)}
  `;
  return layout({ title: 'Tokens', body });
}
