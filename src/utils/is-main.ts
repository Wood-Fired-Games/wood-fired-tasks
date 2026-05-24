import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * Returns true when the calling module is the script invoked by `node`.
 *
 * Uses `realpathSync` to resolve symlinks (e.g. when the binary is installed
 * via `npm link` or `npm install -g`, `process.argv[1]` points at a symlink
 * while `import.meta.url` is the realpath). The naive string-equality check
 * `import.meta.url === \`file://${process.argv[1]}\`` fails in that case,
 * silently skipping the CLI bootstrap.
 *
 * @param metaUrl - pass `import.meta.url` from the calling module.
 */
export function isMain(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}
