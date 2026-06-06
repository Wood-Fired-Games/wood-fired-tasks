#!/usr/bin/env tsx
/**
 * Generate `.agent-context.json` from the authoritative table in
 * `scripts/agent-context/manifest.ts`.
 *
 * Usage:
 *   npm run agent-context:gen
 *
 * The output is pretty-printed JSON with 2-space indentation and a trailing
 * newline so it stays diff-friendly.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MANIFEST_PATH, buildManifest, findRepoRoot } from './manifest.js';

function main(): void {
  const repoRoot = findRepoRoot();
  const manifest = buildManifest({ repoRoot });
  const out = `${JSON.stringify(manifest, null, 2)}\n`;
  const dest = resolve(repoRoot, MANIFEST_PATH);
  writeFileSync(dest, out, 'utf8');
  console.log(
    `Wrote ${MANIFEST_PATH} (${manifest.files.length} files, ${
      Object.keys(manifest.groups).length
    } groups).`,
  );
}

main();
