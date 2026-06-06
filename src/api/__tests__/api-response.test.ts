/**
 * Task #774 — REST/API response trust-boundary validators.
 *
 * Covers the shared `parseResponse` / `parsePaginatedResponse` helpers and the
 * task/project/list convenience wrappers, including invalid + missing-field
 * cases (the highest-risk response shapes the CLI and remote MCP proxy consume).
 */
import { describe, it, expect } from 'vitest';
import {
  ApiResponseValidationError,
  parseTaskResponse,
  parseProjectResponse,
  parseTaskListResponse,
  parseProjectListResponse,
} from '../api-response.js';

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

describe('parseTaskResponse', () => {
  it('accepts a fully-valid task body', () => {
    const task = validTask({ id: 42, title: 'hello' });
    const parsed = parseTaskResponse(task, 'GET /api/v1/tasks/42');
    expect(parsed.id).toBe(42);
    expect(parsed.title).toBe('hello');
  });

  it('throws ApiResponseValidationError on a missing required field', () => {
    const bad = validTask();
    delete bad.title;
    expect(() => parseTaskResponse(bad, 'GET /api/v1/tasks/1')).toThrow(ApiResponseValidationError);
  });

  it('error names the endpoint and the offending field', () => {
    const bad = validTask({ id: 'not-a-number' });
    try {
      parseTaskResponse(bad, 'GET /api/v1/tasks/1');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiResponseValidationError);
      const err = e as ApiResponseValidationError;
      expect(err.endpoint).toBe('GET /api/v1/tasks/1');
      expect(err.message).toMatch(/Invalid response from GET \/api\/v1\/tasks\/1/);
      expect(err.issues).toMatch(/id/);
    }
  });

  it('rejects an out-of-enum status', () => {
    const bad = validTask({ status: 'totally-not-a-status' });
    expect(() => parseTaskResponse(bad, 'GET /api/v1/tasks/1')).toThrow(/status/);
  });

  it('rejects a wholly non-object body (e.g. an HTML error page parsed loosely)', () => {
    expect(() => parseTaskResponse('not json', 'GET /api/v1/tasks/1')).toThrow(
      ApiResponseValidationError,
    );
    expect(() => parseTaskResponse(null, 'GET /api/v1/tasks/1')).toThrow(
      ApiResponseValidationError,
    );
  });
});

describe('parseProjectResponse', () => {
  it('accepts a valid project body', () => {
    const parsed = parseProjectResponse(validProject({ id: 7, name: 'proj' }), 'GET /p/7');
    expect(parsed.id).toBe(7);
    expect(parsed.name).toBe('proj');
  });

  it('throws on a missing required field', () => {
    const bad = validProject();
    delete bad.name;
    expect(() => parseProjectResponse(bad, 'GET /api/v1/projects/1')).toThrow(
      ApiResponseValidationError,
    );
  });

  it('rejects a wrong-typed field', () => {
    expect(() => parseProjectResponse(validProject({ created_at: 12345 }), 'GET /p/1')).toThrow(
      /created_at/,
    );
  });
});

describe('parseTaskListResponse', () => {
  it('accepts a pagination envelope and validates each row', () => {
    const page = parseTaskListResponse(
      { data: [validTask({ id: 1 }), validTask({ id: 2 })], total: 2, limit: 50, offset: 0 },
      'GET /api/v1/tasks',
    );
    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  it('accepts a bare array (legacy server) and synthesizes an envelope', () => {
    const page = parseTaskListResponse([validTask({ id: 9 })], 'GET /api/v1/tasks');
    expect(page.data).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.offset).toBe(0);
  });

  it('throws when a row inside the envelope is malformed', () => {
    const bad = { data: [validTask(), { id: 2 }], total: 2, limit: 50, offset: 0 };
    expect(() => parseTaskListResponse(bad, 'GET /api/v1/tasks')).toThrow(
      ApiResponseValidationError,
    );
  });

  it('throws when a row inside a bare array is malformed', () => {
    expect(() => parseTaskListResponse([validTask(), { id: 2 }], 'GET /api/v1/tasks')).toThrow(
      ApiResponseValidationError,
    );
  });

  it('throws on a non-list / non-envelope body instead of silently returning []', () => {
    // The old loose `asPage`/`unwrapPage` returned an empty list here, hiding
    // a real server fault. The validator now surfaces it.
    expect(() => parseTaskListResponse({ unexpected: 'shape' }, 'GET /api/v1/tasks')).toThrow(
      ApiResponseValidationError,
    );
  });

  it('rejects an envelope with a non-positive limit (server contract)', () => {
    const bad = { data: [], total: 0, limit: 0, offset: 0 };
    expect(() => parseTaskListResponse(bad, 'GET /api/v1/tasks')).toThrow(/limit/);
  });
});

describe('parseProjectListResponse', () => {
  it('accepts a valid project list envelope', () => {
    const page = parseProjectListResponse(
      { data: [validProject({ id: 1 })], total: 1, limit: 50, offset: 0 },
      'GET /api/v1/projects',
    );
    expect(page.data).toHaveLength(1);
  });

  it('throws when a project row is missing a required field', () => {
    const row = validProject();
    delete row.created_at;
    expect(() =>
      parseProjectListResponse({ data: [row], total: 1, limit: 50, offset: 0 }, 'GET /p'),
    ).toThrow(ApiResponseValidationError);
  });
});
