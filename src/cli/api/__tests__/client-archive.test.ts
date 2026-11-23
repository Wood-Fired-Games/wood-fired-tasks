/**
 * WFT #2477 (A16) — CLI API client: archiveProject / unarchiveProject.
 *
 * Both POST to the dedicated REST routes and run the response through the
 * shared project response schema; a 422 surfaces as an ApiClientError that
 * keeps the server's message (with the per-status counts) and `details`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));
vi.mock('../../config/env.js', () => ({
  env: { API_BASE_URL: 'http://localhost:3000' },
}));
vi.mock('../../auth/credentials.js', () => ({
  resolveAuth: vi.fn(async () => ({ kind: 'bearer' as const, token: 'test-token' })),
}));

import { ApiClientError, archiveProject, unarchiveProject } from '../client.js';

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function archivedProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    name: 'Shipped',
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    value_charter: null,
    archived: true,
    archived_at: '2026-01-02T00:00:00.000Z',
    archived_by: 'alice',
    archive_reason: 'shipped',
    ...overrides,
  };
}

describe('CLI client: archiveProject / unarchiveProject (WFT #2477)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  function lastCall(): { url: string; init: RequestInit } {
    const call = fetchSpy.mock.calls.at(-1) as [string, RequestInit];
    return { url: String(call[0]), init: call[1] };
  }

  it('archiveProject POSTs reason and force to /projects/:id/archive and returns the project', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(archivedProject()));

    const project = await archiveProject(7, { reason: 'shipped', force: true });

    const { url, init } = lastCall();
    expect(url).toBe('http://localhost:3000/api/v1/projects/7/archive');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'shipped', force: true });
    expect(project).toMatchObject({ id: 7, archived: true, archive_reason: 'shipped' });
  });

  it('archiveProject with no options sends an empty body', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(archivedProject({ archive_reason: null })));

    await archiveProject(7);

    expect(JSON.parse(String(lastCall().init.body))).toEqual({});
  });

  it('unarchiveProject POSTs to /projects/:id/unarchive and returns the project', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        archivedProject({
          archived: false,
          archived_at: null,
          archived_by: null,
          archive_reason: null,
        }),
      ),
    );

    const project = await unarchiveProject(7);

    const { url, init } = lastCall();
    expect(url).toBe('http://localhost:3000/api/v1/projects/7/unarchive');
    expect(init.method).toBe('POST');
    expect(project).toMatchObject({ id: 7, archived: false, archived_at: null });
  });

  it('a 422 refusal keeps the server message with its counts, and the details', async () => {
    const details = {
      code: 'project_has_unfinished_tasks',
      total: 2,
      counts: { open: 1, in_progress: 1, blocked: 0, backlogged: 0 },
    };
    const message =
      'project_has_unfinished_tasks: project 7 has 2 unfinished tasks (open: 1, in_progress: 1, ' +
      'blocked: 0, backlogged: 0); finish or close them, or archive with force: true and a reason';
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: 'BUSINESS_RULE_VIOLATION', message, details }, 422),
    );

    const failure = await archiveProject(7).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiClientError);
    const apiError = failure as ApiClientError;
    expect(apiError.statusCode).toBe(422);
    expect(apiError.message).toBe(message);
    expect(apiError.apiError.details).toEqual(details);
  });
});
