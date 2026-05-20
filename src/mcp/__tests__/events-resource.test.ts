import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';

describe('MCP Events Resource', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    // Set test API URL/key for predictable output.
    // The API_KEY is a canary value — task #196 ensures it never surfaces in
    // the events://stream markdown (MCP resources flow into LLM context).
    process.env.API_URL = 'http://localhost:3000/api/v1';
    process.env.API_KEY = 'audit-leak-canary-deadbeef';

    app = await createTestApp();

    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    delete process.env.API_URL;
    delete process.env.API_KEY;
    await clientTransport.close();
    await serverTransport.close();
    app.db.close();
  });

  describe('resource listing', () => {
    it('lists events://stream resource', async () => {
      const result = await client.listResources();
      const eventsResource = result.resources.find(
        (r) => r.uri === 'events://stream'
      );

      expect(eventsResource).toBeDefined();
      expect(eventsResource!.name).toBe('Event Stream');
      expect(eventsResource!.description).toContain('Server-Sent Events');
      expect(eventsResource!.mimeType).toBe('text/event-stream');
    });
  });

  describe('resource reading', () => {
    it('returns markdown documentation', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('events://stream');
      expect(result.contents[0].mimeType).toBe('text/markdown');
      expect('text' in result.contents[0]).toBe(true);
    });

    it('includes correct API URL in documentation', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain('http://localhost:3000/api/v1/events');
      expect(text).toContain('GET http://localhost:3000/api/v1/events');
    });

    it('uses a placeholder in the authentication section (no real key)', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      const text = (result.contents[0] as { text: string }).text;
      // Authentication section must use a placeholder, never the configured key.
      expect(text).toContain('X-API-Key: <your-api-key>');
      // Guide the reader to the env var they actually configured.
      expect(text).toContain('WFB_API_KEY');
    });

    it('does NOT leak the configured API key into resource content (task #196)', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      const text = (result.contents[0] as { text: string }).text;
      // The configured key is a recognizable canary; it must never surface
      // in MCP resource output (would leak into LLM context / prompt cache).
      expect(text).not.toContain('audit-leak-canary-deadbeef');
      expect(text).not.toContain(process.env.API_KEY!);
    });

    it('documents all event types', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      const text = (result.contents[0] as { text: string }).text;

      // Task events
      expect(text).toContain('task.created');
      expect(text).toContain('task.updated');
      expect(text).toContain('task.deleted');
      expect(text).toContain('task.claimed');
      expect(text).toContain('task.status_changed');

      // Project events
      expect(text).toContain('project.created');
      expect(text).toContain('project.updated');
      expect(text).toContain('project.deleted');

      // Heartbeat
      expect(text).toContain('ping');
    });

    it('documents filter parameters', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain('project_id');
      expect(text).toContain('event_types');
      expect(text).toContain('Filter events to specific project');
      expect(text).toContain('Comma-separated list of event types');
    });

    it('documents Last-Event-ID reconnection', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain('Last-Event-ID');
      expect(text).toContain('Reconnection');
      expect(text).toContain('replays missed events');
      expect(text).toContain('1000 events');
      expect(text).toContain('5-minute window');
    });

    it('includes curl example', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain('curl -N');
      // Curl example uses the same placeholder as the auth section.
      expect(text).toContain('X-API-Key: <your-api-key>');
    });

    it('documents event format with SSE structure', async () => {
      const result = await client.readResource({
        uri: 'events://stream',
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain('Event Format');
      expect(text).toContain('id: 123');
      expect(text).toContain('event: task.created');
      expect(text).toContain('data:');
      expect(text).toContain('"eventType"');
    });
  });
});
