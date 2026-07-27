/**
 * Tests for the stdio MCP per-tool PAT scope gate (Security Audit finding M1
 * — task #1631).
 *
 * ## What is being proven
 *
 * Before #1631 the stdio MCP surface was a COMPLETE authorization bypass: it
 * resolves its actor once at boot from `WFT_API_KEY` and then calls
 * `taskService.createTask` / `deleteTask` / ... directly, never traversing the
 * Fastify auth chain where scope enforcement (#1620/#1621) lives. A token
 * minted with only the `read` scope, exported as `WFT_API_KEY`, could mutate
 * every task in the database.
 *
 * These tests drive the REAL boot path end-to-end:
 *
 *   1. mint a PAT row with a chosen scope set (via `app.apiTokenRepository`,
 *      the same repository the mint endpoint uses),
 *   2. feed the raw token to `resolveActorUserIdWithPath` exactly as
 *      `src/mcp/index.ts` feeds it `process.env.WFT_API_KEY`,
 *   3. build the MCP server with the resolved `{ actorUserId, scopes }`
 *      context,
 *   4. call tools over an in-memory JSON-RPC transport and assert both the
 *      protocol-level outcome AND the database side effect (or absence of one).
 *
 * Asserting "no row was written" is the load-bearing half — a gate that
 * returns an error AFTER performing the mutation would still be a bypass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestApp } from '../../index.js';
import type { App } from '../../index.js';
import { createMcpServer } from '../server.js';
import { resolveActorUserIdWithPath, parseGrantedScopes } from '../identity-resolution.js';
import { MUTATING_TOOL_SCOPES, enforceToolScope } from '../scope-gate.js';
import { generateToken } from '../../services/pat-hash.js';
import type { PatScope } from '../../schemas/pat-scope.schema.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown> | null;
  isError?: boolean;
}

/** Concatenated text of a tool result — where the McpError message surfaces. */
function resultText(result: ToolResult): string {
  return (result.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
}

/** Assert a tool call was refused by the scope gate specifically. */
function expectInsufficientScope(result: ToolResult, tool: string): void {
  expect(result.isError, `${tool} should have been refused`).toBe(true);
  expect(resultText(result)).toContain('insufficient_scope');
}

describe('stdio MCP per-tool scope enforcement (#1631)', () => {
  let app: App;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let ownerUserId: number;

  beforeEach(async () => {
    app = await createTestApp();
    const owner = app.db
      .prepare(`INSERT INTO users (display_name, email) VALUES (?, ?) RETURNING id`)
      .get('pat-owner', 'pat-owner@example.com') as { id: number };
    ownerUserId = owner.id;
  });

  afterEach(async () => {
    if (clientTransport) await clientTransport.close();
    if (serverTransport) await serverTransport.close();
    app.dispose();
  });

  /**
   * Mint a real `api_tokens` row for `ownerUserId` with the given grant and
   * return the raw token string (the value an operator would export as
   * `WFT_API_KEY`).
   */
  function mintPat(scopes: PatScope[]): string {
    const { token, prefix, suffix, hash } = generateToken();
    app.apiTokenRepository.insert({
      userId: ownerUserId,
      name: `test-${scopes.join('-') || 'legacy'}`,
      prefix,
      suffix,
      hash,
      scopes: JSON.stringify(scopes),
    });
    return token;
  }

  /**
   * Boot an MCP server the way `src/mcp/index.ts` does: resolve the actor
   * identity FROM THE TOKEN, then pass the resolved `{actorUserId, scopes}`
   * into `createMcpServer`. Returns the resolved grant so tests can assert on
   * it directly.
   */
  async function bootMcp(apiKey: string | undefined): Promise<{ scopes: PatScope[] | null }> {
    const { actorUserId, scopes } = resolveActorUserIdWithPath({
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
      { actorUserId, scopes, userRepository: app.userRepository },
      app.topologyService,
      app.modelCatalogService,
      app.modelPolicyService,
      app.settingsService,
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'scope-gate-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    return { scopes };
  }

  function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  }

  function countTasks(): number {
    return (app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  }

  // ==========================================================================
  // AC: boot identity resolution returns the granted scopes for a PAT actor
  // ==========================================================================
  describe('identity resolution carries the PAT grant', () => {
    it('returns the token scopes alongside the actor user id on the pat path', () => {
      const token = mintPat(['read']);
      const resolved = resolveActorUserIdWithPath({
        apiKey: token,
        apiTokenRepo: app.apiTokenRepository,
        userRepo: app.userRepository,
      });
      expect(resolved.actorUserId).toBe(ownerUserId);
      expect(resolved.path).toBe('pat');
      expect(resolved.scopes).toEqual(['read']);
    });

    it('returns scopes:null for the mcp-bot fallback (no WFT_API_KEY)', () => {
      const resolved = resolveActorUserIdWithPath({
        apiKey: undefined,
        apiTokenRepo: app.apiTokenRepository,
        userRepo: app.userRepository,
      });
      expect(resolved.path).toBe('service-account-fallback');
      expect(resolved.scopes).toBeNull();
    });

    it('parses a multi-tier grant and drops unrecognised entries', () => {
      expect(parseGrantedScopes('["read","write"]')).toEqual(['read', 'write']);
      expect(parseGrantedScopes('["read","bogus"]')).toEqual(['read']);
      expect(parseGrantedScopes('not json')).toEqual([]);
      expect(parseGrantedScopes('{"read":true}')).toEqual([]);
    });
  });

  // ==========================================================================
  // AC: a read-scoped PAT cannot create a task and writes no row
  // ==========================================================================
  describe('read-scoped PAT exported as WFT_API_KEY', () => {
    it('fails create_task with an authorization error and writes NO row', async () => {
      const token = mintPat(['read']);
      const { scopes } = await bootMcp(token);
      expect(scopes).toEqual(['read']);

      const project = app.projectService.createProject({ name: 'Gated Project' });
      const before = countTasks();

      const result = await call('create_task', {
        title: 'Should never exist',
        project_id: project.id,
        created_by: 'attacker',
      });

      expectInsufficientScope(result, 'create_task');
      expect(resultText(result)).toContain("requires the 'write' scope");

      // The load-bearing assertion: the mutation did not happen.
      expect(countTasks()).toBe(before);
      const leaked = app.db
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE title = ?')
        .get('Should never exist') as { n: number };
      expect(leaked.n).toBe(0);
    });

    it('still allows read-only tools (they are deliberately ungated)', async () => {
      const project = app.projectService.createProject({ name: 'Readable' });
      const task = app.taskService.createTask({
        title: 'Readable task',
        project_id: project.id,
        created_by: 'seed',
      });
      await bootMcp(mintPat(['read']));

      const got = await call('get_task', { id: task.id });
      expect(got.isError).toBeFalsy();

      const listed = await call('list_tasks', {});
      expect(listed.isError).toBeFalsy();

      const projects = await call('list_projects', {});
      expect(projects.isError).toBeFalsy();

      const health = await call('check_health', {});
      expect(health.isError).toBeFalsy();
    });

    it('refuses EVERY declared mutating tool (exhaustive sweep)', async () => {
      // Seed the entities the mutating tools address, using the services
      // directly so the seeding itself is not subject to the gate.
      const project = app.projectService.createProject({ name: 'Sweep Project' });
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
      const comment = app.commentService.addComment({
        task_id: taskA.id,
        author: 'seed',
        content: 'seed comment',
      });
      app.dependencyService.addDependency({ task_id: taskA.id, blocks_task_id: taskB.id });

      await bootMcp(mintPat(['read']));

      const invocations: Record<keyof typeof MUTATING_TOOL_SCOPES, Record<string, unknown>> = {
        create_task: { title: 'nope', project_id: project.id, created_by: 'attacker' },
        update_task: { id: taskA.id, updates: { priority: 'high' } },
        delete_task: { id: taskA.id },
        claim_task: { task_id: taskB.id, assignee: 'attacker' },
        create_project: { name: 'nope' },
        update_project: { id: project.id, updates: { name: 'renamed' } },
        delete_project: { id: project.id },
        add_dependency: { task_id: taskB.id, blocks_task_id: taskA.id },
        remove_dependency: { task_id: taskA.id, blocks_task_id: taskB.id },
        add_comment: { task_id: taskA.id, author: 'attacker', content: 'nope' },
        delete_comment: { comment_id: comment.id },
        rescore_project: { project_id: project.id, submissions: [] },
        set_model_defaults: { model_policy: null },
      };

      // Guard against the map and this table drifting apart: a newly gated
      // tool with no invocation here would otherwise silently go untested.
      expect(Object.keys(invocations).sort()).toEqual(Object.keys(MUTATING_TOOL_SCOPES).sort());

      for (const [tool, args] of Object.entries(invocations)) {
        const result = await call(tool, args);
        expectInsufficientScope(result, tool);
      }

      // Nothing changed: same task/comment/dependency/project counts, and the
      // names/priorities the sweep tried to alter are untouched.
      const counts = app.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM tasks) AS tasks,
             (SELECT COUNT(*) FROM projects) AS projects,
             (SELECT COUNT(*) FROM task_comments) AS comments,
             (SELECT COUNT(*) FROM task_dependencies) AS deps`,
        )
        .get() as { tasks: number; projects: number; comments: number; deps: number };
      expect(counts).toEqual({ tasks: 2, projects: 1, comments: 1, deps: 1 });
      expect(app.projectService.getProject(project.id).name).toBe('Sweep Project');
      expect(app.taskService.getTask(taskA.id).priority).toBe(taskA.priority);
      expect(app.taskService.getTask(taskB.id).assignee).toBeNull();
    });
  });

  // ==========================================================================
  // AC: a write-scoped PAT succeeds on create_task, fails on a delete-tier tool
  // ==========================================================================
  describe('write-scoped PAT', () => {
    it('succeeds on create_task and is refused by the admin-tier delete_task', async () => {
      const { scopes } = await bootMcp(mintPat(['write']));
      expect(scopes).toEqual(['write']);

      const project = app.projectService.createProject({ name: 'Writable' });

      const created = await call('create_task', {
        title: 'Written by a write PAT',
        project_id: project.id,
        created_by: 'agent',
      });
      expect(created.isError).toBeFalsy();
      const createdId = (created.structuredContent as { id: number }).id;
      expect(createdId).toBeGreaterThan(0);

      // delete_task is declared at the 'admin' tier — 'write' must not satisfy it.
      const deleted = await call('delete_task', { id: createdId });
      expectInsufficientScope(deleted, 'delete_task');
      expect(resultText(deleted)).toContain("requires the 'admin' scope");

      // The row the write-scoped call legitimately created is still there.
      expect(app.taskService.getTask(createdId).title).toBe('Written by a write PAT');
    });

    it('is refused by the other admin-tier tools but allowed on write-tier ones', async () => {
      await bootMcp(mintPat(['write']));
      const project = app.projectService.createProject({ name: 'Mixed tiers' });
      const task = app.taskService.createTask({
        title: 'Mixed',
        project_id: project.id,
        created_by: 'seed',
      });

      // write tier → allowed
      const comment = await call('add_comment', {
        task_id: task.id,
        author: 'agent',
        content: 'allowed',
      });
      expect(comment.isError).toBeFalsy();
      const commentId = (comment.structuredContent as { comment: { id: number } }).comment.id;

      const updated = await call('update_task', { id: task.id, updates: { priority: 'high' } });
      expect(updated.isError).toBeFalsy();

      // admin tier → refused
      expectInsufficientScope(
        await call('delete_comment', { comment_id: commentId }),
        'delete_comment',
      );
      expectInsufficientScope(await call('delete_project', { id: project.id }), 'delete_project');
      expectInsufficientScope(
        await call('set_model_defaults', { model_policy: null }),
        'set_model_defaults',
      );

      // The admin-tier refusals performed no mutation.
      expect(app.commentService.getComments(task.id)).toHaveLength(1);
      expect(app.projectService.getProject(project.id).name).toBe('Mixed tiers');
    });
  });

  // ==========================================================================
  // AC: an admin-scoped PAT retains delete authority
  // ==========================================================================
  describe('admin-scoped PAT', () => {
    it('satisfies both write-tier and admin-tier tools', async () => {
      await bootMcp(mintPat(['admin']));
      const project = app.projectService.createProject({ name: 'Admin project' });

      const created = await call('create_task', {
        title: 'Admin created',
        project_id: project.id,
        created_by: 'admin',
      });
      expect(created.isError).toBeFalsy();
      const id = (created.structuredContent as { id: number }).id;

      const deleted = await call('delete_task', { id });
      expect(deleted.isError).toBeFalsy();
      expect(
        (app.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(id) as { n: number }).n,
      ).toBe(0);
    });
  });

  // ==========================================================================
  // AC: an EMPTY scope array retains full access (REST legacy rule)
  // ==========================================================================
  describe('legacy PAT with an empty scope array', () => {
    it('retains FULL access, matching the REST legacy rule', async () => {
      // Tokens minted before the #1620 taxonomy existed carry `scopes = '[]'`.
      // `grantSatisfiesScope` treats that as full-tier so this new gate never
      // silently breaks a pre-existing token — the same rule the REST gate
      // applies (src/api/plugins/auth/index.ts::enforceRequiredScope).
      const { scopes } = await bootMcp(mintPat([]));
      expect(scopes).toEqual([]);

      const project = app.projectService.createProject({ name: 'Legacy token project' });

      const created = await call('create_task', {
        title: 'Legacy token task',
        project_id: project.id,
        created_by: 'legacy',
      });
      expect(created.isError).toBeFalsy();
      const id = (created.structuredContent as { id: number }).id;

      // ...including the admin tier.
      const deleted = await call('delete_task', { id });
      expect(deleted.isError).toBeFalsy();

      const deletedProject = await call('delete_project', { id: project.id });
      expect(deletedProject.isError).toBeFalsy();
    });

    it('retains full access when no WFT_API_KEY is set at all (scopes === null)', async () => {
      const { scopes } = await bootMcp(undefined);
      expect(scopes).toBeNull();

      const project = app.projectService.createProject({ name: 'No-key project' });
      const created = await call('create_task', {
        title: 'No-key task',
        project_id: project.id,
        created_by: 'mcp-bot',
      });
      expect(created.isError).toBeFalsy();
    });
  });
});

// ============================================================================
// Unit-level coverage of the shared gate helper itself.
// ============================================================================
describe('enforceToolScope', () => {
  it('permits when the grant is at or above the declared tier', () => {
    expect(() => enforceToolScope(['write'], 'create_task')).not.toThrow();
    expect(() => enforceToolScope(['admin'], 'create_task')).not.toThrow();
    expect(() => enforceToolScope(['admin'], 'delete_task')).not.toThrow();
    expect(() => enforceToolScope(['read', 'admin'], 'delete_project')).not.toThrow();
  });

  it('permits for the two full-tier special cases owned by grantSatisfiesScope', () => {
    expect(() => enforceToolScope(null, 'delete_task')).not.toThrow();
    expect(() => enforceToolScope(undefined, 'delete_task')).not.toThrow();
    expect(() => enforceToolScope([], 'delete_task')).not.toThrow();
  });

  it('refuses when the grant is below the declared tier', () => {
    expect(() => enforceToolScope(['read'], 'create_task')).toThrow(/insufficient_scope/);
    expect(() => enforceToolScope(['write'], 'delete_task')).toThrow(/insufficient_scope/);
  });

  it('attaches a structured data payload naming the tool and the required tier', () => {
    try {
      enforceToolScope(['read'], 'delete_comment');
      expect.unreachable('enforceToolScope should have thrown');
    } catch (err) {
      const data = (err as { data?: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        error: 'insufficient_scope',
        tool: 'delete_comment',
        requiredScope: 'admin',
        grantedScopes: ['read'],
      });
    }
  });

  it('declares only the taxonomy tiers for every gated tool', () => {
    for (const [tool, tier] of Object.entries(MUTATING_TOOL_SCOPES)) {
      expect(['read', 'write', 'admin'], `${tool} tier`).toContain(tier);
    }
    // Read-only tools must NOT appear in the map.
    for (const readOnly of [
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
      'check_health',
      'topology_check',
      'wsjf_ranking',
      'wsjf_history',
      'wsjf_health',
      'list_models',
      'resolve_model',
      'get_model_defaults',
    ]) {
      expect(Object.keys(MUTATING_TOOL_SCOPES)).not.toContain(readOnly);
    }
  });
});
