import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { LoopRunFrontmatterSchema } from '../schema.js';

/**
 * Wave 3.1 (task #316) — regression gate that locks the published reference
 * example to the in-tree Zod schema.
 *
 * `docs/loop-run-reference-example.md` is the canonical illustrative example
 * cited by `docs/loop-run-schema.md`. If the schema drifts (a field becomes
 * required, a type changes), this test fails until either the example is
 * updated OR the schema change is reverted. That asymmetric coupling is the
 * point — the schema and the example are two sides of the same contract.
 *
 * Note: this test deliberately does NOT depend on a YAML parsing library.
 * The reference frontmatter is a flat `key: value` block (no nesting, no
 * arrays, no quoted strings, no anchors). A hand-rolled splitter mirrors the
 * orchestrator's own emit-time behaviour (which also hand-writes the YAML).
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const REFERENCE_PATH = resolve(REPO_ROOT, 'docs/loop-run-reference-example.md');

function extractFrontmatterBlock(md: string): string {
  // Find the first two `---` lines that delimit the YAML block. Any leading
  // comment lines (`# ...`) above the first `---` are ignored, matching the
  // existing reference file shape.
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---\s*$/m);
  if (!fmMatch) {
    throw new Error('No YAML frontmatter block (--- ... ---) found in reference example.');
  }
  return fmMatch[1];
}

function parseFlatYaml(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) {
      throw new Error(`Malformed frontmatter line (no colon): ${line}`);
    }
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    // Coerce: integers > floats > untouched string. The schema does the
    // strict typing — this coercion just mirrors what a real YAML parser
    // would produce for unquoted scalars.
    if (/^-?\d+$/.test(rawValue)) {
      out[key] = Number.parseInt(rawValue, 10);
    } else if (/^-?\d+\.\d+$/.test(rawValue)) {
      out[key] = Number.parseFloat(rawValue);
    } else {
      out[key] = rawValue;
    }
  }
  return out;
}

describe('docs/loop-run-reference-example.md — schema lock', () => {
  const md = readFileSync(REFERENCE_PATH, 'utf8');
  const block = extractFrontmatterBlock(md);
  const data = parseFlatYaml(block);

  it('contains a YAML frontmatter block', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  it('parses all 14 required fields out of the YAML block (plus optional #319 gate_decision)', () => {
    expect(Object.keys(data).sort()).toEqual(
      [
        'ended_at',
        'gate_decision',
        'orchestrator_session_id',
        'project_id',
        'run_id',
        'started_at',
        'subagents_dispatched',
        'tasks_attempted',
        'tasks_failed',
        'tasks_not_verified',
        'tasks_partial',
        'tasks_passed',
        'total_tokens',
        'total_usd',
        'wall_seconds',
      ].sort(),
    );
  });

  it('reference example documents Wave 4.2 gate_decision: "allowed" (task #319)', () => {
    // The reference run is a FLAT-topology drain (project 12 mock), so the
    // §2f topology pre-flight gate yields gate_decision: allowed. Locks the
    // example to the canonical value so the schema-evolution audit stays
    // honest — if a future edit removes the field from the example, the
    // optional-field guarantee in schema.ts is no longer demonstrated.
    expect(data.gate_decision).toBe('allowed');
  });

  it('validates against LoopRunFrontmatterSchema', () => {
    const result = LoopRunFrontmatterSchema.safeParse(data);
    if (!result.success) {
      // Surface the zod errors when the assertion fails so a maintainer
      // editing the reference can see exactly what drifted.
      throw new Error(
        `Reference example failed schema validation:\n${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it('reference task counts sum to tasks_attempted (contract-doc invariant)', () => {
    // Documented in docs/loop-run-schema.md §3 — the schema does NOT enforce
    // it, but the canonical example MUST satisfy it. Catches future edits
    // that desync the counts.
    const sum =
      (data.tasks_passed as number) +
      (data.tasks_failed as number) +
      (data.tasks_partial as number) +
      (data.tasks_not_verified as number);
    expect(sum).toBe(data.tasks_attempted);
  });
});
