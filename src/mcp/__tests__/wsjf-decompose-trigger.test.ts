import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';
import type { ValueCharter } from '../../types/task.js';
import type { WsjfClassification, WsjfFeatures } from '../../types/wsjf.js';

// Standard (non-compatibility) tool-result shape — mirrors wsjf-single-create.test.ts.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * WSJF 2.2 (#633) — decompose batch scoring trigger: the `create_task` MCP tool
 * accepts an optional `wsjf_trigger` input that drives the `wsjf_score_history`
 * row's `trigger`. The decompose skill (skills/tasks/decompose.md Step 8) passes
 * `wsjf_trigger='decompose'` so a decompose-batch score is auditably distinct
 * from a single-create or manual override.
 *
 * This test proves the trigger is INPUT-DRIVEN:
 *   1. `wsjf_trigger='decompose'` → history row stamped `trigger='decompose'`.
 *   2. unset → DEFAULT remains `'single_create'` (preserving #634's behavior +
 *      its test in wsjf-single-create.test.ts).
 *
 * The trigger threads: `create_task` tool input (`wsjf_trigger`) →
 * `submissionToWsjfWrite(..., wsjf_trigger ?? 'single_create')` sets
 * `wsjf.trigger` on the WriteDTO → `createTask` resolves `wsjf.trigger` →
 * `appendWsjfHistory` writes the row.
 */
describe('WSJF decompose batch scoring trigger (#633)', () => {
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
   * `alignment: 'weak'` (weight 13 → UBV 5) so `jobSizeTier: 1` does NOT trip
   * the `value=13 ∧ jobSize=1` contradiction rule the gate enforces.
   */
  function classification(span: string, themeName: string): WsjfClassification {
    return {
      themeName,
      alignment: 'weak',
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

  it('wsjf_trigger=decompose stamps history trigger=decompose with components + evidence', async () => {
    const project = app.projectService.createProject({ name: 'Decomp Proj' });
    app.projectService.updateProject(project.id, { value_charter: charter });

    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Fix the login crash on submit',
        project_id: project.id,
        created_by: 'decompose-agent',
        wsjf_submission: {
          classification: classification('login crash', 'Reliability'),
          features,
        },
        wsjf_trigger: 'decompose',
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const task = result.structuredContent as { id: number };

    const timeline = await historyTimeline(task.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].trigger).toBe('decompose');

    // Materialized task carries server-computed components + evidence.
    const stored = app.taskService.getTask(task.id);
    expect(stored.wsjf_value).not.toBeNull();
    expect(stored.wsjf_job_size).not.toBeNull();
    expect(stored.wsjf_evidence?.value).toBe('login crash');
    expect(stored.wsjf_classifications?.themeName).toBe('Reliability');
  });

  it('unset wsjf_trigger DEFAULTS to single_create (preserves #634)', async () => {
    const project = app.projectService.createProject({ name: 'Default Proj' });
    app.projectService.updateProject(project.id, { value_charter: charter });

    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Fix the login crash on submit',
        project_id: project.id,
        created_by: 'single-agent',
        wsjf_submission: {
          classification: classification('login crash', 'Reliability'),
          features,
        },
        // wsjf_trigger intentionally omitted.
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const task = result.structuredContent as { id: number };

    const timeline = await historyTimeline(task.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].trigger).toBe('single_create');
  });

  // Decompose OPT-OUT path (skills/tasks/decompose.md Step 8a opt-out note):
  // materializing WITHOUT `wsjf_submission` (and without `wsjf_trigger`) creates
  // an unscored task — no gate, no components, no history row. This is the
  // documented "WSJF unwanted / no charter" escape hatch; selection falls back
  // to priority+ID. Guards against the schema's raw `wsjf` path being silently
  // required.
  it('omitting wsjf_submission creates an UNSCORED task (decompose opt-out)', async () => {
    const project = app.projectService.createProject({ name: 'Unscored Proj' });
    app.projectService.updateProject(project.id, { value_charter: charter });

    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Fix the login crash on submit',
        project_id: project.id,
        created_by: 'decompose-agent',
        // No wsjf_submission, no wsjf_trigger, no raw wsjf — opt out of scoring.
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const task = result.structuredContent as { id: number };

    const stored = app.taskService.getTask(task.id);
    expect(stored.wsjf_value).toBeNull();
    expect(stored.wsjf_time_criticality).toBeNull();
    expect(stored.wsjf_risk_opportunity).toBeNull();
    expect(stored.wsjf_job_size).toBeNull();

    const timeline = await historyTimeline(task.id);
    expect(timeline).toHaveLength(0);
  });
});
