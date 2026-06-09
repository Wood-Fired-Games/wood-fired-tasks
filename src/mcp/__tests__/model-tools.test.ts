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
import { z } from 'zod';
import { registerModelTools } from '../tools/model-tools.js';
import type { ModelCatalogService } from '../../services/model-catalog.service.js';
import type { ModelPolicyService, ResolvedModel } from '../../services/model-policy.service.js';

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

    it('surfaces the null ("inherit") sentinel verbatim', async () => {
      const { server, tools } = makeFakeServer();
      registerModelTools(server, {
        catalog: fakeCatalog({ models: [], stale: true }),
        modelPolicy: fakeModelPolicy(null),
      });

      const out = await callTool(tools, 'resolve_model', {
        project_id: 3,
        role: 'planning',
      });

      expect(out.structuredContent).toBeNull();
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
  });
});
