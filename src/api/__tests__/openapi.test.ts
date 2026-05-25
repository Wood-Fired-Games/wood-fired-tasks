import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type { App } from '../../index.js';

// Configure API keys for tests
process.env.API_KEYS = 'test-key';

describe('OpenAPI Documentation', () => {
  let server: FastifyInstance;
  let app: App;

  beforeEach(async () => {
    // Create server with in-memory database
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    // Ensure OpenAPI spec is generated
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    app.db.close();
  });

  it('GET /docs returns 200 (Swagger UI is served)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('swagger'); // Should contain swagger UI HTML
  });

  it('GET /docs/json returns 200 with valid JSON containing openapi field', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const spec = JSON.parse(response.payload);
    expect(spec.openapi).toBeDefined();
    expect(spec.openapi).toMatch(/^3\.(0|1)\./); // OpenAPI 3.0.x or 3.1.x
  });

  it('The spec has info.title = Wood Fired Tasks API', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    expect(spec.info?.title).toBe('Wood Fired Tasks API');
  });

  it('The spec has paths for /api/v1/tasks (POST, GET)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    expect(spec.paths).toBeDefined();

    // Fastify/Swagger adds trailing slashes to paths
    const tasksPath = spec.paths['/api/v1/tasks/'] || spec.paths['/api/v1/tasks'];
    expect(tasksPath).toBeDefined();
    expect(tasksPath.post).toBeDefined();
    expect(tasksPath.get).toBeDefined();
  });

  it('The spec has paths for /api/v1/tasks/{id} (GET, PUT, DELETE)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    const taskByIdPath = spec.paths['/api/v1/tasks/{id}'];
    expect(taskByIdPath).toBeDefined();
    expect(taskByIdPath.get).toBeDefined();
    expect(taskByIdPath.put).toBeDefined();
    expect(taskByIdPath.delete).toBeDefined();
  });

  it('The spec has paths for /api/v1/projects (POST, GET)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    const projectsPath = spec.paths['/api/v1/projects/'] || spec.paths['/api/v1/projects'];
    expect(projectsPath).toBeDefined();
    expect(projectsPath.post).toBeDefined();
    expect(projectsPath.get).toBeDefined();
  });

  it('The spec has paths for /api/v1/projects/{id} (GET, PUT, DELETE)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    const projectByIdPath = spec.paths['/api/v1/projects/{id}'];
    expect(projectByIdPath).toBeDefined();
    expect(projectByIdPath.get).toBeDefined();
    expect(projectByIdPath.put).toBeDefined();
    expect(projectByIdPath.delete).toBeDefined();
  });

  it('The spec has paths for /health (GET)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    const healthPath = spec.paths['/health/'] || spec.paths['/health'];
    expect(healthPath).toBeDefined();
    expect(healthPath.get).toBeDefined();
  });

  it('The spec has securitySchemes.apiKey defined', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    expect(spec.components?.securitySchemes?.apiKey).toBeDefined();
    expect(spec.components.securitySchemes.apiKey.type).toBe('apiKey');
    expect(spec.components.securitySchemes.apiKey.name).toBe('X-API-Key');
    expect(spec.components.securitySchemes.apiKey.in).toBe('header');
  });

  // Phase 28 Plan 06 (PAT-04 surface documentation): the OpenAPI document
  // must publish BOTH the legacy apiKey scheme AND the new bearerAuth
  // (Authorization: Bearer wfb_pat_*) scheme. The chain plugin already
  // accepts either; the spec is the only client-facing surface that
  // describes it.
  it('The spec has securitySchemes.bearerAuth defined (Phase 28 PAT surface)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth.type).toBe('http');
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    // bearerFormat names the prefix so client tooling can validate
    expect(spec.components.securitySchemes.bearerAuth.bearerFormat).toContain(
      'wfb_pat_',
    );
    // Description points at the public prefix and the mint endpoint
    expect(spec.components.securitySchemes.bearerAuth.description).toContain(
      'wfb_pat_',
    );
  });

  it('The top-level security array contains BOTH apiKey and bearerAuth', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    expect(Array.isArray(spec.security)).toBe(true);
    const hasApiKey = (spec.security as Array<Record<string, unknown>>).some(
      (entry) => Object.prototype.hasOwnProperty.call(entry, 'apiKey'),
    );
    const hasBearer = (spec.security as Array<Record<string, unknown>>).some(
      (entry) => Object.prototype.hasOwnProperty.call(entry, 'bearerAuth'),
    );
    expect(hasApiKey).toBe(true);
    expect(hasBearer).toBe(true);
  });

  it('The spec documents request body schemas for POST /api/v1/tasks (has title in properties)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    });

    const spec = JSON.parse(response.payload);
    const tasksPath = spec.paths['/api/v1/tasks/'] || spec.paths['/api/v1/tasks'];
    const postTask = tasksPath.post;
    expect(postTask.requestBody).toBeDefined();

    // Navigate through OpenAPI schema structure
    const requestBodyContent = postTask.requestBody.content;
    expect(requestBodyContent).toBeDefined();

    const jsonContent = requestBodyContent['application/json'];
    expect(jsonContent).toBeDefined();

    const schema = jsonContent.schema;
    expect(schema).toBeDefined();

    // Check that title property exists (either in properties or allOf/oneOf/anyOf)
    const hasTitle =
      schema.properties?.title ||
      schema.allOf?.some((s: any) => s.properties?.title) ||
      schema.oneOf?.some((s: any) => s.properties?.title);

    expect(hasTitle).toBeTruthy();
  });
});
