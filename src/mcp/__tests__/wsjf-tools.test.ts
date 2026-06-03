import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';
import type { RankedTask } from '../../services/wsjf.service.js';
import type { WsjfClassification, WsjfFeatures } from '../../types/wsjf.js';

// Standard (non-compatibility) tool-result shape — mirrors task-tools.test.ts.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * WSJF 1.10 (#630) — acceptance tests for the wsjf_ranking + wsjf_history MCP
 * tools and the create/update WSJF submission routing.
 */
describe('MCP WSJF Tools (#630)', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let projectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    const project = app.projectService.createProject({ name: 'WSJF Project' });
    projectId = project.id;

    // Pass topologyService so wsjf_ranking is wired the same way production is.
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

  /** Create a task carrying a raw (manual-equivalent) WSJF write so it ranks. */
  async function createScoredTask(
    title: string,
    components: { value: number; timeCriticality: number; riskOpportunity: number; jobSize: number },
  ): Promise<number> {
    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title,
        project_id: projectId,
        created_by: 'test-agent',
        wsjf: components,
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as { id: number }).id;
  }

  // -------------------------------------------------------------------------
  // AC1 — wsjf_ranking(scope) returns an ordered list with propagation breakdown.
  // -------------------------------------------------------------------------
  describe('wsjf_ranking', () => {
    it('returns a frontier-ordered list with propagation breakdown', async () => {
      // A blocks B (A→B): A's effective CoD is raised by B's γ-discounted CoD.
      const a = await createScoredTask('A', {
        value: 2,
        timeCriticality: 2,
        riskOpportunity: 2,
        jobSize: 1,
      });
      const b = await createScoredTask('B', {
        value: 8,
        timeCriticality: 8,
        riskOpportunity: 8,
        jobSize: 1,
      });
      app.dependencyService.addDependency({ task_id: a, blocks_task_id: b });

      const result = (await client.callTool({
        name: 'wsjf_ranking',
        arguments: { project_id: projectId, scope: 'all' },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        project_id: number;
        scope: string;
        ranking: RankedTask[];
      };
      expect(data.scope).toBe('all');
      expect(data.ranking).toHaveLength(2);

      // Ordered descending by effectiveWsjf.
      for (let i = 1; i < data.ranking.length; i++) {
        expect(data.ranking[i - 1].effectiveWsjf).toBeGreaterThanOrEqual(
          data.ranking[i].effectiveWsjf,
        );
      }

      // A carries a propagation breakdown crediting downstream dependent B.
      const ra = data.ranking.find((r) => r.taskId === a)!;
      expect(ra.scored).toBe(true);
      expect(ra.propagation.length).toBeGreaterThan(0);
      expect(ra.propagation.map((p) => p.dependentId)).toContain(b);
      expect(ra.propagation[0].contribution).toBeGreaterThan(0);
      // Propagation lifts A's effective WSJF above its base.
      expect(ra.effectiveWsjf).toBeGreaterThan(ra.baseWsjf!);
    });

    it('frontier scope is the default and excludes blocked tasks', async () => {
      await createScoredTask('ready', {
        value: 3,
        timeCriticality: 3,
        riskOpportunity: 3,
        jobSize: 2,
      });
      // A blocked task is not on the frontier.
      const blockedResult = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'blocked one',
          project_id: projectId,
          created_by: 'test-agent',
          wsjf: { value: 8, timeCriticality: 8, riskOpportunity: 8, jobSize: 1 },
        },
      })) as ToolResult;
      const blockedId = (blockedResult.structuredContent as { id: number }).id;
      app.taskService.updateTask(blockedId, { status: 'blocked' });

      const result = (await client.callTool({
        name: 'wsjf_ranking',
        arguments: { project_id: projectId },
      })) as ToolResult;
      const data = result.structuredContent as { scope: string; ranking: RankedTask[] };
      expect(data.scope).toBe('frontier');
      expect(data.ranking.map((r) => r.taskId)).not.toContain(blockedId);
    });
  });

  // -------------------------------------------------------------------------
  // AC2 — create_task with a bad evidence span is rejected with a structured error.
  // -------------------------------------------------------------------------
  describe('create_task WSJF submission routing', () => {
    const features: WsjfFeatures = {
      deadlineDate: null,
      daysUntilDeadline: null,
      transitiveDependents: 0,
      filesTouched: 1,
      charterVersion: null,
    };

    /** A classification whose every evidence span is the given text. */
    function classification(span: string): WsjfClassification {
      return {
        themeName: null,
        alignment: 'none',
        severity: 'none',
        decay: 'flat',
        jobSizeTier: 1,
        evidence: {
          value: span,
          timeCriticality: span,
          riskOpportunity: span,
          jobSize: span,
        },
      };
    }

    it('accepts a submission whose evidence spans are verbatim substrings', async () => {
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Fix the login crash on submit',
          project_id: projectId,
          created_by: 'test-agent',
          wsjf_submission: {
            classification: classification('login crash'),
            features,
          },
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const task = result.structuredContent as { id: number };
      // The server recomputed + persisted the components → a history row exists.
      const history = (await client.callTool({
        name: 'wsjf_history',
        arguments: { task_id: task.id },
      })) as ToolResult;
      const timeline = (history.structuredContent as { timeline: unknown[] }).timeline;
      expect(timeline.length).toBe(1);
    });

    it('rejects a submission with a bad (non-verbatim) evidence span with a structured error', async () => {
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Fix the login crash on submit',
          project_id: projectId,
          created_by: 'test-agent',
          wsjf_submission: {
            // "not in the task text" is NOT a substring of the title → gate fails.
            classification: classification('not in the task text'),
            features,
          },
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      const text = result.content.map((c) => c.text ?? '').join(' ');
      expect(text.toLowerCase()).toContain('validation');
    });
  });

  // -------------------------------------------------------------------------
  // AC3 — wsjf_history(task_id) returns the timeline with from→to deltas.
  // -------------------------------------------------------------------------
  describe('wsjf_history', () => {
    it('returns the timeline with from→to deltas across re-scores', async () => {
      const taskId = await createScoredTask('history task', {
        value: 2,
        timeCriticality: 2,
        riskOpportunity: 2,
        jobSize: 2,
      });
      // Re-score via update_task (raw wsjf write → second history row).
      app.taskService.updateTask(taskId, {
        wsjf: { value: 8, timeCriticality: 8, riskOpportunity: 8, jobSize: 2 },
      });

      const result = (await client.callTool({
        name: 'wsjf_history',
        arguments: { task_id: taskId },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        task_id: number;
        timeline: Array<{
          trigger: string;
          deltas: Record<string, { from: number | null; to: number | null }>;
        }>;
      };
      expect(data.task_id).toBe(taskId);
      expect(data.timeline).toHaveLength(2);

      // First entry: from is null (first scoring), to is the initial value.
      expect(data.timeline[0].deltas.value.from).toBeNull();
      expect(data.timeline[0].deltas.value.to).toBe(2);

      // Second entry: from→to reflects the re-score (2 → 8).
      expect(data.timeline[1].deltas.value.from).toBe(2);
      expect(data.timeline[1].deltas.value.to).toBe(8);
      // wsjf_score delta is reported too and changed.
      expect(data.timeline[1].deltas.wsjf_score.from).not.toBe(
        data.timeline[1].deltas.wsjf_score.to,
      );
    });

    it('returns an empty timeline for a task with no WSJF history', async () => {
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'unscored',
          project_id: projectId,
          created_by: 'test-agent',
        },
      })) as ToolResult;
      const taskId = (result.structuredContent as { id: number }).id;

      const history = (await client.callTool({
        name: 'wsjf_history',
        arguments: { task_id: taskId },
      })) as ToolResult;
      expect(history.isError).toBeFalsy();
      const data = history.structuredContent as { timeline: unknown[] };
      expect(data.timeline).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC4 — registerWsjfTools() is called in createMcpServer().
  // -------------------------------------------------------------------------
  it('registers wsjf_ranking + wsjf_history via createMcpServer', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('wsjf_ranking');
    expect(names).toContain('wsjf_history');
  });

  // -------------------------------------------------------------------------
  // #641 — rescore_project is registered through registerWsjfTools and returns
  // a run summary.
  // -------------------------------------------------------------------------
  describe('rescore_project (#641)', () => {
    it('is registered via createMcpServer', async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('rescore_project');
    });

    it('returns a run summary (empty submissions still opens a run)', async () => {
      const result = (await client.callTool({
        name: 'rescore_project',
        arguments: { project_id: projectId, submissions: [] },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        run_id: number;
        project_id: number;
        tasks_evaluated: number;
        tasks_changed: number;
        tasks_skipped_locked: number;
      };
      expect(data.project_id).toBe(projectId);
      expect(data.run_id).toBeGreaterThan(0);
      expect(data.tasks_evaluated).toBe(0);
      expect(data.tasks_changed).toBe(0);
    });
  });
});
