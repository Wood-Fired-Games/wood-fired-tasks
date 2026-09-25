/**
 * fix-15 / link-local carve-out (audit finding H4 rider — task #1633).
 *
 * `isPrivateHost` used to treat `169.254.0.0/16` (link-local) as a private,
 * plaintext-http-safe range alongside RFC1918. That is wrong: link-local is
 * not an operator-drawn trust boundary the way RFC1918 is — it is a
 * self-assigned range that, on every major cloud provider, fronts the
 * instance-metadata responder at `169.254.169.254`. A plaintext `http://`
 * POST (often carrying an `authorization` header, per the handler's TLS
 * posture) to that address is a textbook SSRF-to-credential-exposure path.
 *
 * These fixtures assert the three AC-mandated behaviours:
 *   1. the metadata endpoint is refused, with the credential-exposure reason;
 *   2. RFC1918 targets and loopback remain allowed over plaintext http
 *      (load-bearing non-regression — this must NOT start failing);
 *   3. link-local is allowed ONLY when the explicit `WFT_ROUTER_ALLOW_LINK_LOCAL`
 *      opt-in env var is set to a truthy value.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { assertEndpointAllowed, LINK_LOCAL_OPT_IN_ENV } from '../src/handlers/webhook-post.js';

describe('fix-15 / link-local carve-out', () => {
  const originalValue = process.env[LINK_LOCAL_OPT_IN_ENV];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[LINK_LOCAL_OPT_IN_ENV];
    } else {
      process.env[LINK_LOCAL_OPT_IN_ENV] = originalValue;
    }
  });

  it('refuses the cloud instance-metadata endpoint with the credential-exposure reason', () => {
    delete process.env[LINK_LOCAL_OPT_IN_ENV];
    const d = assertEndpointAllowed('http://169.254.169.254/latest/meta-data/');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('credential-exposure');
  });

  it('refuses other 169.254.0.0/16 addresses by default', () => {
    delete process.env[LINK_LOCAL_OPT_IN_ENV];
    expect(assertEndpointAllowed('http://169.254.1.1/in').allowed).toBe(false);
    expect(assertEndpointAllowed('http://169.254.255.255/in').allowed).toBe(false);
  });

  it('keeps RFC1918 targets and loopback allowed over plaintext http (non-regression)', () => {
    // Load-bearing: this must stay green. It is what distinguishes an
    // operator-drawn trust boundary (RFC1918) from link-local.
    delete process.env[LINK_LOCAL_OPT_IN_ENV];
    expect(assertEndpointAllowed('http://10.1.2.3/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://172.16.0.1/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://172.31.255.255/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://192.168.1.1/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://127.0.0.1:9000/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://localhost/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://[::1]/in').allowed).toBe(true);
  });

  it('allows link-local only when the opt-in env var is explicitly set', () => {
    delete process.env[LINK_LOCAL_OPT_IN_ENV];
    expect(assertEndpointAllowed('http://169.254.169.254/latest/meta-data/').allowed).toBe(false);

    process.env[LINK_LOCAL_OPT_IN_ENV] = '1';
    expect(assertEndpointAllowed('http://169.254.169.254/latest/meta-data/').allowed).toBe(true);

    process.env[LINK_LOCAL_OPT_IN_ENV] = 'true';
    expect(assertEndpointAllowed('http://169.254.1.1/in').allowed).toBe(true);

    // Opt-in has no effect on unrelated routable (non-link-local) hosts.
    process.env[LINK_LOCAL_OPT_IN_ENV] = '1';
    expect(assertEndpointAllowed('http://8.8.8.8/in').allowed).toBe(false);

    // Any other value (including "0"/"false"/empty) stays refused.
    process.env[LINK_LOCAL_OPT_IN_ENV] = '0';
    expect(assertEndpointAllowed('http://169.254.169.254/latest/meta-data/').allowed).toBe(false);
    process.env[LINK_LOCAL_OPT_IN_ENV] = 'false';
    expect(assertEndpointAllowed('http://169.254.169.254/latest/meta-data/').allowed).toBe(false);
  });

  it('never lets the opt-in weaken the redirect-path guard (task #1619 stays authoritative)', () => {
    // viaRedirect refuses EVERY http:// target regardless of host — the
    // link-local opt-in must not create a redirect-path bypass.
    process.env[LINK_LOCAL_OPT_IN_ENV] = '1';
    const d = assertEndpointAllowed('http://169.254.169.254/latest/meta-data/', {
      viaRedirect: true,
    });
    expect(d.allowed).toBe(false);
  });
});
