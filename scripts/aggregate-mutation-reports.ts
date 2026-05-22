#!/usr/bin/env tsx
/**
 * Aggregate Stryker JSON mutation reports from multiple shards into a single
 * unified mutation score, and enforce the break threshold.
 *
 * Stryker writes a JSON report conforming to the mutation-testing-elements
 * report schema. Each shard run produces its own JSON; this script merges
 * `files[].mutants[]` across shards and computes:
 *
 *   score = (killed + timeout) / (killed + timeout + survived + noCoverage) * 100
 *
 * Mutants with status `Ignored`, `CompileError`, `RuntimeError`, or `Pending`
 * are excluded from the denominator (matches Stryker's own scoring rule).
 *
 * Usage:
 *   tsx scripts/aggregate-mutation-reports.ts \
 *       --threshold 75 \
 *       --output reports/mutation/aggregate.json \
 *       <shard-json-1> <shard-json-2> ...
 *
 * Exit codes:
 *   0  unified score >= threshold (or threshold not provided)
 *   1  unified score <  threshold
 *   2  usage error / parse failure
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Stryker JSON report shape (subset we depend on)
// ---------------------------------------------------------------------------

/**
 * Mutant statuses per mutation-testing-elements report schema v2.
 * Killed + Timeout are "detected"; Survived + NoCoverage are "undetected".
 * Ignored / CompileError / RuntimeError / Pending are excluded from scoring.
 */
export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'Timeout'
  | 'CompileError'
  | 'RuntimeError'
  | 'Ignored'
  | 'Pending';

export interface Mutant {
  id: string;
  status: MutantStatus;
  mutatorName?: string;
}

export interface FileResult {
  language?: string;
  source?: string;
  mutants: Mutant[];
}

export interface StrykerReport {
  schemaVersion?: string;
  thresholds?: { high?: number; low?: number; break?: number | null };
  files: Record<string, FileResult>;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface AggregateResult {
  score: number;
  killed: number;
  survived: number;
  noCoverage: number;
  timeout: number;
  compileError: number;
  runtimeError: number;
  ignored: number;
  pending: number;
  totalDetected: number;
  totalUndetected: number;
  totalCovered: number; // detected + undetected (denominator)
  totalMutants: number; // every mutant, including ignored/errors
  fileCount: number;
  shardCount: number;
}

/**
 * Merge an array of Stryker reports and compute the unified score.
 * Throws if every report is empty (no files at all).
 */
export function aggregateReports(reports: StrykerReport[]): AggregateResult {
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  let timeout = 0;
  let compileError = 0;
  let runtimeError = 0;
  let ignored = 0;
  let pending = 0;

  const seenFiles = new Set<string>();

  for (const report of reports) {
    if (!report || typeof report !== 'object' || !report.files) {
      throw new Error('Invalid Stryker report: missing "files" object');
    }
    for (const [path, file] of Object.entries(report.files)) {
      seenFiles.add(path);
      if (!Array.isArray(file?.mutants)) continue;
      for (const m of file.mutants) {
        switch (m.status) {
          case 'Killed':
            killed++;
            break;
          case 'Survived':
            survived++;
            break;
          case 'NoCoverage':
            noCoverage++;
            break;
          case 'Timeout':
            timeout++;
            break;
          case 'CompileError':
            compileError++;
            break;
          case 'RuntimeError':
            runtimeError++;
            break;
          case 'Ignored':
            ignored++;
            break;
          case 'Pending':
            pending++;
            break;
          default:
            // Unknown status — silently skip to forward-compat with future
            // schema additions.
            break;
        }
      }
    }
  }

  const totalDetected = killed + timeout;
  const totalUndetected = survived + noCoverage;
  const totalCovered = totalDetected + totalUndetected;
  const totalMutants =
    totalCovered + compileError + runtimeError + ignored + pending;

  const score = totalCovered === 0 ? 0 : (totalDetected / totalCovered) * 100;

  return {
    score,
    killed,
    survived,
    noCoverage,
    timeout,
    compileError,
    runtimeError,
    ignored,
    pending,
    totalDetected,
    totalUndetected,
    totalCovered,
    totalMutants,
    fileCount: seenFiles.size,
    shardCount: reports.length,
  };
}

/**
 * Render a human-readable summary suitable for CI logs / job summaries.
 */
export function formatSummary(r: AggregateResult, threshold: number | null): string {
  const lines: string[] = [
    '────────────────────────────────────────────────────────────',
    'Unified mutation report',
    '────────────────────────────────────────────────────────────',
    `Shards merged:    ${r.shardCount}`,
    `Files mutated:    ${r.fileCount}`,
    `Mutants (total):  ${r.totalMutants}`,
    `  Killed:         ${r.killed}`,
    `  Timeout:        ${r.timeout}`,
    `  Survived:       ${r.survived}`,
    `  NoCoverage:     ${r.noCoverage}`,
    `  Ignored:        ${r.ignored}`,
    `  CompileError:   ${r.compileError}`,
    `  RuntimeError:   ${r.runtimeError}`,
    `  Pending:        ${r.pending}`,
    `Detected/Covered: ${r.totalDetected}/${r.totalCovered}`,
    `Score:            ${r.score.toFixed(2)}%`,
  ];
  if (threshold !== null) {
    const pass = r.score >= threshold;
    lines.push(
      `Threshold:        ${threshold}% (${pass ? 'PASS' : 'FAIL'})`,
    );
  }
  lines.push('────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

interface CliArgs {
  threshold: number | null;
  output: string | null;
  inputs: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { threshold: null, output: null, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold' || a === '-t') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--threshold requires a value');
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`--threshold must be numeric, got "${v}"`);
      args.threshold = n;
    } else if (a === '--output' || a === '-o') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--output requires a value');
      args.output = v;
    } else if (a === '--help' || a === '-h') {
      // Help is handled by the caller printing usage; signal via empty inputs.
      args.inputs = [];
      return args;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      args.inputs.push(a);
    }
  }
  return args;
}

export function loadReport(path: string): StrykerReport {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read ${path}: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse ${path} as JSON: ${msg}`);
  }
  if (!parsed || typeof parsed !== 'object' || !('files' in parsed)) {
    throw new Error(`${path} is not a Stryker JSON report (no "files" field)`);
  }
  return parsed as StrykerReport;
}

function isMainModule(): boolean {
  // tsx / node both set process.argv[1] to the entry script path; we treat
  // any direct invocation as "main".
  return import.meta.url === `file://${process.argv[1]}`;
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(2);
  }

  if (args.inputs.length === 0) {
    process.stderr.write(
      'Usage: aggregate-mutation-reports [--threshold N] [--output PATH] <report.json> ...\n',
    );
    process.exit(2);
  }

  let reports: StrykerReport[];
  try {
    reports = args.inputs.map(loadReport);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(2);
  }

  const result = aggregateReports(reports);
  process.stdout.write(`${formatSummary(result, args.threshold)}\n`);

  if (args.output) {
    try {
      mkdirSync(dirname(args.output), { recursive: true });
      writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`error: failed to write ${args.output}: ${msg}\n`);
      process.exit(2);
    }
  }

  // Defense in depth: an aggregation with zero covered mutants is almost
  // certainly a broken pipeline (e.g., shards mutated nothing), not a
  // genuine score of 0%. Fail loud rather than silently "passing" a
  // null threshold or letting a 0%-below-threshold check do the work.
  if (result.totalCovered === 0) {
    process.stderr.write(
      'error: aggregate report has zero covered mutants; ' +
        'shards likely failed to mutate any source files\n',
    );
    process.exit(1);
  }

  if (args.threshold !== null && result.score < args.threshold) {
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
