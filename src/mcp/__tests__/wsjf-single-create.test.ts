import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';
import type { ValueCharter } from '../../types/task.js';
import type { WsjfClassification, WsjfFeatures } from '../../types/wsjf.js';

// Standard (non-compatibility) tool-result shape — mirrors wsjf-tools.test.ts.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * WSJF 2.3 (#634) — single-create scoring: the `create_task` MCP tool, when it
 * carries a classified `wsjf_submission`, stamps the resulting
 * `wsjf_score_history` row with the GENERIC trigger `'single_create'` (vs the
 * bare-create default of `'create'`). Proven for both the charter and the
 * empty-charter/fallback paths.
 *
 * The trigger threads: `create_task` tool input → `submissionToWsjfWrite(...,
 * 'single_create')` sets `wsjf.trigger` on the WriteDTO → `createTask` resolves
 * `wsjf.trigger ?? 'create'` → `appendWsjfHistory` writes the row. The hint is
 * generic so sibling #633 (decompose) reuses it with `'decompose'`.
 */
describe('WSJF single-create scoring trigger (#634)', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  const features: WsjfFeatures = {
    deadlineDate: null,
    daysUntilDeadline: null,
    transitiveDependents: 0,
    filesTouched: 1,
    charterVersion: null,
  };

  /**
   * A classification whose every evidence span is the given verbatim text.
   * `alignment` is parameterised: a charter task uses `weak` (weight 13 → UBV 5)
   * so `jobSizeTier: 1` does NOT trip the `value=13 ∧ jobSize=1` contradiction
   * rule the gate enforces; the charter-less task uses `none` (UBV floor 1).
   */
  function classification(span: string, themeName: string | null): WsjfClassification {
    return {
      themeName,
      alignment: themeName ? 'weak' : 'none',
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

  const charter: ValueCharter = {
    mission: 'keep checkout reliable',
    value_themes: [{ name: 'Reliability', weight: 13, description: 'do not break prod' }],
    time_context: 'no hard deadline',
    risk_posture: 'must not break production data',
    out_of_scope: [],
    interview_version: 1,
    updated_at: '2026-06-01T12:00:00Z',
  };

  beforeEach(async () => {
    app = await createTestApp();
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

  /** Read back a task's history timeline via the wsjf_history MCP tool. */
  async function historyTimeline(taskId: number): Promise<Array<{ trigger: string }>> {
    const history = (await client.callTool({
      name: 'wsjf_history',
      arguments: { task_id: taskId },
    })) as ToolResult;
    expect(history.isError).toBeFalsy();
    return (history.structuredContent as { timeline: Array<{ trigger: string }> }).timeline;
  }

  it('charter path: a classified single-create stamps trigger=single_create', async () => {
    // Project carries a charter (Reliability theme); classify against it.
    const project = app.projectService.createProject({ name: 'Charter Proj' });
    app.projectService.updateProject(project.id, { value_charter: charter });

    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Fix the login crash on submit',
        project_id: project.id,
        created_by: 'test-agent',
        wsjf_submission: {
          classification: classification('login crash', 'Reliability'),
          features,
        },
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const task = result.structuredContent as { id: number };

    const timeline = await historyTimeline(task.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].trigger).toBe('single_create');
  });

  it('empty-charter fallback path: still stamps trigger=single_create with the fallback recorded in evidence', async () => {
    // Project has NO charter → themeName null, signal-based classification. The
    // fallback signal is RECORDED verbatim in the evidence spans.
    const project = app.projectService.createProject({ name: 'No Charter Proj' });
    expect(app.projectService.getProject(project.id).value_charter).toBeNull();

    const fallbackSignal = 'login crash';
    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Fix the login crash on submit',
        project_id: project.id,
        created_by: 'test-agent',
        wsjf_submission: {
          // No charter → themeName null; evidence quotes the in-text signal the
          // classification fell back to (recorded fallback, spec §2.3).
          classification: classification(fallbackSignal, null),
          features,
        },
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const task = result.structuredContent as { id: number };

    const timeline = await historyTimeline(task.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].trigger).toBe('single_create');

    // The recorded fallback is auditable: the persisted classification carries
    // themeName=null and the in-text signal as its evidence span.
    const stored = app.taskService.getTask(task.id);
    expect(stored.wsjf_classifications?.themeName).toBeNull();
    expect(stored.wsjf_evidence?.value).toBe(fallbackSignal);
  });
});
