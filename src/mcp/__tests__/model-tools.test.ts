/**
 * Task 9 (project "Configurable Task Models") — `model-tools.ts` unit test.
 *
 * Unlike the topology-tools test, this exercises the tool handlers directly via
 * a lightweight fake `McpServer` that captures the `(name, config, handler)`
 * triples passed to `registerTool`. This is deliberate: `resolve_model` must be
 * able to return its resolver output VERBATIM, including the bare `null`
 * ("inherit the session model") sentinel — which the MCP wire schema for
 * `structuredContent` (an optional record) cannot round-trip through a real SDK
 * client. Driving the handler directly lets us assert on the raw return value.
 *
 * The catalog + model-policy services are injected as minimal fakes.
 */

import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { registerModelTools, registerModelDefaultsTools } from '../tools/model-tools.js';
import type { ModelCatalogService } from '../../services/model-catalog.service.js';
import { createModelPolicyService } from '../../services/model-policy.service.js';
import type { ModelPolicyService, ResolvedModel } from '../../services/model-policy.service.js';
import type { SettingsService } from '../../services/settings.service.js';
import type { ModelPolicy } from '../../schemas/model-policy.schema.js';

/** A registered tool, as captured from `registerTool`. */
interface CapturedTool {
  config: { description?: string; inputSchema?: z.ZodTypeAny };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Build a fake `McpServer` that records every `registerTool` call. Returns the
 * fake (typed as `McpServer` for `registerModelTools`) and the captured map.
 */
function makeFakeServer(): { server: McpServer; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const server = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodTypeAny },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (args: any) => Promise<ToolResult>,
    ) {
      tools.set(name, { config, handler });
      return {};
    },
  } as unknown as McpServer;
  return { server, tools };
}

/** Invoke a captured tool by validating `args` through its schema, then calling. */
async function callTool(
  tools: Map<string, CapturedTool>,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const parsed = tool.config.inputSchema ? tool.config.inputSchema.parse(args) : args;
  return tool.handler(parsed);
}

/** A catalog fake returning a fixed catalog payload. */
function fakeCatalog(catalog: { models: unknown[]; stale: boolean }): ModelCatalogService {
  return { list: async () => catalog } as unknown as ModelCatalogService;
}

/** A model-policy fake whose `resolveModel` returns a fixed value. */
function fakeModelPolicy(
  resolved: ResolvedModel,
  spy?: (projectId: number, role: string, taskId?: number) => void,
): ModelPolicyService {
  return {
    resolveModel: (projectId: number, role: string, taskId?: number) => {
      spy?.(projectId, role, taskId);
      return resolved;
    },
  } as unknown as ModelPolicyService;
}

/**
 * A settings fake backed by an in-memory cell. `getModelPolicyDefault` returns
 * whatever `setModelPolicyDefault` last stored; defaults to `null` (no policy).
 */
function fakeSettings(initial: ModelPolicy | null = null): SettingsService {
  let stored: ModelPolicy | null = initial;
  return {
    getModelPolicyDefault: () => stored,
    setModelPolicyDefault: (policy: ModelPolicy | null) => {
      stored = policy;
    },
  } as unknown as SettingsService;
}

describe('registerModelTools', () => {
  it('registers both list_models and resolve_model', () => {
    const { server, tools } = makeFakeServer();
    registerModelTools(server, {
      catalog: fakeCatalog({ models: [], stale: true }),
      modelPolicy: fakeModelPolicy(null),
    });
    expect([...tools.keys()].sort()).toEqual(['list_models', 'resolve_model']);
  });

  describe('list_models', () => {
    it('returns structuredContent { models[], stale } from catalog.list()', async () => {
      const models = [
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', family: 'opus', created_at: '' },
      ];
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models, stale: false }),
        modelPolicy: fakeModelPolicy(null),
      });

      const out = await callTool(tools, 'list_models', {});

      expect(out.structuredContent).toEqual({ models, stale: false });
      expect(out.content[0].type).toBe('text');
      expect(out.content[0].text).toBe('1 models');
    });

    it('flags a stale fallback catalog in the text summary', async () => {
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models: [], stale: true }),
        modelPolicy: fakeModelPolicy(null),
      });

      const out = await callTool(tools, 'list_models', {});

      expect(out.structuredContent).toEqual({ models: [], stale: true });
      expect(out.content[0].text).toBe('0 models (stale fallback)');
    });
  });

  describe('resolve_model', () => {
    it('returns the resolver output verbatim ({ model: "auto" })', async () => {
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models: [], stale: true }),
        modelPolicy: fakeModelPolicy({ model: 'auto' }),
      });

      const out = await callTool(tools, 'resolve_model', {
        project_id: 1,
        role: 'execution',
        task_id: 7,
      });

      expect(out.structuredContent).toEqual({ model: 'auto' });
      expect(out.content[0].text).toBe('auto');
    });

    it('returns a concrete model verbatim ({ model: id })', async () => {
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models: [], stale: true }),
        modelPolicy: fakeModelPolicy({ model: 'claude-sonnet-4-6' }),
      });

      const out = await callTool(tools, 'resolve_model', {
        project_id: 2,
        role: 'validation',
      });

      expect(out.structuredContent).toEqual({ model: 'claude-sonnet-4-6' });
      expect(out.content[0].text).toBe('claude-sonnet-4-6');
    });

    it('OMITS structuredContent for the null ("inherit") sentinel (wire schema only admits a record)', async () => {
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models: [], stale: true }),
        modelPolicy: fakeModelPolicy(null),
      });

      const out = await callTool(tools, 'resolve_model', {
        project_id: 3,
        role: 'planning',
      });

      // CallToolResultSchema types structuredContent as z.record(...).optional()
      // — a literal null fails client-side validation, so inherit = absent key.
      expect('structuredContent' in out).toBe(false);
      expect(out.content[0].text).toBe('inherit (session model)');
    });

    it('forwards project_id, role and task_id to resolveModel', async () => {
      const calls: Array<[number, string, number | undefined]> = [];
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models: [], stale: true }),
        modelPolicy: fakeModelPolicy({ model: 'auto' }, (p, r, t) => calls.push([p, r, t])),
      });

      await callTool(tools, 'resolve_model', { project_id: 42, role: 'execution', task_id: 9 });

      expect(calls).toEqual([[42, 'execution', 9]]);
    });

    it('rejects an unknown role at the input schema layer', async () => {
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models: [], stale: true }),
        modelPolicy: fakeModelPolicy(null),
      });

      await expect(
        callTool(tools, 'resolve_model', { project_id: 1, role: 'bogus' }),
      ).rejects.toThrow();
    });

    it('rejects a non-positive project_id at the input schema layer', async () => {
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models: [], stale: true }),
        modelPolicy: fakeModelPolicy(null),
      });

      await expect(
        callTool(tools, 'resolve_model', { project_id: 0, role: 'execution' }),
      ).rejects.toThrow();
    });

    /**
     * Task #928 — parity hardening. These use the REAL resolver (with fake
     * lookups) so the full path is exercised: service throws → handler's
     * convertToMcpError → McpError on the wire. Before #928 the stdio path
     * silently resolved a NONEXISTENT project against the global default
     * while REST 404'd — a per-transport behavior split.
     */
    describe('validation errors surface as MCP errors (task #928)', () => {
      /** The real service over a one-project/one-task fake world. */
      const realModelPolicy = () =>
        createModelPolicyService({
          getProject: (projectId) => (projectId === 1 ? { model_policy: null } : null),
          getGlobalPolicy: () => ({ execution: { default: 'glob-default' } }),
          // Task 7 exists and belongs to project 1; everything else is missing.
          getTask: (taskId) => (taskId === 7 ? { project_id: 1, wsjf_job_size: 8 } : null),
        });

      it('rejects a nonexistent project_id with an InvalidRequest McpError (not a silent global-default resolution)', async () => {
        const { server, tools } = makeFakeServer();
        registerModelTools(server, {
          catalog: fakeCatalog({ models: [], stale: true }),
          modelPolicy: realModelPolicy(),
        });

        const promise = callTool(tools, 'resolve_model', { project_id: 999, role: 'execution' });
        await expect(promise).rejects.toBeInstanceOf(McpError);
        await expect(promise).rejects.toMatchObject({
          code: ErrorCode.InvalidRequest,
          message: expect.stringContaining('Project with id 999 not found'),
        });
      });

      it('rejects a nonexistent task_id with an InvalidRequest McpError', async () => {
        const { server, tools } = makeFakeServer();
        registerModelTools(server, {
          catalog: fakeCatalog({ models: [], stale: true }),
          modelPolicy: realModelPolicy(),
        });

        const promise = callTool(tools, 'resolve_model', {
          project_id: 1,
          role: 'execution',
          task_id: 404404,
        });
        await expect(promise).rejects.toBeInstanceOf(McpError);
        await expect(promise).rejects.toMatchObject({
          code: ErrorCode.InvalidRequest,
          message: expect.stringContaining('Task with id 404404 not found'),
        });
      });

      it('rejects a task_id belonging to a different project with an InvalidParams McpError', async () => {
        const { server, tools } = makeFakeServer();
        registerModelTools(server, {
          catalog: fakeCatalog({ models: [], stale: true }),
          modelPolicy: createModelPolicyService({
            getProject: () => ({ model_policy: null }),
            getGlobalPolicy: () => ({ execution: { default: 'glob-default' } }),
            // Task 7 exists but lives in project 2, not the requested project 1.
            getTask: () => ({ project_id: 2, wsjf_job_size: 8 }),
          }),
        });

        const promise = callTool(tools, 'resolve_model', {
          project_id: 1,
          role: 'execution',
          task_id: 7,
        });
        await expect(promise).rejects.toBeInstanceOf(McpError);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      });

      it('still resolves the happy path through the real service (regression)', async () => {
        const { server, tools } = makeFakeServer();
        registerModelTools(server, {
          catalog: fakeCatalog({ models: [], stale: true }),
          modelPolicy: realModelPolicy(),
        });

        const out = await callTool(tools, 'resolve_model', {
          project_id: 1,
          role: 'execution',
          task_id: 7,
        });
        expect(out.structuredContent).toEqual({ model: 'glob-default' });
      });
    });
  });
});

describe('registerModelDefaultsTools', () => {
  it('registers both get_model_defaults and set_model_defaults', () => {
    const { server, tools } = makeFakeServer();
    registerModelDefaultsTools(server, { settings: fakeSettings() });
    expect([...tools.keys()].sort()).toEqual(['get_model_defaults', 'set_model_defaults']);
  });

  describe('get_model_defaults', () => {
    it('returns structuredContent { model_policy: null } when no default is set', async () => {
      const { server, tools } = makeFakeServer();
      registerModelDefaultsTools(server, { settings: fakeSettings(null) });

      const out = await callTool(tools, 'get_model_defaults', {});

      expect(out.structuredContent).toEqual({ model_policy: null });
      expect(out.content[0].type).toBe('text');
      expect(out.content[0].text).toBe('no default configured');
    });

    it('returns the configured default verbatim under model_policy', async () => {
      const policy: ModelPolicy = { planning: { constant: 'auto' } };
      const { server, tools } = makeFakeServer();
      registerModelDefaultsTools(server, { settings: fakeSettings(policy) });

      const out = await callTool(tools, 'get_model_defaults', {});

      expect(out.structuredContent).toEqual({ model_policy: policy });
      expect(out.content[0].text).toBe('default model policy set');
    });
  });

  describe('set_model_defaults', () => {
    it('set_model_defaults then get_model_defaults round-trips { model_policy }', async () => {
      const settings = fakeSettings();
      const { server, tools } = makeFakeServer();
      registerModelDefaultsTools(server, { settings });

      const policy = { planning: { constant: 'auto' } };
      const setOut = await callTool(tools, 'set_model_defaults', { model_policy: policy });
      expect(setOut.structuredContent).toEqual({ model_policy: policy });
      expect(setOut.content[0].text).toBe('default model policy updated');

      const getOut = await callTool(tools, 'get_model_defaults', {});
      expect(getOut.structuredContent).toEqual({ model_policy: policy });
    });

    it('clears the default with a null model_policy', async () => {
      const settings = fakeSettings({ execution: { default: 'auto' } });
      const { server, tools } = makeFakeServer();
      registerModelDefaultsTools(server, { settings });

      const setOut = await callTool(tools, 'set_model_defaults', { model_policy: null });
      expect(setOut.structuredContent).toEqual({ model_policy: null });
      expect(setOut.content[0].text).toBe('default model policy cleared');

      const getOut = await callTool(tools, 'get_model_defaults', {});
      expect(getOut.structuredContent).toEqual({ model_policy: null });
    });

    it('rejects an invalid model_policy at the input schema layer', async () => {
      const { server, tools } = makeFakeServer();
      registerModelDefaultsTools(server, { settings: fakeSettings() });

      await expect(
        callTool(tools, 'set_model_defaults', {
          model_policy: { execution: { byFib: {} } },
        }),
      ).rejects.toThrow();
    });
  });
});
