import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Wave 3.2 (task #317) — falsifiable gate on `skills/agents/integration-auditor.md`.
 *
 * The agent definition's frontmatter `tools:` line is the enforced read-only
 * tool surface — the load-bearing safety property of the auditor. If a future
 * edit silently adds Edit/Write or a mutating wood-fired-bugs MCP tool to the
 * frontmatter, the auditor could mutate the working tree or the bugs database
 * during composition analysis, which would defeat its purpose as an
 * independent grader.
 *
 * This test reads the agent markdown and asserts:
 *   1. Frontmatter `tools:` EXCLUDES every mutating tool (positive deny-list).
 *   2. Frontmatter `tools:` INCLUDES the minimum read-only surface.
 *   3. Body documents the JSON output shape, the three verdicts, and the
 *      hard bounds (15 tool calls, 3 minutes).
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const AGENT_PATH = resolve(REPO_ROOT, 'skills/agents/integration-auditor.md');

function frontmatterToolsLine(markdown: string): string {
  const lines = markdown.split('\n');
  const fmStart = lines.findIndex((line) => line.trim() === '---');
  if (fmStart < 0) return '';
  const fmEnd = lines.findIndex((line, idx) => idx > fmStart && line.trim() === '---');
  if (fmEnd < 0) return '';
  const fmBlock = lines.slice(fmStart + 1, fmEnd).join('\n');
  const toolsLine = fmBlock
    .split('\n')
    .find((line) => line.trim().startsWith('tools:'));
  return toolsLine ?? '';
}

describe('skills/agents/integration-auditor.md — frontmatter + body contract (#317)', () => {
  const agent = readFileSync(AGENT_PATH, 'utf8');
  const toolsLine = frontmatterToolsLine(agent);
  const body = agent.split(/^---\s*$/m).slice(2).join('---'); // everything after second `---`

  it('frontmatter has a non-empty tools: line', () => {
    expect(toolsLine.length).toBeGreaterThan(0);
  });

  it('frontmatter declares name: integration-auditor', () => {
    expect(agent).toMatch(/^name:\s*integration-auditor\s*$/m);
  });

  // ----- POSITIVE: required read-only tools must be present -----

  it('tools: INCLUDES Read', () => {
    expect(toolsLine).toMatch(/\bRead\b/);
  });

  it('tools: INCLUDES Grep', () => {
    expect(toolsLine).toMatch(/\bGrep\b/);
  });

  it('tools: INCLUDES Glob', () => {
    expect(toolsLine).toMatch(/\bGlob\b/);
  });

  it('tools: INCLUDES Bash', () => {
    expect(toolsLine).toMatch(/\bBash\b/);
  });

  it('tools: INCLUDES the read-only wood-fired-bugs MCP tool get_task', () => {
    expect(toolsLine).toMatch(/mcp__wood-fired-bugs__get_task/);
  });

  it('tools: INCLUDES the read-only wood-fired-bugs MCP tool list_tasks', () => {
    expect(toolsLine).toMatch(/mcp__wood-fired-bugs__list_tasks/);
  });

  // ----- NEGATIVE: every mutating tool MUST be excluded -----

  it('tools: EXCLUDES Edit (mutating file tool)', () => {
    expect(toolsLine).not.toMatch(/\bEdit\b/);
  });

  it('tools: EXCLUDES Write (mutating file tool)', () => {
    expect(toolsLine).not.toMatch(/\bWrite\b/);
  });

  it('tools: EXCLUDES MultiEdit (mutating file tool)', () => {
    expect(toolsLine).not.toMatch(/\bMultiEdit\b/);
  });

  it('tools: EXCLUDES NotebookEdit (mutating file tool)', () => {
    expect(toolsLine).not.toMatch(/\bNotebookEdit\b/);
  });

  it('tools: EXCLUDES every mutating wood-fired-bugs MCP tool', () => {
    const mutators = [
      'mcp__wood-fired-bugs__update_task',
      'mcp__wood-fired-bugs__claim_task',
      'mcp__wood-fired-bugs__add_comment',
      'mcp__wood-fired-bugs__create_task',
      'mcp__wood-fired-bugs__create_project',
      'mcp__wood-fired-bugs__delete_task',
      'mcp__wood-fired-bugs__delete_project',
      'mcp__wood-fired-bugs__delete_comment',
      'mcp__wood-fired-bugs__update_project',
      'mcp__wood-fired-bugs__add_dependency',
      'mcp__wood-fired-bugs__remove_dependency',
    ];
    for (const tool of mutators) {
      expect(toolsLine).not.toContain(tool);
    }
  });

  // ----- BODY: contract surface -----

  it('body mentions the JSON output shape — cites file_path field', () => {
    expect(body).toContain('file_path');
  });

  it('body mentions the JSON output shape — cites task_ids field', () => {
    expect(body).toContain('task_ids');
  });

  it('body mentions the JSON output shape — cites verdict field', () => {
    expect(body).toContain('verdict');
  });

  it('body mentions the JSON output shape — cites rationale field', () => {
    expect(body).toContain('rationale');
  });

  it('body mentions the JSON output shape — cites evidence field', () => {
    expect(body).toContain('evidence');
  });

  it('body documents all three verdicts (SAFE, RISKY, BROKEN)', () => {
    expect(body).toContain('SAFE');
    expect(body).toContain('RISKY');
    expect(body).toContain('BROKEN');
  });

  it('body documents the ≤ 15 tool-call bound', () => {
    // Tolerate spacing variants ("≤ 15", "<= 15", "15 tool calls").
    const hasBound = /15\s*tool\s*calls/i.test(body);
    expect(hasBound).toBe(true);
  });

  it('body documents the ≤ 3 minute wall-time bound', () => {
    // Tolerate "≤ 3 minutes", "3 minutes", "3 min".
    const hasBound = /3\s*(minutes|min)/i.test(body);
    expect(hasBound).toBe(true);
  });
});
