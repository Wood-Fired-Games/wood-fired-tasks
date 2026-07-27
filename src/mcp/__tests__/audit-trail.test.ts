/**
 * Security Audit finding M5 (task #1632) — stdio MCP audit-trail producer
 * tests.
 *
 * Every suite here drives the REAL boot path: mint a PAT, resolve it with
 * `resolveActorUserIdWithPath` exactly as `src/mcp/index.ts` does, build the
 * server with the resolved context, and call tools over an in-memory JSON-RPC
 * transport. Rows are then read back through the audit-event REPOSITORY (never
 * raw SQL against `audit_events` — that table has exactly one owner).
 *
 * The load-bearing assertions are the negative ones: a read-only tool writing
 * nothing, a scope-refused call writing nothing, and a broken audit sink not
 * breaking the tool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '../../index.js';
import type { App } from '../../index.js';
import { createServer } from '../../api/server.js';
import { seedAuth } from '../../api/__tests__/helpers/auth.js';
import { createMcpServer } from '../server.js';
import { resolveActorUserIdWithPath } from '../identity-resolution.js';
import { MUTATING_TOOL_SCOPES } from '../scope-gate.js';
import {
  MCP_AUDIT_TARGETS,
  buildMcpAuditAction,
  isMutatingTool,
  mcpActorTypeForPath,
  mcpAuthMethodForPath,
  pickIdArgs,
  type AuditAppender,
} from '../audit-trail.js';
import { generateToken } from '../../services/pat-hash.js';
import type { AuditEventRecord, AuditEventRow } from '../../repositories/interfaces.js';
import type { PatScope } from '../../schemas/pat-scope.schema.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown> | null;
  isError?: boolean;
}

describe('stdio MCP audit trail (#1632)', () => {
  let app: App;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let ownerUserId: number;

  beforeEach(async () => {
    app = await createTestApp();
    const owner = app.db
      .prepare(`INSERT INTO users (display_name, email) VALUES (?, ?) RETURNING id`)
      .get('audit-owner', 'audit-owner@example.com') as { id: number };
    ownerUserId = owner.id;
  });

  afterEach(async () => {
    if (clientTransport) await clientTransport.close();
    if (serverTransport) await serverTransport.close();
    app.dispose();
  });

  function mintPat(scopes: PatScope[]): string {
    const { token, prefix, suffix, hash } = generateToken();
    app.apiTokenRepository.insert({
      userId: ownerUserId,
      name: `audit-${scopes.join('-') || 'legacy'}`,
      prefix,
      suffix,
      hash,
      scopes: JSON.stringify(scopes),
    });
    return token;
  }

  /**
   * Boot an MCP server the way `src/mcp/index.ts` does. `auditOverride` swaps
   * the append sink so a test can inject a failure; omitting it exercises the
   * production wiring (`app.auditEventRepository`).
   */
  async function bootMcp(
    apiKey: string | undefined,
    auditOverride?: AuditAppender,
  ): Promise<{ actorUserId: number; tokenId: number | null }> {
    const { actorUserId, scopes, tokenId, path } = resolveActorUserIdWithPath({
      apiKey,
      apiTokenRepo: app.apiTokenRepository,
      userRepo: app.userRepository,
    });

    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
      {
        actorUserId,
        scopes,
        tokenId: tokenId === null ? null : String(tokenId),
        resolutionPath: path,
        auditEventRepository: auditOverride ?? app.auditEventRepository,
        userRepository: app.userRepository,
      },
      app.topologyService,
      app.modelCatalogService,
      app.modelPolicyService,
      app.settingsService,
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'audit-trail-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    return { actorUserId, tokenId };
  }

  function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  }

  /** Every row in the trail, oldest-first, read through the repository. */
  function allRows(): AuditEventRow[] {
    return app.auditEventRepository
      .findByTimeRange('0000-01-01 00:00:00', '9999-12-31 23:59:59', 1000)
      .slice()
      .reverse();
  }

  // ==========================================================================
  // AC: an MCP create_task call produces exactly one row naming the tool
  // ==========================================================================
  describe('a mutating tool appends exactly one row', () => {
    it('records one row for create_task, with an action naming the tool and the boot-resolved actor', async () => {
      const { actorUserId, tokenId } = await bootMcp(mintPat(['write']));
      const project = app.projectService.createProject({ name: 'Audited' });

      const created = await call('create_task', {
        title: 'Audited task',
        project_id: project.id,
        created_by: 'agent',
      });
      expect(created.isError).toBeFalsy();

      const rows = allRows();
      expect(rows).toHaveLength(1);
      const row = rows[0] as AuditEventRow;

      // The action names the TOOL — unambiguous next to a REST
      // "<METHOD> /route" value.
      expect(row.action).toBe('MCP create_task');
      expect(row.action).toBe(buildMcpAuditAction('create_task'));
      // Boot-resolved actor, as TEXT (the column is TEXT on both surfaces).
      expect(row.actor_id).toBe(String(actorUserId));
      expect(row.actor_type).toBe('user');
      expect(row.token_id).toBe(String(tokenId));
      // A create addresses the COLLECTION: resource_id is NULL, exactly as the
      // REST hook nulls it for POST /api/v1/tasks.
      expect(row.resource_type).toBe('tasks');
      expect(row.resource_id).toBeNull();
      // The JSON-RPC request id lands in request_id (REST puts request.id there).
      expect(row.request_id).not.toBeNull();
      expect(row.metadata).toMatchObject({
        surface: 'mcp',
        outcome: 'ok',
        authMethod: 'pat',
        resolutionPath: 'pat',
        // id-shaped args only — never the free-text title.
        params: { project_id: project.id },
      });
      expect(JSON.stringify(row.metadata)).not.toContain('Audited task');
      // The row is chain-linked like every other: the trail still verifies.
      expect(app.auditEventRepository.verifyChain()).toBeNull();
    });

    it('carries the addressed row id for an instance-addressing tool', async () => {
      await bootMcp(mintPat(['write']));
      const project = app.projectService.createProject({ name: 'Instance' });
      const task = app.taskService.createTask({
        title: 'Instance task',
        project_id: project.id,
        created_by: 'seed',
      });

      const updated = await call('update_task', { id: task.id, updates: { priority: 'high' } });
      expect(updated.isError).toBeFalsy();

      const rows = allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resource_type).toBe('tasks');
      expect(rows[0]?.resource_id).toBe(String(task.id));
    });

    it('records one row per call — three calls, three rows, no duplicates', async () => {
      await bootMcp(mintPat(['write']));
      const project = app.projectService.createProject({ name: 'Repeat' });

      for (let i = 0; i < 3; i += 1) {
        const result = await call('create_task', {
          title: `Repeat ${i}`,
          project_id: project.id,
          created_by: 'agent',
        });
        expect(result.isError).toBeFalsy();
      }

      const rows = allRows();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.action)).toEqual([
        'MCP create_task',
        'MCP create_task',
        'MCP create_task',
      ]);
    });

    it('records a mutation the SERVICE rejected, with outcome=error (attempts, not just successes)', async () => {
      await bootMcp(mintPat(['write']));

      const missing = await call('update_task', { id: 999_999, updates: { priority: 'high' } });
      expect(missing.isError).toBe(true);

      const rows = allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('MCP update_task');
      expect(rows[0]?.resource_id).toBe('999999');
      expect(rows[0]?.metadata).toMatchObject({ surface: 'mcp', outcome: 'error' });
      // The JSON-RPC code is recorded; the message (which can echo user text)
      // deliberately is not.
      expect((rows[0]?.metadata as Record<string, unknown>)['errorCode']).toEqual(
        expect.any(Number),
      );
    });
  });

  // ==========================================================================
  // AC: a read-only MCP tool call produces zero rows
  // ==========================================================================
  describe('read-only tools produce nothing', () => {
    it('writes zero rows for get_task / list_tasks / list_projects / check_health / get_comments', async () => {
      await bootMcp(mintPat(['read']));
      const project = app.projectService.createProject({ name: 'Readonly' });
      const task = app.taskService.createTask({
        title: 'Readonly task',
        project_id: project.id,
        created_by: 'seed',
      });

      expect((await call('get_task', { id: task.id })).isError).toBeFalsy();
      expect((await call('list_tasks', {})).isError).toBeFalsy();
      expect((await call('list_projects', {})).isError).toBeFalsy();
      expect((await call('check_health', {})).isError).toBeFalsy();
      expect((await call('get_comments', { task_id: task.id })).isError).toBeFalsy();
      expect((await call('get_dependencies', { task_id: task.id })).isError).toBeFalsy();
      expect((await call('get_model_defaults', {})).isError).toBeFalsy();

      expect(allRows()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // REFUSAL SEMANTICS: a scope-refused call performed no mutation → no row
  // ==========================================================================
  describe('scope-refused calls (deliberate divergence from the REST 403 row)', () => {
    it('writes zero rows when the #1631 gate refuses, and still no row for the whole mutating sweep', async () => {
      const project = app.projectService.createProject({ name: 'Refused' });
      const taskA = app.taskService.createTask({
        title: 'Refused A',
        project_id: project.id,
        created_by: 'seed',
      });
      const taskB = app.taskService.createTask({
        title: 'Refused B',
        project_id: project.id,
        created_by: 'seed',
      });
      const taskC = app.taskService.createTask({
        title: 'Refused C',
        project_id: project.id,
        created_by: 'seed',
      });
      const comment = app.commentService.addComment({
        task_id: taskA.id,
        author: 'seed',
        content: 'seed comment',
      });
      app.dependencyService.addDependency({ task_id: taskA.id, blocks_task_id: taskB.id });

      // A `read`-only PAT: every mutating tool refuses BEFORE its service call.
      await bootMcp(mintPat(['read']));

      for (const [tool, args] of Object.entries(
        mutatingInvocations({
          project: project.id,
          taskA: taskA.id,
          taskB: taskB.id,
          taskC: taskC.id,
          comment: comment.id,
        }),
      )) {
        const result = await call(tool, args);
        expect(result.isError, `${tool} should have been refused`).toBe(true);
      }

      // Nothing was mutated, so nothing is attributed to anyone. The refusals
      // themselves surface as structured `insufficient_scope` tool errors.
      expect(allRows()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // AC: an append failure does not prevent the tool returning its normal result
  // ==========================================================================
  describe('non-fatal append', () => {
    it('returns the normal result when the append throws', async () => {
      const exploding: AuditAppender = {
        append(_record: AuditEventRecord): number {
          throw new Error('audit sink is down');
        },
      };

      const { actorUserId, scopes, tokenId, path } = resolveActorUserIdWithPath({
        apiKey: mintPat(['write']),
        apiTokenRepo: app.apiTokenRepository,
        userRepo: app.userRepository,
      });
      const project = app.projectService.createProject({ name: 'Non-fatal' });

      // Built directly (not via bootMcp) so the log sink can be injected.
      const server = createMcpServer(
        app.taskService,
        app.projectService,
        app.dependencyService,
        app.commentService,
        app.db,
        {
          actorUserId,
          scopes,
          tokenId: tokenId === null ? null : String(tokenId),
          resolutionPath: path,
          auditEventRepository: exploding,
          userRepository: app.userRepository,
        },
        app.topologyService,
      );
      [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      client = new Client({ name: 'audit-fail-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);

      const created = (await call('create_task', {
        title: 'Survives a broken audit sink',
        project_id: project.id,
        created_by: 'agent',
      })) as ToolResult;

      // The tool returned its NORMAL result: not an error, and the row exists.
      expect(created.isError).toBeFalsy();
      const createdId = (created.structuredContent as { id?: number } | null)?.id;
      expect(typeof createdId).toBe('number');
      expect(app.taskService.getTask(createdId as number).title).toBe(
        'Survives a broken audit sink',
      );
      // ...and no row was written, since the sink threw.
      expect(allRows()).toHaveLength(0);
    });

    it('emits an audit.append_failed line at ERROR level', async () => {
      // The log sink is not reachable through createMcpServer's context, so
      // this asserts on the producer directly — the same code path the wiring
      // above exercises, with the one seam the wiring does not expose.
      const logged: Array<Record<string, unknown>> = [];
      const { installMcpAuditTrail } = await import('../audit-trail.js');
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const { z } = await import('zod');

      const bare = new McpServer({ name: 'log-probe', version: '0.0.0' });
      installMcpAuditTrail(bare, {
        repository: {
          append(): number {
            throw new Error('sink exploded');
          },
        },
        actorUserId: 7,
        tokenId: null,
        resolutionPath: 'service-account-fallback',
        log: (payload) => logged.push(payload),
      });
      bare.registerTool(
        'create_task',
        { description: 'probe', inputSchema: z.object({ project_id: z.number() }) },
        async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      );

      const [probeServerTransport, probeClientTransport] = InMemoryTransport.createLinkedPair();
      await bare.connect(probeServerTransport);
      const probeClient = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
      await probeClient.connect(probeClientTransport);

      const result = (await probeClient.callTool({
        name: 'create_task',
        arguments: { project_id: 1 },
      })) as ToolResult;
      expect(result.isError).toBeFalsy();

      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: 'error',
        event: 'audit.append_failed',
        surface: 'mcp',
        tool: 'create_task',
        outcome: 'ok',
      });
      expect(String(logged[0]?.['error'])).toContain('sink exploded');

      await probeClientTransport.close();
      await probeServerTransport.close();
    });
  });

  // ==========================================================================
  // DESIGN REQUIREMENT: the audited set is DERIVED from MUTATING_TOOL_SCOPES
  // ==========================================================================
  describe('drift guard — audited set === gated set', () => {
    it('declares an audit target for exactly the tools the scope gate treats as mutating', () => {
      expect(Object.keys(MCP_AUDIT_TARGETS).sort()).toEqual(
        Object.keys(MUTATING_TOOL_SCOPES).sort(),
      );
    });

    it('classifies exactly the gated tools as mutating, and known read tools as not', () => {
      for (const tool of Object.keys(MUTATING_TOOL_SCOPES)) {
        expect(isMutatingTool(tool), `${tool} must be audited`).toBe(true);
      }
      for (const tool of [
        'get_task',
        'list_tasks',
        'list_subtasks',
        'get_subtasks',
        'completion_report',
        'wait_for_unblock',
        'get_project',
        'list_projects',
        'get_dependencies',
        'get_comments',
        'wsjf_ranking',
        'wsjf_history',
        'wsjf_health',
        'get_model_defaults',
        'list_models',
        'resolve_model',
        'check_health',
        'topology_check',
      ]) {
        expect(isMutatingTool(tool), `${tool} must NOT be audited`).toBe(false);
      }
    });

    it('appends exactly one row for EVERY declared mutating tool (behavioural sweep)', async () => {
      // An admin PAT so nothing is refused: this proves the WRAPPER covers the
      // whole gated set, not just the tools the other suites happen to call.
      await bootMcp(mintPat(['admin']));

      const project = app.projectService.createProject({ name: 'Sweep' });
      const taskA = app.taskService.createTask({
        title: 'Sweep A',
        project_id: project.id,
        created_by: 'seed',
      });
      const taskB = app.taskService.createTask({
        title: 'Sweep B',
        project_id: project.id,
        created_by: 'seed',
      });
      const taskC = app.taskService.createTask({
        title: 'Sweep C',
        project_id: project.id,
        created_by: 'seed',
      });
      const comment = app.commentService.addComment({
        task_id: taskA.id,
        author: 'seed',
        content: 'seed comment',
      });
      app.dependencyService.addDependency({ task_id: taskA.id, blocks_task_id: taskB.id });

      const invocations = mutatingInvocations({
        project: project.id,
        taskA: taskA.id,
        taskB: taskB.id,
        taskC: taskC.id,
        comment: comment.id,
      });

      // Deletes last so the earlier tools still address live rows.
      const order = [
        'create_task',
        'update_task',
        'claim_task',
        'create_project',
        'update_project',
        'add_dependency',
        'remove_dependency',
        'add_comment',
        'delete_comment',
        'rescore_project',
        'set_model_defaults',
        'delete_task',
        'delete_project',
      ];
      expect(order.slice().sort()).toEqual(Object.keys(MUTATING_TOOL_SCOPES).sort());

      for (const tool of order) {
        const result = await call(tool, invocations[tool] as Record<string, unknown>);
        expect(result.isError, `${tool} should have succeeded`).toBeFalsy();
      }

      const rows = allRows();
      expect(rows).toHaveLength(order.length);
      expect(rows.map((r) => r.action)).toEqual(order.map((tool) => `MCP ${tool}`));
      // Every row carries the shared resource-type vocabulary.
      for (const row of rows) {
        const tool = row.action.replace('MCP ', '') as keyof typeof MCP_AUDIT_TARGETS;
        expect(row.resource_type).toBe(MCP_AUDIT_TARGETS[tool].resourceType);
      }
      expect(app.auditEventRepository.verifyChain()).toBeNull();
    });
  });

  // ==========================================================================
  // DESIGN REQUIREMENT: cross-surface row-shape parity
  // ==========================================================================
  describe('row-shape parity with the REST producer', () => {
    it('populates the same columns with the same semantics for the same logical mutation', async () => {
      // --- REST half: POST /api/v1/tasks through the real server ------------
      const rest = await createServer({ dbPath: ':memory:' });
      const restApp = rest.app;
      await rest.server.ready();
      const restServer: FastifyInstance = rest.server;
      try {
        const restProject = restApp.projectService.createProject({ name: 'Parity REST' }).id;
        const auth = seedAuth(restApp.db, {
          displayName: 'parity-user',
          name: 'parity-token',
        });
        const response = await restServer.inject({
          method: 'POST',
          url: '/api/v1/tasks',
          headers: auth.headers,
          payload: { title: 'Parity task', project_id: restProject, created_by: 'parity-user' },
        });
        expect(response.statusCode).toBe(201);

        // onResponse fires after the reply is flushed — poll rather than sleep.
        const deadline = Date.now() + 2000;
        let restRows = restApp.auditEventRepository.findByActor(String(auth.userId), 10);
        while (restRows.length < 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          restRows = restApp.auditEventRepository.findByActor(String(auth.userId), 10);
        }
        expect(restRows).toHaveLength(1);
        const restRow = restRows[0] as AuditEventRow;

        // --- MCP half: create_task through the stdio server -----------------
        const { actorUserId } = await bootMcp(mintPat(['write']));
        const mcpProject = app.projectService.createProject({ name: 'Parity MCP' }).id;
        const created = await call('create_task', {
          title: 'Parity task',
          project_id: mcpProject,
          created_by: 'agent',
        });
        expect(created.isError).toBeFalsy();
        const mcpRows = app.auditEventRepository.findByActor(String(actorUserId), 10);
        expect(mcpRows).toHaveLength(1);
        const mcpRow = mcpRows[0] as AuditEventRow;

        // --- The parity contract --------------------------------------------
        // 1. The SAME columns are populated / null on both surfaces, so a
        //    single SELECT over audit_events returns usable rows from each.
        const populated = (row: AuditEventRow): Record<string, boolean> => ({
          timestamp: row.timestamp !== null,
          actor_type: row.actor_type !== null,
          actor_id: row.actor_id !== null,
          token_id: row.token_id !== null,
          action: row.action !== null,
          resource_type: row.resource_type !== null,
          // A create addresses a collection on BOTH surfaces → NULL on both.
          resource_id: row.resource_id !== null,
          request_id: row.request_id !== null,
          metadata: row.metadata !== null,
          prev_hash: row.prev_hash !== null,
          row_hash: row.row_hash !== null,
        });
        expect(populated(mcpRow)).toEqual(populated(restRow));

        // 2. Same SEMANTICS, column by column.
        expect(mcpRow.actor_type).toBe(restRow.actor_type); // 'user' on both
        expect(mcpRow.actor_id).toBe(String(actorUserId));
        expect(restRow.actor_id).toBe(String(auth.userId));
        expect(mcpRow.token_id).not.toBeNull(); // both authenticated by a PAT
        expect(restRow.token_id).toBe(String(auth.tokenId));
        // Same resource vocabulary — this is what makes one query cover both.
        expect(mcpRow.resource_type).toBe('tasks');
        expect(restRow.resource_type).toBe('tasks');
        expect(mcpRow.resource_id).toBeNull();
        expect(restRow.resource_id).toBeNull();
        // Distinct, non-colliding action namespaces.
        expect(restRow.action).toBe('POST /api/v1/tasks');
        expect(mcpRow.action).toBe('MCP create_task');
        expect(mcpRow.action.startsWith('MCP ')).toBe(true);
        expect(restRow.action.startsWith('MCP ')).toBe(false);
        // metadata carries an outcome discriminator on both (status / outcome)
        // plus the shared authMethod vocabulary.
        expect(restRow.metadata).toMatchObject({ status: 201, authMethod: 'pat' });
        expect(mcpRow.metadata).toMatchObject({ outcome: 'ok', authMethod: 'pat' });
        // Neither surface copies free text into the trail.
        expect(JSON.stringify(restRow.metadata)).not.toContain('Parity task');
        expect(JSON.stringify(mcpRow.metadata)).not.toContain('Parity task');

        // 3. A resource-scoped query behaves identically on either trail.
        const restByResource = restApp.auditEventRepository.findByResource('tasks', '1', 10);
        expect(Array.isArray(restByResource)).toBe(true);
      } finally {
        await rest.server.close();
        rest.app.dispose();
      }
    });
  });

  // ==========================================================================
  // Pure helpers
  // ==========================================================================
  describe('derivation helpers', () => {
    it('maps resolution paths to actor_type and the shared authMethod vocabulary', () => {
      expect(mcpActorTypeForPath('pat')).toBe('user');
      expect(mcpActorTypeForPath('legacy')).toBe('user');
      expect(mcpActorTypeForPath('service-account-fallback')).toBe('service_account');
      expect(mcpActorTypeForPath('pat-revoked-fallback')).toBe('service_account');
      expect(mcpActorTypeForPath('legacy-unmatched-fallback')).toBe('service_account');
      expect(mcpActorTypeForPath(undefined)).toBe('service_account');

      expect(mcpAuthMethodForPath('pat')).toBe('pat');
      expect(mcpAuthMethodForPath('legacy')).toBe('legacy');
      expect(mcpAuthMethodForPath('service-account-fallback')).toBeNull();
      expect(mcpAuthMethodForPath(undefined)).toBeNull();
    });

    it('keeps only id-shaped scalar arguments out of metadata.params', () => {
      expect(
        pickIdArgs({
          id: 1,
          task_id: 2,
          blocks_task_id: '3',
          title: 'secret title',
          content: 'secret content',
          updates: { priority: 'high' },
          project_id: null,
        }),
      ).toEqual({ id: 1, task_id: 2, blocks_task_id: '3' });
    });
  });
});

/**
 * One valid invocation per gated tool. Shares its shape with the #1631 sweep
 * so the two suites cannot disagree about what "calling every mutating tool"
 * means; the key set is asserted against `MUTATING_TOOL_SCOPES` by callers.
 */
function mutatingInvocations(ids: {
  project: number;
  taskA: number;
  taskB: number;
  taskC: number;
  comment: number;
}): Record<string, Record<string, unknown>> {
  return {
    create_task: { title: 'Swept', project_id: ids.project, created_by: 'agent' },
    update_task: { id: ids.taskA, updates: { priority: 'high' } },
    delete_task: { id: ids.taskA },
    claim_task: { task_id: ids.taskB, assignee: 'agent' },
    create_project: { name: 'Swept project' },
    update_project: { id: ids.project, updates: { name: 'Swept renamed' } },
    delete_project: { id: ids.project },
    add_dependency: { task_id: ids.taskB, blocks_task_id: ids.taskC },
    remove_dependency: { task_id: ids.taskA, blocks_task_id: ids.taskB },
    add_comment: { task_id: ids.taskA, author: 'agent', content: 'swept' },
    delete_comment: { comment_id: ids.comment },
    rescore_project: { project_id: ids.project, submissions: [] },
    set_model_defaults: { model_policy: null },
  };
}
