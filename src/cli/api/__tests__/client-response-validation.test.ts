/**
 * Task #774 — CLI API client response trust-boundary tests.
 *
 * Proves the wiring: the task/project/list client functions now run the REST
 * response body through the shared Zod response schemas
 * (`src/schemas/api-response.ts`) instead of casting `response.json() as T`.
 * Valid bodies pass through untouched; invalid / missing-field bodies raise a
 * clear `ApiResponseValidationError` rather than leaking an untyped shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the spinner so calls don't try to render TTY UI.
vi.mock('../../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

// Stub env + auth so apiRequest authenticates without real credentials.
vi.mock('../../config/env.js', () => ({
  env: { API_BASE_URL: 'http://localhost:3000', API_KEY: 'test-key' },
}));
vi.mock('../../auth/credentials.js', () => ({
  resolveAuth: vi.fn(async () => ({ kind: 'legacy' as const, key: 'test-key' })),
}));

import { ApiResponseValidationError } from '../../../schemas/api-response.js';
import { getTask, listTasks, listTasksPaginated, getProject, listProjects } from '../client.js';

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(body: unknown, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, status));
}

function validTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    title: 't',
    description: null,
    status: 'open',
    priority: 'medium',
    project_id: 1,
    project_name: 'proj',
    parent_task_id: null,
    estimated_minutes: null,
    assignee: null,
    created_by: 'tester',
    due_date: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    version: 1,
    claimed_at: null,
    tags: [],
    acceptance_criteria: null,
    verification_evidence: null,
    ...overrides,
  };
}

function validProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: 'p',
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    value_charter: null,
    ...overrides,
  };
}

describe('CLI client response validation (task #774)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  // ── Task single-response ───────────────────────────────────────────────
  it('getTask returns a valid task body unchanged', async () => {
    mockFetch(validTask({ id: 5, title: 'real' }));
    const task = await getTask(5);
    expect(task.id).toBe(5);
    expect(task.title).toBe('real');
  });

  it('getTask throws ApiResponseValidationError on a missing required field', async () => {
    const bad = validTask();
    delete bad.status;
    mockFetch(bad);
    await expect(getTask(1)).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it('getTask throws on a wrong-typed field', async () => {
    mockFetch(validTask({ version: 'one' }));
    await expect(getTask(1)).rejects.toThrow(/version/);
  });

  // ── Task list ──────────────────────────────────────────────────────────
  it('listTasks validates and returns every row from an envelope', async () => {
    mockFetch({
      data: [validTask({ id: 1 }), validTask({ id: 2 })],
      total: 2,
      limit: 50,
      offset: 0,
    });
    const rows = await listTasks();
    expect(rows).toHaveLength(2);
  });

  it('listTasks accepts a bare-array (legacy) body', async () => {
    mockFetch([validTask({ id: 7 })]);
    const rows = await listTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(7);
  });

  it('listTasks throws when a row is malformed', async () => {
    mockFetch({ data: [validTask(), { id: 2 }], total: 2, limit: 50, offset: 0 });
    await expect(listTasks()).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it('listTasksPaginated throws on a non-list body instead of an empty page', async () => {
    // Old behavior silently returned { data: [], total: 0 }, hiding the fault.
    mockFetch({ unexpected: 'shape' });
    await expect(listTasksPaginated()).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  // ── Project single + list ──────────────────────────────────────────────
  it('getProject returns a valid project body unchanged', async () => {
    mockFetch(validProject({ id: 3, name: 'proj-3' }));
    const project = await getProject(3);
    expect(project.id).toBe(3);
    expect(project.name).toBe('proj-3');
  });

  it('getProject throws on a missing required field', async () => {
    const bad = validProject();
    delete bad.created_at;
    mockFetch(bad);
    await expect(getProject(1)).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it('listProjects validates each row', async () => {
    mockFetch({ data: [validProject({ id: 1 })], total: 1, limit: 50, offset: 0 });
    const rows = await listProjects();
    expect(rows).toHaveLength(1);
  });

  it('listProjects throws when a project row is malformed', async () => {
    mockFetch({ data: [{ id: 1, name: 'x' }], total: 1, limit: 50, offset: 0 });
    await expect(listProjects()).rejects.toBeInstanceOf(ApiResponseValidationError);
  });
});
