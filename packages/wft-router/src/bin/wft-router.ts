#!/usr/bin/env node
/**
 * wft-router stub entry point.
 *
 * Task #421 lands the package scaffold; downstream tasks implement the
 * actual router flags (--config, --endpoint, --token, --validate,
 * --dry-run, --once, --metrics-port, --metrics-bind, --rebuild-idempotency)
 * per docs/event-router-design.md §Contract.
 *
 * Today this binary only resolves its own version (read from the
 * package.json shipped alongside it) and acknowledges the --version /
 * -V flag. Everything else prints a one-line "not yet implemented"
 * pointer and exits 0 — so smoke probes and integration scaffolding can
 * link against a working entry point before the real logic lands.
 *
 * Vendor-neutral by design (see docs/event-router-design.md §Vendor-neutral
 * guardrails): no provider, AI, chat, or CI name appears in this file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

function main(): void {
  const argv = process.argv.slice(2);
  const version = readOwnVersion();

  if (argv.includes('--version') || argv.includes('-V')) {
    console.log(version);
    process.exit(0);
  }

  console.log(
    `wft-router v${version} — not yet implemented; see docs/event-router-design.md`,
  );
  process.exit(0);
}

main();
