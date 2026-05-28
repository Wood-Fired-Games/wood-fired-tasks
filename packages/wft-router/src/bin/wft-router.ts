#!/usr/bin/env node
/**
 * wft-router stub entry point.
 *
 * Task #421 lands the package scaffold; downstream tasks implement the
 * actual router flags (--config, --endpoint, --token, --validate,
 * --dry-run, --once, --metrics-port, --metrics-bind, --rebuild-idempotency)
 * per docs/event-router-design.md §Contract.
 *
 * Task #422 adds the `--validate <path>` flag: reads the file, runs the
 * triggers.yaml zod schema + templating-safety pass, prints
 * `triggers.yaml validation OK.` on success and exits 0, or prints the
 * formatted error list on failure and exits 78 (sysexits EX_CONFIG).
 * Error formatting mirrors `src/config/env.ts:199-216`.
 *
 * Everything else still prints a one-line "not yet implemented" pointer
 * and exits 0 — so smoke probes and integration scaffolding can link
 * against a working entry point before the real logic lands.
 *
 * Vendor-neutral by design (see docs/event-router-design.md §Vendor-neutral
 * guardrails): no provider, AI, chat, or CI name appears in this file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EX_CONFIG, loadAndValidateTriggers } from '../config/triggers-schema.js';

interface PackageJsonShape {
  version?: unknown;
}

function readOwnVersion(): string {
  const pkgUrl = new URL('../../package.json', import.meta.url);
  const pkgPath = fileURLToPath(pkgUrl);
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as PackageJsonShape;
  if (typeof parsed.version === 'string' && parsed.version.length > 0) {
    return parsed.version;
  }
  return '0.0.0';
}

/**
 * Minimal flag parser: pulls a single `--validate <path>` pair out of argv
 * and ignores everything else. Intentionally NOT a real arg-parser — the
 * full surface lands across downstream tasks.
 */
function readValidateFlag(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--validate');
  if (i === -1) return undefined;
  const next = argv[i + 1];
  if (typeof next !== 'string' || next.startsWith('--')) {
    return undefined;
  }
  return next;
}

async function runValidate(path: string): Promise<never> {
  const result = await loadAndValidateTriggers(path);
  if (result.ok) {
    console.log('triggers.yaml validation OK.');
    process.exit(0);
  }
  console.error('triggers.yaml validation failed:');
  console.error(result.errors.join('\n'));
  process.exit(EX_CONFIG);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const version = readOwnVersion();

  if (argv.includes('--version') || argv.includes('-V')) {
    console.log(version);
    process.exit(0);
  }

  const validatePath = readValidateFlag(argv);
  if (validatePath !== undefined) {
    await runValidate(validatePath);
  }
  if (argv.includes('--validate')) {
    // `--validate` was given but with no usable path arg.
    console.error('triggers.yaml validation failed:');
    console.error('  - <args>: --validate requires a path argument');
    process.exit(EX_CONFIG);
  }

  console.log(
    `wft-router v${version} — not yet implemented; see docs/event-router-design.md`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('wft-router crashed:', message);
  process.exit(1);
});
