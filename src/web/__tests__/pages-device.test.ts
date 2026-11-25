/**
 * Phase 30 Plan 02 Task 1 — renderDevicePage / renderDeviceApprovedPage tests.
 *
 * Subject: pure HTML rendering for the device-flow browser leg.
 *   1. renderDevicePage({csrfToken, prefilledUserCode, errorMessage})
 *      - shape: form action=/auth/device/verify, hidden _csrf input,
 *        user_code text input, submit button
 *      - prefilledUserCode (when set) is reflected into the input's
 *        value attribute AND appears as a confirmation <p>
 *      - errorMessage (when set) renders BEFORE the form with role="alert"
 *      - XSS resistance: malicious prefilledUserCode never leaks a literal
 *        `<script>` tag into the output (the route-level alphabet check is
 *        the primary guard; this is defense in depth via the html`` tagged
 *        template)
 *      - csrfToken reflected verbatim
 *      - output starts with `<!doctype html>` — full page, not a fragment
 *   2. renderDeviceApprovedPage() — success page contains 'Approved' AND
 *      'close this window'.
 */
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  renderDevicePage,
  renderDeviceApprovedPage,
  renderDeviceDeniedPage,
} from '../pages/device.js';

const CSRF = 'a'.repeat(64);

describe('renderDevicePage', () => {
  it('basic shape: no prefill, no error → form has action + _csrf input + user_code input + submit', () => {
    const out = renderDevicePage({
      csrfToken: CSRF,
      prefilledUserCode: null,
      errorMessage: null,
    });
    expect(out.toLowerCase()).toMatch(/^<!doctype html>/);
    const $ = cheerio.load(out);
    const form = $('form');
    expect(form.attr('action')).toBe('/auth/device/verify');
    expect(form.attr('method')?.toLowerCase()).toBe('post');
    // Hidden _csrf input
    const csrfInput = form.find('input[name="_csrf"]');
    expect(csrfInput.attr('type')).toBe('hidden');
    expect(csrfInput.attr('value')).toBe(CSRF);
    // Visible user_code input
    const ucInput = form.find('input[name="user_code"]');
    expect(ucInput.length).toBe(1);
    expect(ucInput.attr('required')).not.toBeUndefined();
    expect(ucInput.attr('maxlength')).toBe('8');
    expect(ucInput.attr('pattern')).toBe('[A-HJ-KM-NP-Z2-9]{8}');
    // Without a machine name: a single Continue button, no Approve
    expect(form.find('button[type="submit"]').length).toBe(1);
    expect(form.find('button[value="continue"]').length).toBe(1);
    expect(form.find('button[value="approve"]').length).toBe(0);
    // No prefilled-code paragraph when prefilledUserCode is null
    expect($('p.prefilled-code').length).toBe(0);
    // No error paragraph when errorMessage is null
    expect($('p.error').length).toBe(0);
  });

  it('prefills user_code: value attribute set AND prefilled-code <p> rendered', () => {
    const out = renderDevicePage({
      csrfToken: CSRF,
      prefilledUserCode: 'ABCDEFGH',
      errorMessage: null,
    });
    const $ = cheerio.load(out);
    expect($('input[name="user_code"]').attr('value')).toBe('ABCDEFGH');
    const pCode = $('p.prefilled-code');
    expect(pCode.length).toBe(1);
    expect(pCode.text()).toBe('ABCDEFGH');
  });

  it('renders error paragraph BEFORE the form with role="alert"', () => {
    const out = renderDevicePage({
      csrfToken: CSRF,
      prefilledUserCode: null,
      errorMessage: 'Code expired.',
    });
    const $ = cheerio.load(out);
    const err = $('p.error');
    expect(err.length).toBe(1);
    expect(err.attr('role')).toBe('alert');
    expect(err.text()).toBe('Code expired.');
    // BEFORE the form — same parent, error's index < form's index.
    const main = err.parent();
    const errIdx = main.children().index(err);
    const formIdx = main.children().index($('form'));
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(formIdx).toBeGreaterThan(errIdx);
  });

  it('XSS: malicious prefilledUserCode is escaped (no literal <script> tag in output)', () => {
    // The route-level alphabet check should reject this, but defense in
    // depth — the html`` template MUST escape the angle brackets.
    const out = renderDevicePage({
      csrfToken: CSRF,
      prefilledUserCode: '<script>alert(1)</script>',
      errorMessage: null,
    });
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('csrfToken reflected verbatim into the hidden input', () => {
    const token = 'deadbeef'.repeat(8); // 64 hex chars
    const out = renderDevicePage({
      csrfToken: token,
      prefilledUserCode: null,
      errorMessage: null,
    });
    const $ = cheerio.load(out);
    expect($('input[name="_csrf"]').attr('value')).toBe(token);
  });

  it('output begins with <!doctype html> (full document, not fragment)', () => {
    const out = renderDevicePage({
      csrfToken: CSRF,
      prefilledUserCode: null,
      errorMessage: null,
    });
    expect(out.toLowerCase().startsWith('<!doctype html>')).toBe(true);
  });

  it('shows the requesting machine name when one is supplied', () => {
    const out = renderDevicePage({
      csrfToken: CSRF,
      prefilledUserCode: 'ABCDEFGH',
      errorMessage: null,
      requestingMachine: 'build-box-7',
    });
    const $ = cheerio.load(out);
    expect($('.requesting-machine').text()).toContain('build-box-7');
  });

  it('escapes the requesting machine name', () => {
    const out = renderDevicePage({
      csrfToken: CSRF,
      prefilledUserCode: 'ABCDEFGH',
      errorMessage: null,
      requestingMachine: '<script>alert(1)</script>',
    });
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
    const $ = cheerio.load(out);
    expect($('script').length).toBe(0);
    expect($('.requesting-machine').text()).toContain('<script>alert(1)</script>');
  });

  it('renders no machine line when no machine name is supplied', () => {
    const out = renderDevicePage({ csrfToken: CSRF, prefilledUserCode: null, errorMessage: null });
    const $ = cheerio.load(out);
    expect($('.requesting-machine').length).toBe(0);
  });

  it('offers Approve and Deny, with the code read-only, only when the machine is named', () => {
    const out = renderDevicePage({
      csrfToken: CSRF,
      prefilledUserCode: 'ABCDEFGH',
      errorMessage: null,
      requestingMachine: 'laptop',
    });
    const $ = cheerio.load(out);
    expect($('form input[name="confirmed_code"]').length).toBe(0);
    expect($('form input[name="user_code"]').attr('readonly')).not.toBeUndefined();
    expect($('form button[value="continue"]').length).toBe(0);
    const approveBtn = $('form button[name="action"][value="approve"]');
    const denyBtn = $('form button[name="action"][value="deny"]');
    expect(approveBtn.length).toBe(1);
    expect(approveBtn.attr('type')).toBe('submit');
    expect(approveBtn.text()).toContain('Approve');
    expect(denyBtn.length).toBe(1);
    expect(denyBtn.attr('type')).toBe('submit');
    expect(denyBtn.text()).toContain('Deny');
  });
});

describe('renderDevicePage: Enter on the confirmation page', () => {
  const confirming = () =>
    cheerio.load(
      renderDevicePage({
        csrfToken: CSRF,
        prefilledUserCode: 'ABCDEFGH',
        errorMessage: null,
        requestingMachine: 'laptop',
      }),
    );

  it('the form’s default button (first submit button) is disabled and is not Approve', () => {
    const $ = confirming();
    const first = $('form button[type="submit"]').first();
    expect(first.attr('value')).not.toBe('approve');
    expect(first.attr('disabled')).not.toBeUndefined();
  });

  it('nothing on the confirmation page has autofocus', () => {
    const $ = confirming();
    expect($('[autofocus]').length).toBe(0);
  });

  it('the blank page keeps autofocus on the code field', () => {
    const $ = cheerio.load(
      renderDevicePage({ csrfToken: CSRF, prefilledUserCode: null, errorMessage: null }),
    );
    expect($('input[name="user_code"]').attr('autofocus')).not.toBeUndefined();
  });
});

describe('renderDeviceDeniedPage', () => {
  it('confirms the sign-in was denied', () => {
    const out = renderDeviceDeniedPage();
    expect(out.toLowerCase()).toContain('denied');
    expect(out.toLowerCase().startsWith('<!doctype html>')).toBe(true);
  });
});

describe('renderDeviceApprovedPage', () => {
  it('contains "Approved" and "close this window" text', () => {
    const out = renderDeviceApprovedPage();
    expect(out.toLowerCase()).toContain('approved');
    expect(out.toLowerCase()).toContain('close this window');
    // Full document
    expect(out.toLowerCase().startsWith('<!doctype html>')).toBe(true);
  });
});
