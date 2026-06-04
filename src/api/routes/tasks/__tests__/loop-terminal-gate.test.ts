import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parityViolations,
  validateAllowlist,
} from '../../../../mcp/__tests__/stdio-remote-parity.test.js';

/**
 * Task #650 — Gate loop / loop-dag "backlog drained → done" on the §O terminal
 * completeness gate (drained→done invariant + reachability audit) with the
 * remediation-task carve-out.
 *
 * Motivating incident:
 * docs/retrospectives/2026-06-01-wsjf-remote-parity-planning-gap.md — a full
 * pool drain closed 6/6 tasks PASS while the new WSJF MCP tools were stdio-only
 * and unreachable through the production remote MCP proxy ("green tasks, broken
 * feature"). This test pins the documented gate AND proves its underlying
 * invariant audit genuinely DETECTS an unreachable newly-added tool.
 *
 * Two layers:
 *  1. STATIC — the §O contract is documented in loop-shared.md and pointed to
 *     from loop.md (Step 10 + the carve-out clause + Step 9d) and loop-dag.md
 *     (§4 termination). Assert real tokens so a silent drop fails the gate.
 *  2. BEHAVIORAL — import parityViolations / validateAllowlist from the #648
 *     parity suite and prove the gate's invariant audit goes RED on a synthetic
 *     stdio-only newly-added tool and GREEN once it has a remote counterpart.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const LOOP_PATH = resolve(REPO_ROOT, 'skills/tasks/loop.md');
const LOOP_DAG_PATH = resolve(REPO_ROOT, 'skills/tasks/loop-dag.md');
const LOOP_SHARED_PATH = resolve(REPO_ROOT, 'skills/tasks/loop-shared.md');

const loop = readFileSync(LOOP_PATH, 'utf8');
const loopDag = readFileSync(LOOP_DAG_PATH, 'utf8');
const loopShared = readFileSync(LOOP_SHARED_PATH, 'utf8');

describe('§O terminal completeness gate — documentation contract (#650)', () => {
  it('loop-shared.md declares the §O terminal completeness gate section', () => {
    expect(loopShared).toContain(
      '## §O. Terminal completeness gate (drained→done invariant + reachability audit)',
    );
  });

  it('§O names the stdio-remote-parity invariant audit test', () => {
    expect(loopShared).toContain('stdio-remote-parity');
    expect(loopShared).toContain(
      'npx vitest run src/mcp/__tests__/stdio-remote-parity.test.ts',
    );
    // Mirror parity is documented as part of the invariant audit.
    expect(loopShared.toLowerCase()).toContain('client-package');
    expect(loopShared.toLowerCase()).toContain('mirror parity');
  });

  it('§O reachability smoke uses the REMOTE proxy path, NOT in-process', () => {
    // The whole point of the retro: in-process reachability is insufficient.
    expect(loopShared).toContain('dist/mcp/remote');
    expect(loopShared.toLowerCase()).toContain('remote proxy');
    expect(loopShared.toLowerCase()).toContain('not');
    expect(loopShared.toLowerCase()).toContain('in-process');
    // "newly added" detection is documented.
    expect(loopShared.toLowerCase()).toContain('newly added');
  });

  it('§O documents the remediation-task carve-out and Coverage Gaps section', () => {
    expect(loopShared).toContain('wood-fired-tasks:create_task');
    expect(loopShared).toContain('## Coverage Gaps');
    // The carve-out is explicitly framed as the exception to the
    // "Don't create new tasks during the loop" rule.
    expect(loopShared.toLowerCase()).toContain(
      "don't create new tasks during the loop",
    );
    expect(loopShared.toLowerCase()).toContain('carve-out');
    // Empty-state sentinel is defined verbatim.
    expect(loopShared).toContain(
      '_No coverage gaps: terminal invariant + reachability audit green._',
    );
  });

  it('§O states blocking semantics: 0 open tasks alone is not success', () => {
    expect(loopShared).toContain('"0 open tasks"');
    expect(loopShared.toLowerCase()).toContain(
      'does not declare success',
    );
  });

  it('loop.md Step 10 references the §O terminal gate before declaring drained', () => {
    // Step 10·0 sub-step links to §O.
    expect(loop).toContain('§O terminal completeness gate');
    expect(loop).toContain(
      'loop-shared.md#o-terminal-completeness-gate-drainedone-invariant--reachability-audit',
    );
    expect(loop).toContain('### Step 10');
  });

  it('loop.md "don\'t create new tasks" rule carries the §O carve-out clause', () => {
    expect(loop).toContain('Don\'t create new tasks during the loop.');
    expect(loop).toContain('§O terminal-gate remediation-task carve-out');
  });

  it('loop.md Step 9d body-section list includes Coverage Gaps', () => {
    expect(loop).toContain('`## Coverage Gaps`');
    // The §O pointer accompanies it.
    const coverageIdx = loop.indexOf('`## Coverage Gaps`');
    expect(loop.slice(coverageIdx, coverageIdx + 400)).toContain('§O');
  });

  it('loop-dag.md references the §O gate at §4 termination', () => {
    expect(loopDag).toContain('§O terminal completeness gate');
    expect(loopDag).toContain(
      'loop-shared.md#o-terminal-completeness-gate-drainedone-invariant--reachability-audit',
    );
    expect(loopDag).toContain('## 4. Run-termination integration audit');
    // loop-dag also surfaces Coverage Gaps in its §5d body sections.
    expect(loopDag).toContain('## Coverage Gaps');
  });
});

describe('§O invariant audit genuinely detects unreachable newly-added tools (#650)', () => {
  it('parityViolations flags a synthetic stdio-only newly-added tool (gate RED)', () => {
    // A new stdio tool with no remote counterpart → RED → triggers the carve-out.
    expect(
      parityViolations(
        ['create_task', '__new_tool__'],
        new Set(['create_task']),
        [],
      ),
    ).toEqual(['__new_tool__']);
  });

  it('parityViolations returns [] once the tool is reachable via remote (gate GREEN)', () => {
    expect(
      parityViolations(
        ['create_task', '__new_tool__'],
        new Set(['create_task', '__new_tool__']),
        [],
      ),
    ).toEqual([]);
  });

  it('a reason-annotated allowlist entry can intentionally exempt a local-only tool', () => {
    expect(
      parityViolations(['create_task', '__local_only__'], new Set(['create_task']), [
        { name: '__local_only__', reason: 'direct-DB lifecycle owner; no REST surface' },
      ]),
    ).toEqual([]);
    // …but the exemption MUST carry a reason — empty reasons are rejected.
    expect(() =>
      validateAllowlist([{ name: '__local_only__', reason: '   ' }]),
    ).toThrow();
  });
});
