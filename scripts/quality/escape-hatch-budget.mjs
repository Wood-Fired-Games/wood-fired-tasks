#!/usr/bin/env node
// escape-hatch-budget.mjs
//
// Production-code escape-hatch budget gate for the TypeScript Quality
// Excellence Audit (project 37, phase-3 — task #766).
//
// WHAT IT DOES
//   1. Scans the TypeScript source tree for "escape hatches" (unsafe-typing
//      patterns: `as any`, `as unknown`, bare `: any`, and the ts-expect-error,
//      ts-ignore, and biome-ignore directives), counting them by CATEGORY and
//      splitting PRODUCTION code from TEST code.
//   2. Compares the current PRODUCTION counts against a committed baseline
//      (scripts/quality/escape-hatch-budget.json).
//   3. Exits NON-ZERO if any production category EXCEEDS its baseline (i.e. a
//      new, unexplained escape hatch was added) — this is the CI gate.
//   4. Exits ZERO when every production category is at or under baseline.
//   5. Reports TEST counts for visibility only; they NEVER fail the gate
//      (test escape hatches are governed by a more lenient policy — see
//      docs/TYPESCRIPT_QUALITY_AUDIT_2026.md §"Unsafe TypeScript Escape-Hatch
//      Policy & Production Budget").
//
// METHODOLOGY / CAVEATS
//   - Counting is line-based (one match per line per category), matching the
//     reproducible methodology of the wave-1 audit guide (§1.8). It is a
//     DIRECTIONAL signal, not an AST-precise unsafe-cast inventory: comments
//     and doc-strings are stripped before counting (so `: any` in prose is NOT
//     a false positive), but string-literal contents are not parsed and a
//     double-cast (`x as unknown as T`) counts once per pattern per line.
//   - The baseline is therefore a RATCHET, not a claim of "N genuinely-unsafe
//     casts". Its only contract is: production counts must not grow without a
//     deliberate baseline bump (which forces a reviewer to look).
//
// USAGE
//   node scripts/quality/escape-hatch-budget.mjs            # gate (CI mode)
//   node scripts/quality/escape-hatch-budget.mjs --json     # machine-readable
//   node scripts/quality/escape-hatch-budget.mjs --update   # rewrite baseline
//                                                            # to current prod
//                                                            # counts (manual,
//                                                            # reviewed bump)
//
// No external dependencies — node:fs + node:child_process (ripgrep-free grep)
// only. The repo is "type":"module" so this is plain ESM.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const BASELINE_PATH = join(__dirname, 'escape-hatch-budget.json');

// Directories to scan (only those that exist are scanned).
const SCAN_DIRS = ['src', 'packages/wft-router/src'];

// A file is "test" code if its path matches any of these fragments.
const TEST_PATTERNS = ['.test.ts', '.spec.ts', '.property.test.ts', '.bench.ts', '__tests__/'];

// Category id -> { label, regex (JS RegExp source as understood by grep -E) }.
// We use grep -E (POSIX ERE) for the scan to stay dependency-free and fast.
const CATEGORIES = [
  { id: 'as_any', label: '`as any` cast', grep: 'as any' },
  { id: 'as_unknown', label: '`as unknown` cast', grep: 'as unknown' },
  { id: 'bare_any', label: 'bare `: any` annotation', grep: ': any\\b' },
  { id: 'ts_expect_error', label: '`@ts-expect-error`', grep: '@ts-expect-error' },
  { id: 'ts_ignore', label: '`@ts-ignore`', grep: '@ts-ignore' },
  { id: 'biome_ignore', label: '`biome-ignore`', grep: 'biome-ignore' },
];

function isTestPath(p) {
  return TEST_PATTERNS.some((frag) => p.includes(frag));
}

/** Recursively collect repo-relative `.ts` file paths under the scan dirs. */
function collectTsFiles() {
  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = join(REPO_ROOT, d);
    if (!existsSync(abs)) continue;
    for (const rel of readdirSync(abs, { recursive: true })) {
      const relStr = typeof rel === 'string' ? rel : rel.toString();
      if (relStr.endsWith('.ts')) files.push(`${d}/${relStr.split('\\').join('/')}`);
    }
  }
  return files;
}

/**
 * Blank out comments while preserving line count so escape-hatch tokens that
 * appear only inside a comment or doc-string are NOT counted (real code tokens
 * only). Block comments (`/* *\/`, `/** *\/`) and line comments (`// …`) are
 * replaced with spaces; newlines are kept so reported line numbers stay
 * accurate. Directional counter — string-literal contents are not parsed, so a
 * `//` inside a string truncates that line, which can only ever DROP a token
 * (never invent one), matching this gate's conservative ratchet contract.
 */
function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * Scan the tree and return { prod: {cat:count}, test: {cat:count},
 * prodRefs: {cat:[file:line,...]} } — refs capped for readability. Counting is
 * one match per (comment-stripped) line per category, preserving the original
 * line-grep methodology minus the comment/doc-string false positives.
 */
function scan() {
  const prod = {};
  const test = {};
  const prodRefs = {};
  for (const cat of CATEGORIES) {
    prod[cat.id] = 0;
    test[cat.id] = 0;
    prodRefs[cat.id] = [];
  }
  const compiled = CATEGORIES.map((cat) => ({ cat, re: new RegExp(cat.grep) }));
  for (const relPath of collectTsFiles()) {
    let content;
    try {
      content = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    } catch {
      continue;
    }
    const isTest = isTestPath(relPath);
    const lines = stripComments(content).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const { cat, re } of compiled) {
        if (!re.test(line)) continue;
        if (isTest) {
          test[cat.id] += 1;
        } else {
          prod[cat.id] += 1;
          if (prodRefs[cat.id].length < 6) prodRefs[cat.id].push(`${relPath}:${i + 1}`);
        }
      }
    }
  }
  return { prod, test, prodRefs };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`[escape-hatch-budget] baseline missing: ${BASELINE_PATH}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const updateMode = args.includes('--update');

  const { prod, test, prodRefs } = scan();

  if (updateMode) {
    const baseline = existsSync(BASELINE_PATH) ? loadBaseline() : {};
    const next = {
      $comment:
        'Production escape-hatch budget baseline. Counts are line-grep ' +
        'directional totals (see scripts/quality/escape-hatch-budget.mjs ' +
        'header + docs/TYPESCRIPT_QUALITY_AUDIT_2026.md policy section). ' +
        'production.<category> is a CEILING: the gate fails if the live count ' +
        'exceeds it. Bump a ceiling DOWN as you remove escapes; bump it UP ' +
        'only with a reviewed justification. test.<category> is informational.',
      generated_methodology:
        baseline.generated_methodology ||
        'grep -rnE <pattern> src packages/wft-router/src --include=*.ts, ' +
          'split by test-path fragments (.test.ts/.spec.ts/.property.test.ts/' +
          '.bench.ts/__tests__/).',
      categories: CATEGORIES.reduce((acc, c) => {
        acc[c.id] = c.label;
        return acc;
      }, {}),
      production: prod,
      test,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`[escape-hatch-budget] baseline UPDATED -> ${BASELINE_PATH}`);
    console.log(JSON.stringify(next.production, null, 2));
    return;
  }

  const baseline = loadBaseline();
  const baseProd = baseline.production || {};
  const baseTest = baseline.test || {};

  if (jsonMode) {
    console.log(
      JSON.stringify(
        { production: prod, test, baseline_production: baseProd, baseline_test: baseTest },
        null,
        2,
      ),
    );
  }

  // Compare production counts against baseline ceilings.
  const violations = [];
  let prodTotal = 0;
  let baseTotal = 0;
  for (const cat of CATEGORIES) {
    const cur = prod[cat.id] ?? 0;
    const base = baseProd[cat.id] ?? 0;
    prodTotal += cur;
    baseTotal += base;
    if (cur > base) {
      violations.push({ cat, cur, base, refs: prodRefs[cat.id] });
    }
  }

  if (!jsonMode) {
    console.log('Escape-hatch budget — PRODUCTION code (gated):');
    console.log('  category                 current  baseline  status');
    for (const cat of CATEGORIES) {
      const cur = prod[cat.id] ?? 0;
      const base = baseProd[cat.id] ?? 0;
      const status = cur > base ? 'OVER ❌' : cur < base ? 'under ✓' : 'at ✓';
      console.log(
        `  ${cat.id.padEnd(24)} ${String(cur).padStart(5)}   ${String(base).padStart(6)}   ${status}`,
      );
    }
    console.log(
      `  ${'TOTAL'.padEnd(24)} ${String(prodTotal).padStart(5)}   ${String(baseTotal).padStart(6)}`,
    );
    console.log('');
    console.log('Escape-hatch census — TEST code (informational, NOT gated):');
    for (const cat of CATEGORIES) {
      console.log(`  ${cat.id.padEnd(24)} ${String(test[cat.id] ?? 0).padStart(5)}`);
    }
    console.log('');
  }

  if (violations.length > 0) {
    console.error('❌ Escape-hatch budget EXCEEDED in production code.');
    console.error('   A new unexplained escape hatch was added (or the count grew).');
    console.error('   Either remove it, or — if the cast is justified — add an inline');
    console.error('   `// SAFETY:` rationale AND bump the baseline ceiling with review.');
    console.error('   See docs/TYPESCRIPT_QUALITY_AUDIT_2026.md, "Unsafe TypeScript');
    console.error('   Escape-Hatch Policy & Production Budget".');
    console.error('');
    for (const v of violations) {
      console.error(`   • ${v.cat.id}: current ${v.cur} > baseline ${v.base} (+${v.cur - v.base})`);
      for (const ref of v.refs) {
        console.error(`       ${ref}`);
      }
    }
    process.exit(1);
  }

  console.log('✅ Escape-hatch budget OK — production counts at or under baseline.');
  process.exit(0);
}

main();
