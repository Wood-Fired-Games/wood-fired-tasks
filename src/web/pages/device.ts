/**
 * Phase 30 Plan 02 — device-flow browser leg page renderers.
 *
 * Two pure functions that build HTML strings via the Phase 29
 * `html`/`layout` primitives (auto-escapes interpolations):
 *
 *   1. renderDevicePage({csrfToken, prefilledUserCode, errorMessage})
 *      The approval form. POSTs to /auth/device/verify with the hidden
 *      CSRF token + the typed-or-prefilled user_code. When `prefilledUserCode`
 *      is non-null the value attribute is set (the field is STILL editable —
 *      Decision D-prompt-4: the user may have copied the wrong code) and a
 *      visible `<p class="prefilled-code">` echo lets the user visually
 *      confirm before submitting.
 *
 *   2. renderDeviceApprovedPage()
 *      The success page rendered after a valid POST /auth/device/verify.
 *      "Approved. You can close this window." — no further links; the
 *      browser leg is done and the CLI's next poll picks up the approval.
 *
 * XSS posture: the route handler validates `?user_code=` against the
 * alphabet regex BEFORE passing it as `prefilledUserCode`, but the
 * `html` tagged template also escapes every interpolation — defense in
 * depth (Threat T-30-02-02).
 *
 * Plan 30-04 will REPLACE the success branch's call to
 * `renderDeviceApprovedPage()` with one that ALSO mints a PAT and stashes
 * it via the same flash mechanism /me/tokens uses. The signature here is
 * deliberately zero-arg so Plan 30-04's expansion can swap in arguments
 * (token preview, PAT id) without breaking the current call site.
 */
import { html, layout, unsafe } from '../html.js';

export interface DevicePageProps {
  /** 64-char hex CSRF token from getOrCreateCsrfToken(request). */
  csrfToken: string;
  /**
   * Server-validated user_code (matches /^[A-HJ-KM-NP-Z2-9]{8}$/) or
   * `null` when no query was supplied OR the query failed validation.
   * Never the raw query string — the route handler MUST validate first.
   */
  prefilledUserCode: string | null;
  /**
   * Set on re-render after a failed POST (CSRF mismatch was already 403'd
   * at the response level — the in-page errors are for the "code not
   * found / expired / wrong format" cases). Rendered with role="alert"
   * BEFORE the form.
   */
  errorMessage: string | null;
}

export function renderDevicePage(props: DevicePageProps): string {
  const { csrfToken, prefilledUserCode, errorMessage } = props;

  const errorBlock = errorMessage
    ? html`
      <p class="error" role="alert">${errorMessage}</p>
    `
    : '';

  const prefilledEcho = prefilledUserCode
    ? html`
      <p class="prefilled-code">${prefilledUserCode}</p>
    `
    : '';

  const body = html`
    <h1>Approve CLI sign-in</h1>
    ${unsafe(errorBlock)}
    ${unsafe(prefilledEcho)}
    <form method="POST" action="/auth/device/verify">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <label>
        User code
        <input
          type="text"
          name="user_code"
          required
          pattern="[A-HJ-KM-NP-Z2-9]{8}"
          maxlength="8"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          autofocus
          value="${prefilledUserCode ?? ''}">
      </label>
      <button type="submit">Approve</button>
    </form>
  `;

  return layout({ title: 'Approve CLI sign-in', body });
}

export function renderDeviceApprovedPage(): string {
  const body = html`
    <h1>Approved</h1>
    <p>You can close this window.</p>
  `;
  return layout({ title: 'Approved', body });
}
