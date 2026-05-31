/**
 * Cross-package drift guard for ALLOWED_EVENT_TYPES.
 *
 * `packages/wft-router` is a STANDALONE sub-package (own `rootDir`, own
 * `dist/`, own `package.json`). It cannot import from the root `src/` at
 * compile time without dragging the rest of the server into its bundle.
 * The agreed-upon answer is to DUPLICATE the `ALLOWED_EVENT_TYPES` tuple
 * inside the package (see
 * `packages/wft-router/src/config/event-types.ts`) and use this test as
 * the drift-detection contract.
 *
 * If you add, remove, or reorder an entry on either side, this test will
 * fail. Update both tuples and ship them together.
 *
 * Why this test lives at the root (not inside the package): only the root
 * test tree can see BOTH source files at once; the wft-router package
 * cannot reach `../../src/...` from its own compilation root.
 *
 * Vendor-neutrality: this test is part of the wft-router enforcement
 * boundary; no provider, AI, chat, or CI name appears in its comments
 * or assertions.
 */

import { describe, expect, it } from 'vitest';

import { ALLOWED_EVENT_TYPES as ROOT_ALLOWED } from '../types.js';
// Import the wft-router copy by relative path. Vitest resolves the `.js`
// extension against the on-disk `.ts` file at runtime; we deliberately
// stay outside the root tsconfig's rootDir for compile output (this file
// lives under `__tests__/` and is excluded by the root tsconfig).
import { ALLOWED_EVENT_TYPES as ROUTER_ALLOWED } from '../../../packages/wft-router/src/config/event-types.js';

describe('ALLOWED_EVENT_TYPES — root <-> wft-router drift guard', () => {
  it('both tuples are deep-equal', () => {
    expect(ROUTER_ALLOWED).toEqual(ROOT_ALLOWED);
  });

  it('both tuples have the same length (catches stealth additions)', () => {
    expect(ROUTER_ALLOWED.length).toBe(ROOT_ALLOWED.length);
  });

  it('every root event type appears in the router copy', () => {
    for (const ev of ROOT_ALLOWED) {
      expect(ROUTER_ALLOWED).toContain(ev);
    }
  });

  it('every router event type appears in the root copy', () => {
    for (const ev of ROUTER_ALLOWED) {
      expect(ROOT_ALLOWED).toContain(ev);
    }
  });
});
