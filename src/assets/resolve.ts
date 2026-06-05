import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Packaged-asset path resolver.
 *
 * Resolves paths to assets shipped inside the package tarball (e.g. the
 * `skills/` directory and migrations) relative to THIS module's location via
 * `import.meta.url`, never via the caller's working directory. This makes asset
 * lookups work from any working directory — including from inside
 * `node_modules/` after a global install.
 *
 * Layout assumption: this module compiles to `dist/assets/resolve.js`, two
 * directory levels below the package root (`dist/assets/` -> package root).
 * Assets ship under the package root, so going up two levels (`../../`) from
 * this module's directory lands on the package root.
 *
 * When tests run against the TypeScript source via vitest (esbuild),
 * `import.meta.url` points at `src/assets/resolve.ts`, which is ALSO two levels
 * below the repo root (`src/assets/` -> repo root). The `../../` walk therefore
 * lands on the package/repo root in both the built and the source case.
 */

/** Absolute path to this module's directory (`dist/assets/` or `src/assets/`). */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the package root.
 *
 * Walk up two levels from this module's directory:
 *   `<root>/dist/assets/resolve.js` -> `<root>`
 *   `<root>/src/assets/resolve.ts`  -> `<root>`
 */
export const packageRoot = resolve(moduleDir, '..', '..');

/**
 * Resolve an absolute path to a packaged asset by joining the given path
 * segments onto the package root. Independent of the caller's working
 * directory.
 *
 * @example
 *   resolveAssetPath('skills', 'tasks') // -> <packageRoot>/skills/tasks
 */
export function resolveAssetPath(...segments: string[]): string {
  return join(packageRoot, ...segments);
}

/**
 * Absolute path to the packaged `skills/` directory at the package root.
 * Computed from `import.meta.url`, so it resolves correctly regardless of the
 * caller's working directory.
 */
export function skillsDir(): string {
  return resolveAssetPath('skills');
}
