import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  analyzeWsjfHealth,
  DEFAULT_HEALTH_THRESHOLDS,
  WsjfHealthService,
  type HealthTaskSnapshot,
  type HealthHistoryPoint,
  type HealthCheckId,
} from '../wsjf-health.service.js';
import type { WsjfComponents } from '../../types/wsjf.js';
import type { ITaskRepository } from '../../repositories/interfaces.js';
import type { IWsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import { createTestApp, type App } from '../../index.js';
import { createMcpServer } from '../../mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ---------------------------------------------------------------------------
// WSJF 5.1 (#646) — degeneracy / pitfall linter acceptance tests.
//
// Convention (spec §9): each check must FIRE on a crafted degenerate fixture
// and stay SILENT on a healthy one. Every finding carries a severity, a
// plain-language message, and a suggested fix. The score-churn check consumes
// `wsjf_score_history` rows across rescore runs.
// ---------------------------------------------------------------------------

/** A balanced, healthy four-component set (varied, anchored, honest sizes). */
const C = (
  value: number,
  timeCriticality: number,
  riskOpportunity: number,
  jobSize: number,
): WsjfComponents => ({ value, timeCriticality, riskOpportunity, jobSize }) as WsjfComponents;

/** Build a scored snapshot with overridable deadline/ready. */
function snap(
  taskId: number,
  components: WsjfComponents | null,
  extra: Partial<HealthTaskSnapshot> = {},
): HealthTaskSnapshot {
  return {
    taskId,
    components,
    priority: 'medium',
    daysUntilDeadline: null,
    ready: true,
    ...extra,
  };
}

const NO_HISTORY = new Map<number, HealthHistoryPoint[]>();

/** All check ids that fired in a report. */
function fired(findings: { check: HealthCheckId }[]): HealthCheckId[] {
  return findings.map((f) => f.check);
}

/**
 * A deliberately NON-degenerate scored backlog: scores spread out, each CoD
 * column anchored at 1, job sizes use the full scale, no past-deadline tasks,
 * everything scored, no churn. Used as the "silent on healthy" baseline.
 */
const HEALTHY_SNAPSHOTS: HealthTaskSnapshot[] = [
  snap(1, C(1, 1, 1, 8)), // anchors every CoD column at 1; large job
  snap(2, C(13, 8, 5, 1)), // high value, small job → high WSJF
  snap(3, C(5, 3, 8, 3)),
  snap(4, C(8, 5, 2, 5)),
];

describe('analyzeWsjfHealth (#646) — healthy backlog is silent', () => {
  it('returns no findings on a well-formed scored backlog', () => {
    const report = analyzeWsjfHealth(7, HEALTHY_SNAPSHOTS, NO_HISTORY);
    expect(report.findings).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(report.scoredTaskCount).toBe(4);
  });
});

describe('analyzeWsjfHealth (#646) — degenerate-spread', () => {
  it('fires when all scored WSJF scores are near-identical', () => {
    // value 3, TC 1, RR 1 (anchored), jobSize 1 → all score exactly 5.0.
    const snaps = [snap(1, C(3, 1, 1, 1)), snap(2, C(3, 1, 1, 1)), snap(3, C(3, 1, 1, 1))];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    expect(fired(report.findings)).toContain('degenerate-spread');
    const f = report.findings.find((x) => x.check === 'degenerate-spread')!;
    expect(f.severity).toBe('warning');
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.suggestion.length).toBeGreaterThan(0);
    expect(f.taskIds).toEqual([1, 2, 3]);
  });

  it('is silent when scores spread out', () => {
    const report = analyzeWsjfHealth(7, HEALTHY_SNAPSHOTS, NO_HISTORY);
    expect(fired(report.findings)).not.toContain('degenerate-spread');
  });
});

describe('analyzeWsjfHealth (#646) — cod-no-anchor', () => {
  it('fires when a Cost-of-Delay column has no 1 anchor', () => {
    // Time Criticality never takes the value 1 across the set.
    const snaps = [snap(1, C(1, 2, 1, 5)), snap(2, C(5, 3, 1, 3)), snap(3, C(8, 5, 1, 8))];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    const anchorFindings = report.findings.filter((x) => x.check === 'cod-no-anchor');
    expect(anchorFindings.length).toBeGreaterThan(0);
    // The missing column is Time Criticality, not value/riskOpportunity.
    expect(anchorFindings.some((f) => f.message.includes('Time Criticality'))).toBe(true);
    expect(anchorFindings.some((f) => f.message.includes('User-Business Value'))).toBe(false);
    expect(anchorFindings[0].severity).toBe('warning');
    expect(anchorFindings[0].suggestion.length).toBeGreaterThan(0);
  });

  it('is silent when every CoD column is anchored at 1', () => {
    const report = analyzeWsjfHealth(7, HEALTHY_SNAPSHOTS, NO_HISTORY);
    expect(fired(report.findings)).not.toContain('cod-no-anchor');
  });
});

describe('analyzeWsjfHealth (#646) — job-size-collapsed', () => {
  it('fires when every Job Size is 1 or 2', () => {
    const snaps = [snap(1, C(1, 1, 1, 1)), snap(2, C(13, 8, 5, 2)), snap(3, C(5, 3, 8, 1))];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    const f = report.findings.find((x) => x.check === 'job-size-collapsed');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.suggestion.length).toBeGreaterThan(0);
  });

  it('is silent when Job Size uses the full scale', () => {
    const report = analyzeWsjfHealth(7, HEALTHY_SNAPSHOTS, NO_HISTORY);
    expect(fired(report.findings)).not.toContain('job-size-collapsed');
  });
});

describe('analyzeWsjfHealth (#646) — stale-time-criticality', () => {
  it('fires for a past-deadline task with high Time Criticality', () => {
    const snaps = [
      snap(1, C(5, 13, 3, 3), { daysUntilDeadline: -4 }), // past + TC 13
      snap(2, C(8, 2, 1, 5), { daysUntilDeadline: 10 }),
      snap(3, C(1, 1, 1, 8)),
    ];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    const f = report.findings.find((x) => x.check === 'stale-time-criticality');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('critical');
    expect(f!.taskIds).toEqual([1]);
    expect(f!.suggestion.length).toBeGreaterThan(0);
  });

  it('is silent when past-deadline tasks have low Time Criticality', () => {
    const snaps = [
      snap(1, C(5, 2, 3, 3), { daysUntilDeadline: -4 }), // past but TC low
      snap(2, C(8, 13, 1, 5), { daysUntilDeadline: 10 }), // high TC but future
      snap(3, C(1, 1, 1, 8)),
    ];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    expect(fired(report.findings)).not.toContain('stale-time-criticality');
  });
});

describe('analyzeWsjfHealth (#646) — high-fallback-ratio', () => {
  it('fires when most ready tasks are unscored', () => {
    const snaps = [
      snap(1, null), // unscored, ready → fallback
      snap(2, null),
      snap(3, null),
      snap(4, C(13, 8, 5, 1)),
    ];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    const f = report.findings.find((x) => x.check === 'high-fallback-ratio');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.taskIds.sort()).toEqual([1, 2, 3]);
    expect(f!.suggestion.length).toBeGreaterThan(0);
  });

  it('is silent when most ready tasks are scored', () => {
    const report = analyzeWsjfHealth(7, HEALTHY_SNAPSHOTS, NO_HISTORY);
    expect(fired(report.findings)).not.toContain('high-fallback-ratio');
  });
});

describe('analyzeWsjfHealth (#646) — score-churn across rescores', () => {
  const history = (scores: number[]): HealthHistoryPoint[] =>
    scores.map((s) => ({ wsjfScore: s, isRescore: true }));

  it('fires when a task value flaps across consecutive rescores', () => {
    // 5 → 9 → 4 → 8 : up, down, up = 2 reversals (≥ threshold 2).
    const byTask = new Map<number, HealthHistoryPoint[]>([[2, history([5, 9, 4, 8])]]);
    const report = analyzeWsjfHealth(7, [snap(2, C(5, 3, 8, 3))], byTask);
    const f = report.findings.find((x) => x.check === 'score-churn');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
    expect(f!.taskIds).toEqual([2]);
    expect(f!.suggestion.length).toBeGreaterThan(0);
  });

  it('is silent on a monotonically converging score series', () => {
    // 3 → 5 → 6 → 6 : never reverses direction.
    const byTask = new Map<number, HealthHistoryPoint[]>([[2, history([3, 5, 6, 6])]]);
    const report = analyzeWsjfHealth(7, [snap(2, C(5, 3, 8, 3))], byTask);
    expect(fired(report.findings)).not.toContain('score-churn');
  });

  it('ignores non-rescore history points (only rescore runs count)', () => {
    const byTask = new Map<number, HealthHistoryPoint[]>([
      [
        2,
        [
          { wsjfScore: 5, isRescore: false },
          { wsjfScore: 9, isRescore: false },
          { wsjfScore: 4, isRescore: false },
          { wsjfScore: 8, isRescore: false },
        ],
      ],
    ]);
    const report = analyzeWsjfHealth(7, [snap(2, C(5, 3, 8, 3))], byTask);
    expect(fired(report.findings)).not.toContain('score-churn');
  });
});

describe('analyzeWsjfHealth — auto-sized-pending', () => {
  it('fires with severity info and correct count when auto-sized tasks exist', () => {
    const snaps = [
      snap(10, null, { autoSized: true }), // auto-sized, CoD not yet classified
      snap(11, null, { autoSized: true }),
      snap(12, C(1, 1, 1, 8)), // fully scored → not auto-sized pending
    ];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    const f = report.findings.find((x) => x.check === 'auto-sized-pending');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
    expect(f!.taskIds.sort((a, b) => a - b)).toEqual([10, 11]);
    expect(f!.message).toContain('2');
    expect(f!.message.length).toBeGreaterThan(0);
    expect(f!.suggestion.length).toBeGreaterThan(0);
  });

  it('is absent when no auto-sized tasks exist', () => {
    const report = analyzeWsjfHealth(7, HEALTHY_SNAPSHOTS, NO_HISTORY);
    expect(report.findings.map((f) => f.check)).not.toContain('auto-sized-pending');
  });

  it('is absent when auto-sized field is false or omitted', () => {
    const snaps = [
      snap(1, null), // unscored but NOT auto-sized
      snap(2, C(1, 1, 1, 8)),
      snap(3, C(13, 8, 5, 1)),
      snap(4, C(5, 3, 8, 3)),
    ];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    expect(report.findings.map((f) => f.check)).not.toContain('auto-sized-pending');
  });
});

describe('analyzeWsjfHealth (#646) — every finding is well-formed', () => {
  it('all findings carry severity + non-empty message + suggestion', () => {
    // A maximally degenerate backlog: triggers several checks at once.
    const snaps = [
      snap(1, C(2, 2, 2, 2), { daysUntilDeadline: -5 }),
      snap(2, C(2, 2, 2, 2), { daysUntilDeadline: -5 }),
      snap(3, C(2, 2, 2, 2)),
      snap(4, null),
      snap(5, null),
    ];
    const report = analyzeWsjfHealth(7, snaps, NO_HISTORY);
    expect(report.healthy).toBe(false);
    expect(report.findings.length).toBeGreaterThan(1);
    for (const f of report.findings) {
      expect(['info', 'warning', 'critical']).toContain(f.severity);
      expect(f.message.trim().length).toBeGreaterThan(0);
      expect(f.suggestion.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(f.taskIds)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// DB-backed service + MCP tool registration.
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('WsjfHealthService + wsjf_health tool (#646)', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let projectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    const project = app.projectService.createProject({ name: 'WSJF Health Project' });
    projectId = project.id;

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
  ): Promise<number> {
    const result = (await client.callTool({
      name: 'create_task',
      arguments: { title, project_id: projectId, created_by: 'test', wsjf: c },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as { id: number }).id;
  }

  it('is registered through registerWsjfTools and returns the findings list', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('wsjf_health');

    // Craft a degenerate backlog: three identical scores, no CoD anchor, all
    // tiny jobs → multiple findings.
    await createScoredTask('A', { value: 3, timeCriticality: 2, riskOpportunity: 2, jobSize: 2 });
    await createScoredTask('B', { value: 3, timeCriticality: 2, riskOpportunity: 2, jobSize: 2 });
    await createScoredTask('C', { value: 3, timeCriticality: 2, riskOpportunity: 2, jobSize: 2 });

    const result = (await client.callTool({
      name: 'wsjf_health',
      arguments: { project_id: projectId },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      healthy: boolean;
      findings: { check: string; severity: string; message: string; suggestion: string }[];
      scored_task_count: number;
    };
    expect(sc.healthy).toBe(false);
    expect(Array.isArray(sc.findings)).toBe(true);
    expect(sc.findings.length).toBeGreaterThan(0);
    expect(sc.scored_task_count).toBe(3);
    for (const f of sc.findings) {
      expect(f.message.length).toBeGreaterThan(0);
      expect(f.suggestion.length).toBeGreaterThan(0);
    }
  });

  it('reports healthy on a well-formed scored backlog', async () => {
    await createScoredTask('anchor', {
      value: 1,
      timeCriticality: 1,
      riskOpportunity: 1,
      jobSize: 8,
    });
    await createScoredTask('big', {
      value: 13,
      timeCriticality: 8,
      riskOpportunity: 5,
      jobSize: 1,
    });
    await createScoredTask('mid', { value: 5, timeCriticality: 3, riskOpportunity: 8, jobSize: 3 });
    await createScoredTask('low', { value: 8, timeCriticality: 5, riskOpportunity: 2, jobSize: 5 });

    const result = (await client.callTool({
      name: 'wsjf_health',
      arguments: { project_id: projectId },
    })) as ToolResult;
    const sc = result.structuredContent as { healthy: boolean; findings: unknown[] };
    expect(sc.healthy).toBe(true);
    expect(sc.findings).toEqual([]);
  });

  it('auto-sized-pending: WsjfHealthService detects tasks with source=auto and null CoD', () => {
    // Stub a task repository with one auto-sized task (wsjf_source.jobSize='auto',
    // CoD columns null) and one fully-scored task.
    const svc = new WsjfHealthService({
      tasks: {
        count: () => 2,
        findByFilters: () => [
          {
            id: 200,
            title: 'auto-sized task',
            description: null,
            status: 'open',
            priority: 'medium',
            project_id: projectId,
            project_name: 'p',
            parent_task_id: null,
            estimated_minutes: 60,
            assignee: null,
            created_by: 't',
            due_date: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            version: 1,
            claimed_at: null,
            completed_at: null,
            acceptance_criteria: null,
            verification_evidence: null,
            wsjf_value: null,
            wsjf_time_criticality: null,
            wsjf_risk_opportunity: null,
            wsjf_job_size: 3,
            wsjf_evidence: null,
            wsjf_locked: null,
            wsjf_source: {
              value: 'auto',
              timeCriticality: 'auto',
              riskOpportunity: 'auto',
              jobSize: 'auto',
            },
            wsjf_classifications: null,
            wsjf_features: null,
          },
          {
            id: 201,
            title: 'fully scored task',
            description: null,
            status: 'open',
            priority: 'medium',
            project_id: projectId,
            project_name: 'p',
            parent_task_id: null,
            estimated_minutes: null,
            assignee: null,
            created_by: 't',
            due_date: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            version: 1,
            claimed_at: null,
            completed_at: null,
            acceptance_criteria: null,
            verification_evidence: null,
            wsjf_value: 5,
            wsjf_time_criticality: 3,
            wsjf_risk_opportunity: 2,
            wsjf_job_size: 3,
            wsjf_evidence: null,
            wsjf_locked: null,
            wsjf_source: {
              value: 'manual',
              timeCriticality: 'manual',
              riskOpportunity: 'manual',
              jobSize: 'manual',
            },
            wsjf_classifications: null,
            wsjf_features: null,
          },
        ],
      } as unknown as ITaskRepository,
      history: {
        findByTaskId: () => [],
      } as unknown as IWsjfHistoryRepository,
    });

    const report = svc.check(projectId);
    const f = report.findings.find((x) => x.check === 'auto-sized-pending');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
    expect(f!.taskIds).toEqual([200]);
  });

  it('score-churn consumes wsjf_score_history across rescore runs', () => {
    // Drive the DB-backed service directly so we control the history rows.
    const svc = new WsjfHealthService({
      tasks: {
        count: () => 1,
        findByFilters: () => [
          {
            id: 99,
            title: 'flapper',
            description: null,
            status: 'open',
            priority: 'medium',
            project_id: projectId,
            project_name: 'p',
            parent_task_id: null,
            estimated_minutes: null,
            assignee: null,
            created_by: 't',
            due_date: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            version: 1,
            claimed_at: null,
            completed_at: null,
            acceptance_criteria: null,
            verification_evidence: null,
            wsjf_value: 5,
            wsjf_time_criticality: 3,
            wsjf_risk_opportunity: 8,
            wsjf_job_size: 3,
            wsjf_evidence: null,
            wsjf_locked: null,
            wsjf_source: null,
            wsjf_classifications: null,
            wsjf_features: null,
          },
        ],
      } as unknown as ITaskRepository,
      history: {
        findByTaskId: () =>
          [5, 9, 4, 8].map((s, i) => ({
            id: i + 1,
            task_id: 99,
            project_id: projectId,
            changed_at: `2026-0${i + 1}-01T00:00:00Z`,
            trigger: 'rescore' as const,
            actor_type: null,
            actor_id: null,
            charter_version: null,
            rescore_run_id: i + 1,
            value: 5,
            time_criticality: 3,
            risk_opportunity: 8,
            job_size: 3,
            classifications: null,
            features: null,
            evidence: null,
            source: null,
            locked: null,
            wsjf_score: s,
            prev_wsjf_score: i > 0 ? [5, 9, 4][i - 1] : null,
          })),
      } as unknown as IWsjfHistoryRepository,
    });

    const report = svc.check(projectId, { thresholds: DEFAULT_HEALTH_THRESHOLDS });
    const churn = report.findings.find((f) => f.check === 'score-churn');
    expect(churn).toBeDefined();
    expect(churn!.taskIds).toEqual([99]);
  });
});
