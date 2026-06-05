#!/usr/bin/env node
/**
 * postinstall notice (task #752).
 *
 * Prints ONE line pointing the user at `wood-fired-tasks setup`. That is the
 * entire contract: NO file writes, NO network, NO mutation of ~/.claude.json or
 * any other state. All real installation work is done explicitly by the user
 * running `wood-fired-tasks setup` (idempotent, inspectable) — postinstall must
 * stay a pure stdout notice so `npm install` is never surprising or
 * side-effecting.
 *
 * `.cjs` (not `.js`) so it runs as CommonJS regardless of the package's
 * `"type": "module"`, and so npm can execute it directly with `node`.
 *
 * Skipped silently in CI by convention is NOT done here on purpose — a single
 * println is cheap and harmless everywhere.
 */
process.stdout.write(
  'wood-fired-tasks installed. Run `wood-fired-tasks setup` to register the ' +
    'MCP server and copy skills into ~/.claude.\n'
);
