/**
 * Configurable Task Models Task 11 (#920) — model-tools server-wiring test.
 *
 * Asserts the registration GATE in `createMcpServer`: when the three model
 * services (catalog, policy resolver, settings) are provided, all four model
 * tools (`list_models`, `resolve_model`, `get_model_defaults`,
 * `set_model_defaults`) appear in `listTools`; when they are omitted, NONE of
 * them are present. Mirrors the InMemoryTransport spin-up used by
 * topology-tools.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, type App } from '../../index.js';
import { createMcpServer } from '../server.js';
import { createModelPolicyService } from '../../services/model-policy.service.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const MODEL_TOOL_NAMES = [
  'list_models',
  'resolve_model',
  'get_model_defaults',
  'set_model_defaults',
] as const;

async function listToolNames(app: App, withModelServices: boolean): Promise<string[]> {
  const modelPolicyService = createModelPolicyService({
    getProject: () => ({ model_policy: null }),
    getGlobalPolicy: () => null,
    getTask: () => null,
  });
  const server = withModelServices
    ? createMcpServer(
        app.taskService,
        app.projectService,
        app.dependencyService,
        app.commentService,
        app.db,
        undefined,
        app.topologyService,
        app.modelCatalogService,
        modelPolicyService,
        app.settingsService,
      )
    : createMcpServer(
        app.taskService,
        app.projectService,
        app.dependencyService,
        app.commentService,
        app.db,
        undefined,
        app.topologyService,
      );

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'model-tools-wiring-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  await clientTransport.close();
  await serverTransport.close();
  return names;
}

describe('createMcpServer model-tools registration gate (#920)', () => {
  let app: App;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.dispose();
  });

  it('registers all four model tools when the three services are provided', async () => {
    const names = await listToolNames(app, true);
    for (const tool of MODEL_TOOL_NAMES) {
      expect(names).toContain(tool);
    }
  });

  it('registers none of the model tools when the services are omitted', async () => {
    const names = await listToolNames(app, false);
    for (const tool of MODEL_TOOL_NAMES) {
      expect(names).not.toContain(tool);
    }
  });
});
