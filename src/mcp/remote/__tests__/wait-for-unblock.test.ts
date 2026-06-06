/**
 * Unit tests for the remote `wait_for_unblock` tool (task #481).
 *
 * Two layers are covered:
 *   1. `RestClient.waitForUnblockViaSse` — the SSE resolution primitive. We
 *      stub `fetch` with a fake `Response` whose `body` is a `ReadableStream`
 *      that emits real `text/event-stream` frames, and assert the method
 *      resolves `true` on a matching `task.status_changed` frame, `false` on
 *      timeout, and that it tears down the reader on resolve / timeout / abort.
 *   2. The `wait_for_unblock` handler registered by `registerRemoteTools` —
 *      driven with a mock client to assert the three byte-identical envelopes
 *      (already_unblocked / unblocked / timeout) and the unauthorized path.
 *
 * The happy-path test feeds a REAL matching SSE frame through a stubbed
 * `fetch` (see `sseResponse(...)` below) and asserts `status: "unblocked"`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RestClient } from '../rest-client.js';
import { registerRemoteTools } from '../register-tools.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

/**
 * Build a fake `Response` whose body is a `ReadableStream<Uint8Array>` that
 * emits the supplied SSE wire-format chunks in order, then (optionally)
 * closes. `onCancel` fires when the consumer cancels the reader — used to
 * assert teardown. If `keepOpen` is true the stream never closes on its own,
 * so only an abort / cancel ends it (models a live, idle SSE connection).
 */
function sseResponse(
  chunks: string[],
  opts: { keepOpen?: boolean; onCancel?: () => void; status?: number } = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      if (!opts.keepOpen) {
        controller.close();
      }
    },
    cancel() {
      opts.onCancel?.();
    },
  });
  return new Response(stream, {
    status: opts.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** A single matching `task.status_changed` SSE frame for `taskId`. */
function matchFrame(taskId: number): string {
  const payload = {
    eventType: 'task.status_changed',
    timestamp: '2026-05-29T00:00:00.000Z',
    data: { id: taskId, status: 'open', title: 't' },
    metadata: { source: 'workflow', from: 'blocked', to: 'open' },
  };
  return `event: task.status_changed\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe('RestClient.waitForUnblockViaSse', () => {
  it('resolves true on a matching task.status_changed frame', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([matchFrame(42)], { keepOpen: true }));
    const client = new RestClient('http://localhost:3000', 'test-key');
    const result = await client.waitForUnblockViaSse(
      42,
      5000,
      new AbortController().signal,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toBe(true);
    // The stream URL filters to status_changed events.
    expect(fetchImpl.mock.calls[0][0]).toContain('/api/v1/events?event_types=task.status_changed');
  });

  it('ignores non-matching frames (wrong id / wrong transition) then resolves on the match', async () => {
    const wrongId = `event: task.status_changed\ndata: ${JSON.stringify({
      data: { id: 99 },
      metadata: { from: 'blocked', to: 'open' },
    })}\n\n`;
    const wrongTransition = `event: task.status_changed\ndata: ${JSON.stringify({
      data: { id: 42 },
      metadata: { from: 'open', to: 'blocked' },
    })}\n\n`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([wrongId, wrongTransition, matchFrame(42)], { keepOpen: true }),
      );
    const client = new RestClient('http://localhost:3000', 'test-key');
    const result = await client.waitForUnblockViaSse(
      42,
      5000,
      new AbortController().signal,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toBe(true);
  });

  it('resolves false (no throw) on timeout and cancels the reader', async () => {
    const onCancel = vi.fn();
    // keepOpen + no matching frame → only the timeout ends the wait.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse([':keepalive\n\n'], { keepOpen: true, onCancel }));
    const client = new RestClient('http://localhost:3000', 'test-key');
    const result = await client.waitForUnblockViaSse(
      42,
      30,
      new AbortController().signal,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toBe(false);
    // Teardown: the reader must have been cancelled when the timeout aborted.
    expect(onCancel).toHaveBeenCalled();
  });

  it('resolves false and tears down when the external signal aborts', async () => {
    const onCancel = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse([':keepalive\n\n'], { keepOpen: true, onCancel }));
    const client = new RestClient('http://localhost:3000', 'test-key');
    const ac = new AbortController();
    const p = client.waitForUnblockViaSse(
      42,
      5000,
      ac.signal,
      fetchImpl as unknown as typeof fetch,
    );
    // Abort shortly after the stream is open.
    setTimeout(() => ac.abort(), 20);
    const result = await p;
    expect(result).toBe(false);
    expect(onCancel).toHaveBeenCalled();
  });

  it('throws on a non-2xx stream response (e.g. unauthorized)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new RestClient('http://localhost:3000', 'test-key');
    await expect(
      client.waitForUnblockViaSse(
        42,
        5000,
        new AbortController().signal,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Unauthorized/);
  });
});

// ── Handler-level tests (register-tools wiring) ─────────────────────────────

function makeFakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
      return { name };
    }),
  };
  return { server, handlers };
}

function makeMockClient() {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    listTasksPaginated: vi.fn(),
    deleteTask: vi.fn(),
    claimTask: vi.fn(),
    getSubtasksPaginated: vi.fn(),
    getCompletionReport: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    listProjectsPaginated: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    getDependencies: vi.fn(),
    addComment: vi.fn(),
    getCommentsPaginated: vi.fn(),
    deleteComment: vi.fn(),
    checkHealth: vi.fn(),
    getTopology: vi.fn(),
    waitForUnblockViaSse: vi.fn(),
  };
}

describe('wait_for_unblock remote tool handler', () => {
  let handlers: Map<string, Handler>;
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    const built = makeFakeServer();
    handlers = built.handlers;
    client = makeMockClient();
    registerRemoteTools(
      built.server as unknown as Parameters<typeof registerRemoteTools>[0],
      client as unknown as Parameters<typeof registerRemoteTools>[1],
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered', () => {
    expect(handlers.has('wait_for_unblock')).toBe(true);
  });

  it('already_unblocked: returns immediately WITHOUT awaiting the SSE result', async () => {
    client.getTask.mockResolvedValue({ id: 5, status: 'open', title: 't' });
    // Stream is opened first (subscribe-before-read), but the fast path must
    // abort it and NOT depend on its resolution. Leave it pending forever.
    client.waitForUnblockViaSse.mockReturnValue(new Promise<boolean>(() => {}));

    const r = await handlers.get('wait_for_unblock')!({ task_id: 5 });
    expect(r.structuredContent).toEqual({
      status: 'already_unblocked',
      task: { id: 5, status: 'open', title: 't' },
      applied_timeout_seconds: 300,
    });
    expect(client.waitForUnblockViaSse).toHaveBeenCalledTimes(1);
  });

  it('unblocked: blocked task + matching SSE transition yields the unblocked envelope', async () => {
    client.getTask
      .mockResolvedValueOnce({ id: 7, status: 'blocked', title: 't' }) // call-time read
      .mockResolvedValueOnce({ id: 7, status: 'open', title: 't' }); // fresh re-read
    client.waitForUnblockViaSse.mockResolvedValue(true);

    const r = await handlers.get('wait_for_unblock')!({ task_id: 7, timeout_seconds: 60 });
    expect(r.structuredContent).toEqual({
      status: 'unblocked',
      task: { id: 7, status: 'open', title: 't' },
      applied_timeout_seconds: 60,
    });
    expect(client.waitForUnblockViaSse).toHaveBeenCalledWith(7, 60_000, expect.any(AbortSignal));
  });

  it('timeout: blocked task + SSE resolves false yields the timeout envelope (no throw)', async () => {
    client.getTask.mockResolvedValue({ id: 8, status: 'blocked', title: 't' });
    client.waitForUnblockViaSse.mockResolvedValue(false);

    const r = await handlers.get('wait_for_unblock')!({ task_id: 8, timeout_seconds: 120 });
    expect(r.structuredContent).toEqual({
      status: 'timeout',
      task_id: 8,
      waited_seconds: 120,
      applied_timeout_seconds: 120,
    });
  });

  it('clamps timeout_seconds to the [1, 1800] ceiling and echoes applied value', async () => {
    client.getTask.mockResolvedValue({ id: 9, status: 'open', title: 't' });
    client.waitForUnblockViaSse.mockReturnValue(new Promise<boolean>(() => {}));

    const r = await handlers.get('wait_for_unblock')!({ task_id: 9, timeout_seconds: 99999 });
    expect(r.structuredContent).toMatchObject({ applied_timeout_seconds: 1800 });
  });

  it('unauthorized / unknown task: getTask throws → McpError (same as remote get_task)', async () => {
    client.getTask.mockRejectedValue(new Error('API request failed: Not Found'));
    client.waitForUnblockViaSse.mockReturnValue(new Promise<boolean>(() => {}));

    await expect(handlers.get('wait_for_unblock')!({ task_id: 404 })).rejects.toBeInstanceOf(
      McpError,
    );
  });
});
