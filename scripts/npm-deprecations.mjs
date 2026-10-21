#!/usr/bin/env node
// @ts-check
/*
 * npm-deprecations.mjs — install-warnings guard (task #2132).
 *
 * `npm i -g wood-fired-tasks` must print ZERO `npm warn deprecated` lines: each
 * one is a deprecated package in our PRODUCTION dependency tree that every user
 * sees on install. smoke-global.mjs captures the combined stdout+stderr of the
 * global install of the freshly packed tarball and feeds it to
 * {@link parseNpmInstallWarnings}; any deprecation fails the smoke.
 *
 * Other `npm warn` lines (e.g. Windows `npm warn cleanup [Error: EPERM ...]`
 * temp-dir noise) are unrelated to our dependency tree: they are reported for
 * visibility but never counted.
 *
 * Pure module (no I/O in the parser) so it is unit-testable. Also runnable as a
 * CLI against captured install output:
 *   node scripts/npm-deprecations.mjs <install-output.txt>
 *   npm i -g <tarball> 2>&1 | node scripts/npm-deprecations.mjs
 * Exit 0 = no deprecations, 1 = deprecations found, 2 = usage error.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ line: string, spec: string, name: string, version: string, message: string }} Deprecation
 * @typedef {{ deprecated: Deprecation[], otherWarnings: string[] }} InstallWarnings
 */

// `npm warn deprecated <name>@<version>: <message>` — npm ≥9 lowercases the
// level; npm ≤8 printed `npm WARN deprecated`. Scoped names (`@scope/pkg`) keep
// their leading `@`, so the version is everything after the LAST `@`.
const DEPRECATED_RE = /^npm warn deprecated (\S+): ?(.*)$/i;
const WARN_RE = /^npm warn\b/i;

/**
 * Split a `name@version` spec, honouring scoped package names.
 * @param {string} spec
 * @returns {{ name: string, version: string }}
 */
export function splitSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec, version: '' };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * Classify the `npm warn` lines in captured npm install output.
 * @param {string} output combined stdout+stderr of an npm install
 * @returns {InstallWarnings}
 */
export function parseNpmInstallWarnings(output) {
  /** @type {Deprecation[]} */
  const deprecated = [];
  /** @type {string[]} */
  const otherWarnings = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const dep = DEPRECATED_RE.exec(line);
    if (dep) {
      const spec = dep[1] ?? '';
      deprecated.push({ line, spec, ...splitSpec(spec), message: dep[2] ?? '' });
    } else if (WARN_RE.test(line)) {
      otherWarnings.push(line);
    }
  }
  return { deprecated, otherWarnings };
}

/**
 * Human-readable failure report. `explain` optionally maps a package name to
 * its dependency path (e.g. `npm ls <name> --all` output).
 * @param {Deprecation[]} deprecated
 * @param {(name: string) => string} [explain]
 * @returns {string}
 */
export function formatDeprecationReport(deprecated, explain) {
  const lines = [
    `npm install printed ${deprecated.length} deprecation warning(s) — a deprecated package is in the production dependency tree:`,
  ];
  for (const d of deprecated) {
    lines.push(`  ${d.line}`);
    const why = explain?.(d.name)?.trim();
    if (why) {
      for (const l of why.split(/\r?\n/)) lines.push(`      ${l}`);
    }
  }
  return lines.join('\n');
}

function main(argv) {
  const file = argv[0];
  if (argv.length > 1) {
    console.error('usage: node scripts/npm-deprecations.mjs [install-output-file]');
    return 2;
  }
  const output = readFileSync(file ?? 0, 'utf8');
  const { deprecated, otherWarnings } = parseNpmInstallWarnings(output);
  for (const w of otherWarnings) console.log(`note (not counted): ${w}`);
  if (deprecated.length > 0) {
    console.error(formatDeprecationReport(deprecated));
    return 1;
  }
  console.log('no npm deprecation warnings');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
