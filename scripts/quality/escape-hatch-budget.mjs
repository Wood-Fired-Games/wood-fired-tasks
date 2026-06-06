#!/usr/bin/env node
// escape-hatch-budget.mjs
//
// Production-code escape-hatch budget gate for the TypeScript Quality
// Excellence Audit (project 37, phase-3 — task #766).
//
// WHAT IT DOES
//   1. Scans the TypeScript source tree for "escape hatches" (unsafe-typing
//      patterns: `as any`, `as unknown`, bare `: any`, `@ts-expect-error`,
//      `@ts-ignore`, `biome-ignore`), counting them by CATEGORY and splitting
//      PRODUCTION code from TEST code.
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
//   - Counting is line-grep style (one match per line), matching the
//     reproducible methodology of the wave-1 audit guide (§1.8). It is a
//     DIRECTIONAL signal, not an AST-precise unsafe-cast inventory: comments
//     and doc-strings that contain the literal token are counted, and a
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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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

/**
 * Return all matching `path:line:...` records for a grep pattern across the
 * scan dirs. Uses grep -rnE; returns [] when grep finds nothing (exit 1).
 */
function grepLines(grepPattern) {
  const dirs = SCAN_DIRS.filter((d) => existsSync(join(REPO_ROOT, d)));
  if (dirs.length === 0) return [];
  // No shell: execFileSync passes args straight to grep, so the pattern and
  // paths are never re-parsed by a shell (no injection surface, and ERE
  // metacharacters in the pattern reach grep verbatim).
  // -r recursive, -n line numbers, -E extended regex, --include only .ts,
  // -a treat files as text (a stray non-UTF8 byte in a .ts file must not make
  // grep emit "binary file matches" and silently drop the per-line count).
  const args = ['-rnEa', grepPattern, ...dirs, '--include=*.ts'];
  let out = '';
  try {
    out = execFileSync('grep', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // grep exits 1 when there are no matches — that's a legitimate "zero".
    if (err.status === 1) return [];
    throw err;
  }
  return out.split('\n').filter((l) => l.length > 0);
}

/**
 * Scan the tree and return { prod: {cat:count}, test: {cat:count},
 * prodRefs: {cat:[file:line,...]} } — refs capped for readability.
 */
function scan() {
  const prod = {};
  const test = {};
  const prodRefs = {};
  for (const cat of CATEGORIES) {
    const lines = grepLines(cat.grep);
    let prodCount = 0;
    let testCount = 0;
    const refs = [];
    for (const line of lines) {
      // line looks like "src/foo/bar.ts:123:   ...code..."
      const m = line.match(/^([^:]+):(\d+):/);
      const path = m ? m[1] : line;
      if (isTestPath(path)) {
        testCount += 1;
      } else {
        prodCount += 1;
        if (refs.length < 6) refs.push(`${m ? `${m[1]}:${m[2]}` : path}`);
      }
    }
    prod[cat.id] = prodCount;
    test[cat.id] = testCount;
    prodRefs[cat.id] = refs;
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
