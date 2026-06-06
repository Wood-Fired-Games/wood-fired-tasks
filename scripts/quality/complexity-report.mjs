#!/usr/bin/env node
// complexity-report.mjs
//
// ADVISORY cognitive-complexity report for production TypeScript, part of the
// TypeScript Quality Excellence Audit (project 37, phase-4 — task #771).
//
// WHAT IT DOES
//   1. Runs Biome's `complexity/noExcessiveCognitiveComplexity` rule over the
//      PRODUCTION TypeScript surface (`src/**` and `packages/wft-router/src/**`,
//      tests/benches excluded) via the dedicated `biome.complexity.json` config,
//      using the JSON reporter.
//   2. Parses the per-function cognitive-complexity scores and prints a ranked
//      table of outliers plus a distribution histogram.
//   3. Is ADVISORY ONLY. It NEVER fails on complexity — it exits 0 even when
//      functions exceed any threshold. It exits NON-ZERO *only* when the Biome
//      tool itself fails to execute (so CI can distinguish "tool broke" from
//      "code is complex").
//
// WHY BIOME (no new dependency)
//   Biome already ships the Cognitive Complexity rule (SonarSource algorithm)
//   and is already the repo's lint toolchain. Reusing it means zero new deps,
//   one calibration source of truth, and a trivial future path to a real gate
//   (flip the rule level in biome.complexity.json / merge it into biome.json).
//
// CONFIG / THRESHOLD
//   The dedicated config (biome.complexity.json) sets the rule's
//   `maxAllowedComplexity` to 1 so Biome reports a diagnostic for EVERY
//   function with score >= 2 — i.e. the rule emits the raw score for the whole
//   tree and this script does the thresholding. The `--threshold` flag (default
//   15, Biome's own default ceiling) controls which functions count as
//   "outliers" in the printed table; it does NOT change exit behavior.
//
// USAGE
//   node scripts/quality/complexity-report.mjs                 # ranked report
//   node scripts/quality/complexity-report.mjs --threshold 20  # custom cutoff
//   node scripts/quality/complexity-report.mjs --top 30        # show N rows
//   node scripts/quality/complexity-report.mjs --json          # machine output
//
// No external dependencies — node:child_process + node:fs only. The repo is
// "type":"module" so this is plain ESM.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'biome.complexity.json');
const SCAN_DIRS = ['src', 'packages/wft-router/src'];
const RULE_CATEGORY = 'lint/complexity/noExcessiveCognitiveComplexity';

function parseArgs(argv) {
  const args = { threshold: 15, top: 25, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--threshold') args.threshold = Number(argv[++i]);
    else if (a === '--top') args.top = Number(argv[++i]);
  }
  if (!Number.isFinite(args.threshold)) args.threshold = 15;
  if (!Number.isFinite(args.top)) args.top = 25;
  return args;
}

/**
 * Run Biome's complexity rule and return its parsed JSON report. Throws on any
 * tool-execution failure (missing config, biome crash, unparseable output) so
 * the caller can exit non-zero — that is the ONLY non-zero exit path.
 */
function runBiome() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`complexity config missing: ${CONFIG_PATH}`);
  }
  const dirs = SCAN_DIRS.filter((d) => existsSync(join(REPO_ROOT, d)));
  // `biome lint` exits 1 when diagnostics exist (every reported function is a
  // "warn" diagnostic), which is EXPECTED here and not a tool failure. We use
  // the npx-resolved local biome binary. stdout carries the JSON report.
  const res = spawnSync(
    'npx',
    ['biome', 'lint', `--config-path=${CONFIG_PATH}`, '--reporter=json', ...dirs],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (res.error) {
    throw new Error(`failed to spawn biome: ${res.error.message}`);
  }
  // A real tool failure is signalled by a missing/empty stdout or a non-0/1
  // exit code (2 = config error, 70/71 = internal error in Biome's scheme).
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(
      `biome exited ${res.status} (tool error)\n${(res.stderr || '').slice(0, 2000)}`,
    );
  }
  if (!res.stdout || res.stdout.trim().length === 0) {
    throw new Error(`biome produced no JSON output\n${(res.stderr || '').slice(0, 2000)}`);
  }
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch (e) {
    throw new Error(`could not parse biome JSON report: ${e.message}`);
  }
  return report;
}

/** Extract { score, path, line } rows from the Biome JSON report. */
function extractRows(report) {
  const rows = [];
  for (const diag of report.diagnostics || []) {
    if (diag.category !== RULE_CATEGORY) continue;
    const loc = diag.location || {};
    const path = typeof loc.path === 'string' ? loc.path : (loc.path && loc.path.file) || '?';
    const line = (loc.start && loc.start.line) || 0;
    const m = /complexity of (\d+)/.exec(diag.message || '');
    const score = m ? Number(m[1]) : 0;
    rows.push({ score, path, line });
  }
  rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return rows;
}

/** First non-empty trimmed line of source at `line` (1-based), for context. */
function sourceContext(path, line) {
  try {
    const abs = join(REPO_ROOT, path);
    const text = readFileSync(abs, 'utf8').split('\n')[line - 1] || '';
    return text.trim().slice(0, 72);
  } catch {
    return '';
  }
}

function distribution(rows) {
  const buckets = { '>=21': 0, '16-20': 0, '11-15': 0, '6-10': 0, '2-5': 0 };
  for (const r of rows) {
    if (r.score >= 21) buckets['>=21']++;
    else if (r.score >= 16) buckets['16-20']++;
    else if (r.score >= 11) buckets['11-15']++;
    else if (r.score >= 6) buckets['6-10']++;
    else buckets['2-5']++;
  }
  return buckets;
}

function main() {
  const { threshold, top, json } = parseArgs(process.argv.slice(2));

  let report;
  try {
    report = runBiome();
  } catch (e) {
    console.error(`[complexity-report] TOOL ERROR: ${e.message}`);
    // Non-zero ONLY on tool failure — never on complexity itself.
    process.exit(2);
  }

  const rows = extractRows(report);
  const outliers = rows.filter((r) => r.score > threshold);
  const buckets = distribution(rows);

  if (json) {
    console.log(
      JSON.stringify(
        {
          threshold,
          total_functions_scored: rows.length,
          outliers_over_threshold: outliers.length,
          distribution: buckets,
          outliers: outliers.map((r) => ({ score: r.score, path: r.path, line: r.line })),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.log('Cognitive-complexity report (ADVISORY — never fails on complexity)');
  console.log(`Scope: ${SCAN_DIRS.join(', ')} (tests/benches excluded)`);
  console.log(`Functions scored (>=2): ${rows.length}`);
  console.log(`Outliers over threshold ${threshold}: ${outliers.length}`);
  console.log('');
  console.log('Distribution:');
  for (const k of ['>=21', '16-20', '11-15', '6-10', '2-5']) {
    console.log(`  ${k.padStart(6)}: ${buckets[k]}`);
  }
  console.log('');
  console.log(`Top ${Math.min(top, outliers.length)} outliers:`);
  console.log('  score  location');
  for (const r of outliers.slice(0, top)) {
    const ctx = sourceContext(r.path, r.line);
    console.log(`  ${String(r.score).padStart(5)}  ${r.path}:${r.line}${ctx ? `  | ${ctx}` : ''}`);
  }
  console.log('');
  console.log('Calibration + per-outlier disposition: docs/CODE_QUALITY_ROADMAP.md');
  console.log('("Complexity Calibration" section). This report is advisory: no gate.');
  process.exit(0);
}

main();
