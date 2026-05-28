// Intentional violation: this fixture exists ONLY to prove that the
// vendor-neutrality gate (scripts/vendor-neutrality/check.mjs) can detect
// a forbidden token and fail. It lives under scripts/ — outside the
// production scan glob (packages/wft-router/src/**) — so it does NOT
// trip the default gate. The gate's own test suite points --target at
// this file explicitly to assert the failure path.
export const example = 'slack-webhook-url';
