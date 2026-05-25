import { createRequire } from 'node:module';

/**
 * Single source of truth for the application version.
 *
 * task #374: previously the version string `'1.0.0'` was hardcoded in the REST
 * health routes, the CLI `commander.version()` call, the MCP servers, and the
 * OpenAPI spec — four+ copies that drifted from `package.json`. This module
 * reads `package.json` at runtime and re-exports its `version` field as the
 * shared `VERSION` constant.
 *
 * Why `createRequire` instead of `import pkg from '../../package.json'`:
 * `tsconfig.json` sets `rootDir: ./src`, so a static import of the repo-root
 * `package.json` lands the emitted JSON outside `outDir` and trips TS6059
 * ("is not under 'rootDir'"). Reading via `createRequire(import.meta.url)`
 * resolves `package.json` relative to the emitted file at runtime (dist/utils
 * -> ../../package.json -> repo root) without pulling it into the TS program,
 * keeping `npm run build` green and the version single-sourced.
 */
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

export const VERSION: string = pkg.version;
