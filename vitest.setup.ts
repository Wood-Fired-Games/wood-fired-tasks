/**
 * Vitest per-file setup: neutralize inherited OIDC_* environment variables.
 *
 * Why: `loadConfig` (src/config/env.ts) enforces an all-or-nothing rule on the
 * OIDC_* family — if any one is set, all must be. A developer shell that
 * exports a *partial* set (e.g. only `OIDC_CLIENT_ID`, as the `tasks login`
 * device-flow convenience export in ~/.bashrc does) is inherited by the test
 * process and makes every server-building test throw "Configuration validation
 * failed" — a cascade unrelated to the test's intent. CI never saw this because
 * its shell is clean.
 *
 * This clears the inherited OIDC_* keys once before each test file loads, so
 * local runs match CI regardless of the developer's shell. Tests that exercise
 * OIDC set the full set themselves in their own hooks (see
 * oidc-enabled-boot.test.ts / oidc-test-setup.ts), which run after this and are
 * unaffected. OIDC_SCOPES carries a schema default, so dropping it is harmless.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OIDC_')) {
    delete process.env[key];
  }
}

/**
 * Never launch a real browser from the test suite. openBrowser()
 * (src/cli/auth/browser-open.ts) honors WFT_NO_BROWSER and returns false
 * without spawning. Without this, in-process device-flow/login tests
 * (e.g. setup.remote.test.ts's "drives the real device flow" case) call the
 * real deviceLogin({ openBrowser: true }) and spawn `xdg-open` against the mock
 * server's verification_uri on any developer DESKTOP where DISPLAY is set —
 * popping the user's browser to a 404 once per `npm test` run. CI never saw it
 * (headless, no DISPLAY). browser-open.test.ts deletes this in its own hooks to
 * exercise the real spawn path.
 */
process.env['WFT_NO_BROWSER'] = '1';
