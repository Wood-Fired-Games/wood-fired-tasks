import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCredentials, setTokenOverride } from '../../auth/credentials.js';
import type { Credentials } from '../../auth/credentials.js';

// Mock the spinner module so test calls don't try to render TTY UI.
vi.mock('../../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

// Stub env so it picks up the per-test API_KEY assignments below without
// the dotenv-driven validator pulling in real env state. Both API_BASE_URL
// and API_KEY are mutable from tests by directly assigning process.env.
vi.mock('../../config/env.js', () => ({
  env: {
    API_BASE_URL: 'http://localhost:3000',
    // Getter so each fetch in apiRequest re-reads the current env.API_KEY.
    get API_KEY() {
      return process.env.API_KEY ?? '';
    },
  },
}));

let tmpDir: string;
let origEnv: Record<string, string | undefined>;

const sampleCreds: Credentials = {
  active: {
    token: 'wfb_pat_FILE_TOKEN_123',
    token_id: 17,
    server: 'http://localhost:3000',
    user_id: 1,
    display_name: 'Stuart Jeff',
    email: 'stuart@woodfiredgames.com',
    logged_in_at: '2026-05-23T12:34:56Z',
  },
};

function snapshotEnv() {
  return {
    WFT_CREDENTIALS_PATH: process.env.WFT_CREDENTIALS_PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    API_KEY: process.env.API_KEY,
  };
}

function restoreEnv(snap: typeof origEnv) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  origEnv = snapshotEnv();
  tmpDir = mkdtempSync(join(tmpdir(), 'wfb-auth-'));
  // Route every test's credentials file into the per-test tmp dir.
  process.env.WFT_CREDENTIALS_PATH = join(tmpDir, 'credentials');
  delete process.env.API_KEY;
  setTokenOverride(null);
  vi.restoreAllMocks();
});

afterEach(() => {
  setTokenOverride(null);
  restoreEnv(origEnv);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.restoreAllMocks();
});

/** Helper: spy on globalThis.fetch and return a captured request object. */
function captureFetch(responseBody: unknown = { status: 'healthy' }, status = 200) {
  const captured: { url?: string; init?: RequestInit } = {};
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      captured.url = String(url);
      captured.init = init as RequestInit;
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
  return { captured, fetchSpy };
}

/** Helper: extract the Headers object from RequestInit into a flat Record. */
function flatHeaders(init: RequestInit | undefined): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  if (h instanceof Headers) {
    const o: Record<string, string> = {};
    h.forEach((v, k) => {
      o[k] = v;
    });
    return o;
  }
  if (Array.isArray(h)) {
    return Object.fromEntries(h);
  }
  return { ...(h as Record<string, string>) };
}

describe('apiRequest auth precedence', () => {
  it('uses Bearer auth from credentials file (no X-API-Key)', async () => {
    writeCredentials(sampleCreds);
    const { captured } = captureFetch();
    const { checkHealth } = await import('../client.js');
    await checkHealth();
    const h = flatHeaders(captured.init);
    expect(h['authorization'] ?? h['Authorization']).toBe(`Bearer ${sampleCreds.active.token}`);
    expect(h['x-api-key'] ?? h['X-API-Key']).toBeUndefined();
  });

  it('uses Bearer auth from --token flag override', async () => {
    setTokenOverride('wfb_pat_FLAG_OVERRIDE');
    const { captured } = captureFetch();
    const { checkHealth } = await import('../client.js');
    await checkHealth();
    const h = flatHeaders(captured.init);
    expect(h['authorization'] ?? h['Authorization']).toBe('Bearer wfb_pat_FLAG_OVERRIDE');
    expect(h['x-api-key'] ?? h['X-API-Key']).toBeUndefined();
  });

  it('falls back to legacy X-API-Key when no file and no override', async () => {
    process.env.API_KEY = 'legacykey';
    const { captured } = captureFetch();
    const { checkHealth } = await import('../client.js');
    await checkHealth();
    const h = flatHeaders(captured.init);
    expect(h['x-api-key'] ?? h['X-API-Key']).toBe('legacykey');
    expect(h['authorization'] ?? h['Authorization']).toBeUndefined();
  });

  it('--token flag wins over credentials file', async () => {
    writeCredentials(sampleCreds);
    setTokenOverride('wfb_pat_FLAG_OVERRIDE');
    const { captured } = captureFetch();
    const { checkHealth } = await import('../client.js');
    await checkHealth();
    const h = flatHeaders(captured.init);
    expect(h['authorization'] ?? h['Authorization']).toBe('Bearer wfb_pat_FLAG_OVERRIDE');
  });

  it('credentials file wins over env.API_KEY (file > env)', async () => {
    writeCredentials(sampleCreds);
    process.env.API_KEY = 'should-not-be-used';
    const { captured } = captureFetch();
    const { checkHealth } = await import('../client.js');
    await checkHealth();
    const h = flatHeaders(captured.init);
    expect(h['authorization'] ?? h['Authorization']).toBe(`Bearer ${sampleCreds.active.token}`);
    expect(h['x-api-key'] ?? h['X-API-Key']).toBeUndefined();
  });

  it('throws NotAuthenticatedError when no credentials are available', async () => {
    // No file, no override, no API_KEY.
    captureFetch();
    const { checkHealth } = await import('../client.js');
    const { NotAuthenticatedError } = await import('../errors.js');
    try {
      await checkHealth();
      throw new Error('expected NotAuthenticatedError');
    } catch (err) {
      expect(err).toBeInstanceOf(NotAuthenticatedError);
      expect((err as { code: string }).code).toBe('NOT_AUTHENTICATED');
    }
  });

  it('preserves Content-Type: application/json on POST regardless of auth method', async () => {
    process.env.API_KEY = 'legacykey';
    const { captured } = captureFetch({ id: 1, name: 'x' }, 201);
    const { createTask } = await import('../client.js');
    await createTask({
      title: 'x',
      project_id: 1,
      reporter: 'tester',
    } as unknown as Parameters<typeof createTask>[0]);
    const h = flatHeaders(captured.init);
    expect(h['content-type'] ?? h['Content-Type']).toBe('application/json');
    expect(h['x-api-key'] ?? h['X-API-Key']).toBe('legacykey');
  });
});
