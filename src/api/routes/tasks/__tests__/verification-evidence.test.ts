import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';

/**
 * Wave 1.4 (task #312) — REST surface coverage for tasks.verification_evidence.
 *
 * Verifies:
 *  - PUT /tasks/:id accepts a full verification_evidence object and persists it.
 *  - GET /tasks/:id returns the parsed structure deep-equal to what was sent.
 *  - GET /tasks (list) DEFAULT STRIPS verification_evidence (renders null).
 *  - GET /tasks?include=verification re-includes the parsed structure.
 *  - GET /tasks?verified=false returns NULL-evidence + NOT_VERIFIED + FAIL rows.
 *  - GET /tasks?verified=true returns PASS + PARTIAL only.
 *  - Unknown verdicts return 400 (Zod rejection at the route boundary).
 */

const TEST_KEY = 'test-key-verification';
const TEST_LABEL = 'wave-1-4-verification';

describe('REST /api/v1/tasks — verification_evidence field (#312)', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let projectId: number;
  let prevApiKeys: string | undefined;
  const headers = { 'x-api-key': TEST_KEY };

  beforeAll(async () => {
    prevApiKeys = process.env.API_KEYS;
    process.env.API_KEYS = `${TEST_KEY}:${TEST_LABEL}`;
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    if (prevApiKeys === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = prevApiKeys;
    }
  });

  beforeEach(() => {
    // Each test gets its own project so the list filters do not bleed across
    // it/it boundaries. (We can't dispose the whole app between tests
    // because the server is shared via beforeAll for speed.)
    projectId = app.projectService.createProject({
      name: `wave-1-4-${Date.now()}-${Math.random()}`,
    }).id;
  });

  async function createTaskHere(title: string): Promise<number> {
    const resp = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: { title, project_id: projectId, created_by: 'tester' },
    });
    return (JSON.parse(resp.body) as { id: number }).id;
  }

  it('PUT accepts a full evidence object; GET returns it deep-equal', async () => {
    const id = await createTaskHere('round-trip');
    const evidence = {
      verdict: 'PASS' as const,
      checks: [{ name: 'build', status: 'PASS' as const, evidence_url_or_text: 'green' }],
      verifier_session_id: 'sess-abc',
      verifier_request_id: 'req-123',
      verified_at: '2026-05-23T12:00:00.000Z',
    };

    const putResp = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: { verification_evidence: evidence },
    });
    expect(putResp.statusCode).toBe(200);
    expect(JSON.parse(putResp.body).verification_evidence).toEqual(evidence);

    const getResp = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${id}`,
      headers,
    });
    expect(getResp.statusCode).toBe(200);
    expect(JSON.parse(getResp.body).verification_evidence).toEqual(evidence);
  });

  it('GET /tasks list DEFAULT strips verification_evidence (renders null)', async () => {
    const id = await createTaskHere('list-default');
    await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: {
        verification_evidence: { verdict: 'PASS', verifier_session_id: 'x' },
      },
    });

    const listResp = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks?project_id=${projectId}`,
      headers,
    });
    expect(listResp.statusCode).toBe(200);
    const body = JSON.parse(listResp.body) as {
      data: Array<{ id: number; verification_evidence: unknown }>;
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.verification_evidence).toBeNull();
  });

  it('GET /tasks?include=verification inflates verification_evidence', async () => {
    const id = await createTaskHere('list-include');
    const evidence = { verdict: 'PASS' as const, verifier_session_id: 'incl' };
    await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: { verification_evidence: evidence },
    });

    const listResp = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks?project_id=${projectId}&include=verification`,
      headers,
    });
    expect(listResp.statusCode).toBe(200);
    const body = JSON.parse(listResp.body) as {
      data: Array<{ id: number; verification_evidence: unknown }>;
    };
    const row = body.data.find((r) => r.id === id);
    expect(row?.verification_evidence).toEqual(evidence);
  });

  it('GET /tasks?verified=false includes NULL + NOT_VERIFIED + FAIL; excludes PASS/PARTIAL', async () => {
    // Build a population: one of each verdict, plus a NULL-evidence row.
    const nullId = await createTaskHere('null-evidence');
    const passId = await createTaskHere('pass');
    const failId = await createTaskHere('fail');
    const partialId = await createTaskHere('partial');
    const notVerifiedId = await createTaskHere('not-verified');

    const setEvidence = async (id: number, verdict: string) => {
      const resp = await server.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${id}`,
        headers,
        payload: { verification_evidence: { verdict } },
      });
      expect(resp.statusCode).toBe(200);
    };

    await setEvidence(passId, 'PASS');
    await setEvidence(failId, 'FAIL');
    await setEvidence(partialId, 'PARTIAL');
    await setEvidence(notVerifiedId, 'NOT_VERIFIED');

    const resp = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks?project_id=${projectId}&verified=false&include=verification`,
      headers,
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { data: Array<{ id: number }> };
    const ids = body.data.map((r) => r.id).sort();
    expect(ids).toEqual([nullId, failId, notVerifiedId].sort());

    // And verified=true returns the complement.
    const trueResp = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks?project_id=${projectId}&verified=true&include=verification`,
      headers,
    });
    expect(trueResp.statusCode).toBe(200);
    const trueBody = JSON.parse(trueResp.body) as { data: Array<{ id: number }> };
    const trueIds = trueBody.data.map((r) => r.id).sort();
    expect(trueIds).toEqual([passId, partialId].sort());
  });

  it('PUT with an unknown verdict returns 400', async () => {
    const id = await createTaskHere('bad-verdict');
    const resp = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: { verification_evidence: { verdict: 'BOGUS' } },
    });
    expect(resp.statusCode).toBe(400);
  });

  it('PUT preserves verification_evidence when not in the patch payload', async () => {
    const id = await createTaskHere('preserve');
    await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: {
        verification_evidence: { verdict: 'PASS', verifier_session_id: 'keep' },
      },
    });

    // Unrelated PUT — verification_evidence stays put.
    const putResp = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: { title: 'renamed' },
    });
    expect(putResp.statusCode).toBe(200);
    const body = JSON.parse(putResp.body) as { verification_evidence: { verdict: string } | null };
    expect(body.verification_evidence?.verdict).toBe('PASS');
  });
});
