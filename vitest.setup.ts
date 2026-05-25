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
