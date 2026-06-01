import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createTestApp, type App } from '../../../../index.js';
import { createMcpServer } from '../../../../mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * WSJF 5.2 (task #647) — surface `wsjf_health` findings in loop / loop-dag /
 * project-status / post-rescore.
 *
 * Task #646 shipped the `wsjf_health` MCP tool (degeneracy / pitfall linter,
 * spec §9 + §11.4). This task wires its findings into the four skill surfaces:
 *
 *   - skills/tasks/loop.md         — §2g loop-start health surfacing
 *   - skills/tasks/loop-dag.md     — §2h loop-start health surfacing
 *   - skills/tasks/project-status.md — §4b per-project health subsection
 *   - skills/tasks/new-project.md  — post-rescore health surfacing (Step 12)
 *
 * Two halves:
 *
 *   1. SKILL-CONTENT GATE — each of the four skills MUST invoke `wsjf_health`
 *      and document how it surfaces the findings list. Mirrors the falsifiable
 *      skill-markdown convention of `loop-skill-preflight-gate.test.ts`: a
 *      future edit that silently drops the surfacing cannot land green.
 *
 *   2. SMOKE (end-to-end fixture) — the degenerate fixture the skills surface
 *      produces warning findings via the live `wsjf_health` MCP tool, and the
 *      healthy fixture is silent (empty findings). This is the data the
 *      loop-start + post-rescore surfacing prose acts on, exercised through the
 *      same tool the skills call.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const SKILL_DIR = resolve(REPO_ROOT, 'skills/tasks');

function readSkill(name: string): string {
  return readFileSync(resolve(SKILL_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Part 1 — skill-content gate
// ---------------------------------------------------------------------------

describe('WSJF 5.2 (#647) — skills invoke wsjf_health and surface its findings', () => {
  const SURFACING_SKILLS = [
    'loop.md',
    'loop-dag.md',
    'project-status.md',
    'new-project.md',
  ] as const;

  it.each([...SURFACING_SKILLS])(
    '%s invokes the wsjf_health MCP tool by name',
    (file) => {
      const skill = readSkill(file);
      expect(skill).toMatch(/wsjf_health/);
      expect(skill).toMatch(/mcp__wood-fired-tasks__wsjf_health/);
    },
  );

  it.each([...SURFACING_SKILLS])(
    '%s documents the findings list it prints (severity + message + suggestion)',
    (file) => {
      const skill = readSkill(file);
      expect(skill).toMatch(/findings/);
      expect(skill).toMatch(/severity/);
      expect(skill).toMatch(/suggestion/i);
    },
  );

  it.each([...SURFACING_SKILLS])(
    '%s states the linter is non-blocking / advisory (never blocks the run)',
    (file) => {
      const skill = readSkill(file);
      expect(skill).toMatch(/non-blocking|advisory|never block/i);
    },
  );

  it('loop.md surfaces health at loop start (§2g), before Step 1 selection', () => {
    const skill = readSkill('loop.md');
    const has2g = skill
      .split('\n')
      .some((line) => line.startsWith('### 2g. WSJF health surfacing'));
    expect(has2g).toBe(true);
    const idx2g = skill.indexOf('### 2g. WSJF health surfacing');
    const idxLoop = skill.indexOf('## 3. The Loop');
    expect(idx2g).toBeGreaterThan(0);
    expect(idxLoop).toBeGreaterThan(idx2g);
  });

  it('loop-dag.md surfaces health at loop start (§2h), before §3a frontier', () => {
    const skill = readSkill('loop-dag.md');
    const has2h = skill
      .split('\n')
      .some((line) => line.startsWith('### 2h. WSJF health surfacing'));
    expect(has2h).toBe(true);
    const idx2h = skill.indexOf('### 2h. WSJF health surfacing');
    const idxWave = skill.indexOf('## 3. The Wave Loop');
    expect(idx2h).toBeGreaterThan(0);
    expect(idxWave).toBeGreaterThan(idx2h);
  });

  it('new-project.md surfaces health POST-rescore (in the rescore step)', () => {
    const skill = readSkill('new-project.md');
    expect(skill).toMatch(/Post-rescore health surfacing/i);
    const idxRescore = skill.indexOf('rescore_project');
    const idxHealth = skill.indexOf('wsjf_health');
    expect(idxRescore).toBeGreaterThan(0);
    expect(idxHealth).toBeGreaterThan(idxRescore);
  });

  it('project-status.md surfaces per-project health findings (§4b)', () => {
    const skill = readSkill('project-status.md');
    expect(skill).toMatch(/Surface WSJF health findings/i);
    expect(skill).toMatch(/healthy[\s\S]{0,200}render NOTHING|silent/i);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — smoke: degenerate fires, healthy silent (via the live MCP tool)
// ---------------------------------------------------------------------------

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
}

describe('WSJF 5.2 (#647) — smoke: wsjf_health fixtures the surfaces consume', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let projectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    projectId = app.projectService.createProject({ name: 'WSJF 5.2 surfacing' }).id;

    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
      undefined,
      app.topologyService,
    );
    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  async function createScoredTask(
    title: string,
    c: { value: number; timeCriticality: number; riskOpportunity: number; jobSize: number },
  ): Promise<void> {
    const result = (await client.callTool({
      name: 'create_task',
      arguments: { title, project_id: projectId, created_by: 'test', wsjf: c },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
  }

  async function health(): Promise<{
    healthy: boolean;
    findings: { check: string; severity: string; message: string; suggestion: string }[];
  }> {
    const result = (await client.callTool({
      name: 'wsjf_health',
      arguments: { project_id: projectId },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return result.structuredContent as {
      healthy: boolean;
      findings: { check: string; severity: string; message: string; suggestion: string }[];
    };
  }

  it('degenerate fixture surfaces warning findings (what loop-start / post-rescore print)', async () => {
    await createScoredTask('A', { value: 3, timeCriticality: 2, riskOpportunity: 2, jobSize: 2 });
    await createScoredTask('B', { value: 3, timeCriticality: 2, riskOpportunity: 2, jobSize: 2 });
    await createScoredTask('C', { value: 3, timeCriticality: 2, riskOpportunity: 2, jobSize: 2 });

    const sc = await health();
    expect(sc.healthy).toBe(false);
    expect(sc.findings.length).toBeGreaterThan(0);
    for (const f of sc.findings) {
      expect(['info', 'warning', 'critical']).toContain(f.severity);
      expect(f.message.length).toBeGreaterThan(0);
      expect(f.suggestion.length).toBeGreaterThan(0);
    }
  });

  it('healthy fixture is silent (surfaces render nothing)', async () => {
    await createScoredTask('anchor', { value: 1, timeCriticality: 1, riskOpportunity: 1, jobSize: 8 });
    await createScoredTask('big', { value: 13, timeCriticality: 8, riskOpportunity: 5, jobSize: 1 });
    await createScoredTask('mid', { value: 5, timeCriticality: 3, riskOpportunity: 8, jobSize: 3 });
    await createScoredTask('low', { value: 8, timeCriticality: 5, riskOpportunity: 2, jobSize: 5 });

    const sc = await health();
    expect(sc.healthy).toBe(true);
    expect(sc.findings).toEqual([]);
  });
});
