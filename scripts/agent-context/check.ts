#!/usr/bin/env tsx
/**
 * Validate `.agent-context.json` against the authoritative table.
 *
 * Fails with a non-zero exit code if:
 *   1. Any "present" entry references a path that doesn't exist on disk.
 *   2. Any "present" entry exceeds its `line_budget` (failure message
 *      includes the approximate token estimate so contributors can see
 *      how far over the "few tokens as possible" target they are).
 *   3. Any "present" entry lacks an `Owner:` line in the first 3 lines
 *      (skipped for files in OWNER_LINE_EXEMPT, e.g. README.md, SECURITY.md).
 *   4. The on-disk `.agent-context.json` differs from a freshly generated
 *      manifest (other than the `_generated.generated_at` timestamp).
 *   5. Any internal markdown link in a "present" `.md` file points at a
 *      relative path that does not exist on disk.
 *   6. Any adapter file (authority === 'adapter', status === 'present')
 *      does not contain a markdown link to `AGENTS.md`. Adapters MUST
 *      point at the canonical entry — that is the only thing that makes
 *      them adapters rather than rogue vendor-specific docs.
 *
 * This script reads only files inside the repository (.md sources, the
 * committed .agent-context.json, and the in-process manifest.ts source).
 * It NEVER opens data/*.db, .env, ~/.claude.json, or any HTTP endpoint.
 *
 * Usage:
 *   npm run agent-context:check
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type AgentContextManifest,
  MANIFEST_PATH,
  OWNER_LINE_EXEMPT,
  approxTokensForLines,
  buildManifest,
  findRepoRoot,
  validateInternalLinks,
} from './manifest.js';

interface CheckResult {
  errors: string[];
  warnings: string[];
}

/**
 * Match a markdown link whose target resolves to `AGENTS.md` at the repo
 * root. Accepts `AGENTS.md`, `./AGENTS.md`, and any `#fragment` suffix.
 * Used by the adapter-link check (see rule 6 in the file header comment).
 */
const ADAPTER_AGENTS_LINK_RE = /\]\((?:\.\/)?AGENTS\.md(?:#[^)]*)?\)/;

function normalizeForCompare(m: AgentContextManifest): Omit<AgentContextManifest, '_generated'> & {
  _generated: Omit<AgentContextManifest['_generated'], 'generated_at'>;
} {
  const { generated_at: _ignored, ...generatedRest } = m._generated;
  return {
    ...m,
    _generated: generatedRest,
  };
}

export function runChecks(repoRoot: string): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const fresh = buildManifest({ repoRoot });

  for (const entry of fresh.files) {
    if (entry.status !== 'present') continue;

    if (entry.actual_lines === undefined) {
      errors.push(`File "${entry.path}" is marked status=present but does not exist on disk.`);
      continue;
    }

    if (entry.actual_lines > entry.line_budget) {
      const actualTokens = approxTokensForLines(entry.actual_lines);
      errors.push(
        `File "${entry.path}" exceeds its line budget: ${entry.actual_lines} > ${entry.line_budget} (~${actualTokens} tokens vs ~${entry.approx_token_budget} budget).`,
      );
    }

    if (!OWNER_LINE_EXEMPT.has(entry.path)) {
      if (entry.actual_owner === undefined) {
        errors.push(`File "${entry.path}" is missing an "Owner:" line in its first 3 lines.`);
      }
    }
  }

  for (const linkErr of validateInternalLinks(repoRoot)) {
    errors.push(linkErr.message);
  }

  // Adapter files MUST link to AGENTS.md — that is what distinguishes an
  // adapter from a rogue vendor-specific doc. Check applies to every
  // present adapter regardless of file extension (covers CLAUDE.md and
  // llms.txt). Anchored fragments are accepted.
  for (const entry of fresh.files) {
    if (entry.authority !== 'adapter') continue;
    if (entry.status !== 'present') continue;
    const abs = resolve(repoRoot, entry.path);
    if (!existsSync(abs)) continue; // file-exists already reported above
    const text = readFileSync(abs, 'utf8');
    if (!ADAPTER_AGENTS_LINK_RE.test(text)) {
      errors.push(
        `Adapter file "${entry.path}" does not link to AGENTS.md — adapters must point to the canonical entry.`,
      );
    }
  }

  const manifestAbsPath = resolve(repoRoot, MANIFEST_PATH);
  if (!existsSync(manifestAbsPath)) {
    errors.push(`Manifest file "${MANIFEST_PATH}" is missing — run \`npm run agent-context:gen\`.`);
  } else {
    const onDiskText = readFileSync(manifestAbsPath, 'utf8');
    let onDisk: AgentContextManifest;
    try {
      onDisk = JSON.parse(onDiskText) as AgentContextManifest;
    } catch (err) {
      errors.push(`Manifest file "${MANIFEST_PATH}" is not valid JSON: ${(err as Error).message}`);
      return { errors, warnings };
    }
    const a = JSON.stringify(normalizeForCompare(onDisk));
    const b = JSON.stringify(normalizeForCompare(fresh));
    if (a !== b) {
      errors.push(
        `Manifest file "${MANIFEST_PATH}" is out of date — run \`npm run agent-context:gen\` and commit the result.`,
      );
    }
  }

  return { errors, warnings };
}

function main(): void {
  const repoRoot = findRepoRoot();
  const { errors, warnings } = runChecks(repoRoot);
  for (const w of warnings) {
    console.warn(`warn: ${w}`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`error: ${e}`);
    }
    console.error(`agent-context:check failed with ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log('agent-context:check OK.');
}

// Only run when executed as a script, not when imported by tests.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check.ts') ||
  process.argv[1]?.endsWith('check.js');
if (isMain) {
  main();
}
