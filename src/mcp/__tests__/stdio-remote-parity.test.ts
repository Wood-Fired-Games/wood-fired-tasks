/**
 * STRUCTURAL invariant: every tool the stdio MCP server registers MUST also
 * have a remote-proxy registration (task #648).
 *
 *     stdioToolNames ⊆ remoteToolNames ∪ LOCAL_ONLY_ALLOWLIST
 *
 * This is the machine guard whose absence let the WSJF tools ship stdio-only
 * (unreachable in production) while every per-tool parity test still passed.
 * Per-tool parity tests (completion_report, topology_check, wsjf) only check
 * tools that someone remembered to write a test for — none of them FAIL when a
 * NEW stdio tool is added without a remote counterpart. This one does.
 *
 * The tool-name enumeration is harvested from the REAL registrars (not a
 * hand-maintained list): we spy on `McpServer.prototype.registerTool` while
 * booting the real `createMcpServer(...)`, and we reuse the stub-server pattern
 * from register-tools.test.ts to harvest the remote surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { registerRemoteTools } from '../remote/register-tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pure, exported helpers — the negative cases below are deterministic unit
// tests over these, so they never depend on a live server or db.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the stdio tool names that have NO remote counterpart and are NOT
 * covered by an explicit allowlist entry. An empty result means full parity.
 */
export function parityViolations(
  stdioNames: string[],
  remoteNames: Set<string>,
  allowlist: { name: string; reason: string }[],
): string[] {
  const allowed = new Set(allowlist.map((entry) => entry.name));
  return stdioNames.filter(
    (name) => !remoteNames.has(name) && !allowed.has(name),
  );
}

/**
 * Throws if any allowlist entry carries an empty / whitespace-only reason.
 * Local-only tools are allowed, but every exception MUST be justified in code.
 */
export function validateAllowlist(
  allowlist: { name: string; reason: string }[],
): void {
  for (const entry of allowlist) {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(
        `LOCAL_ONLY_ALLOWLIST entry "${entry.name}" has an empty reason. ` +
          'Every intentionally stdio-only tool MUST document why it has no ' +
          'remote proxy.',
      );
    }
  }
}

/**
 * Tools that are intentionally stdio-only (no remote proxy) — each entry MUST
 * carry a non-empty reason. Starts EMPTY: the current tree has full parity.
 * Anyone adding a stdio-only tool must add an entry here WITH a reason, which
 * is exactly the deliberate, reviewable decision this guard forces.
 */
export const LOCAL_ONLY_ALLOWLIST: { name: string; reason: string }[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Harvest the REAL stdio surface: spy registerTool, boot the real server.
// ─────────────────────────────────────────────────────────────────────────────

async function harvestStdioToolNames(): Promise<string[]> {
  const names: string[] = [];
  const spy = vi
    .spyOn(McpServer.prototype, 'registerTool')
    .mockImplementation(function (
      this: McpServer,
      name: string,
      ..._rest: unknown[]
    ) {
      names.push(name);
      // Return a minimal stub; handlers are never invoked here — we only need
      // registerTool to be CALLED so its first arg (the tool name) is captured.
      return { name } as unknown as ReturnType<
        typeof McpServer.prototype.registerTool
      >;
    } as typeof McpServer.prototype.registerTool);

  // A fully-wired app over a migrated in-memory db. createTestApp() builds the
  // same service/repository graph production uses, INCLUDING topologyService, so
  // topology_check registers. The db can stay empty — service construction is
  // all that must not throw.
  const app = await createTestApp();
  try {
    createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
      undefined,
      app.topologyService,
    );
  } finally {
    spy.mockRestore();
    app.dispose();
  }

  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Harvest the REAL remote surface: stub McpServer + mock RestClient.
// (Same shape as src/mcp/remote/__tests__/register-tools.test.ts.)
// ─────────────────────────────────────────────────────────────────────────────

function harvestRemoteToolNames(): string[] {
  const names: string[] = [];
  const stub = {
    registerTool: vi.fn((name: string) => {
      names.push(name);
      return { name };
    }),
  };
  // The handlers are never invoked, so a fully-mocked client suffices. Methods
  // are accessed lazily inside the closures, not at registration time.
  const mockRestClient = new Proxy(
    {},
    { get: () => vi.fn() },
  );
  registerRemoteTools(
    stub as unknown as Parameters<typeof registerRemoteTools>[0],
    mockRestClient as unknown as Parameters<typeof registerRemoteTools>[1],
  );
  return names;
}

describe('stdio ⊆ remote MCP tool parity (#648)', () => {
  it('every stdio MCP tool has a remote-proxy counterpart', async () => {
    const stdioNames = await harvestStdioToolNames();
    const remoteNames = new Set(harvestRemoteToolNames());

    const violations = parityViolations(
      stdioNames,
      remoteNames,
      LOCAL_ONLY_ALLOWLIST,
    );
    expect(
      violations,
      `These stdio tools have NO remote-proxy registration and are unreachable ` +
        `in production: [${violations.join(', ')}]. Either register them in ` +
        `src/mcp/remote/register-tools.ts, or (if intentionally local-only) add ` +
        `an entry WITH a reason to LOCAL_ONLY_ALLOWLIST.`,
    ).toEqual([]);
  });

  // Sanity: a harvest that silently captured nothing must NOT pass vacuously.
  it('harvests a non-empty stdio surface including known tools', async () => {
    const stdioNames = await harvestStdioToolNames();
    expect(stdioNames.length).toBeGreaterThan(0);
    expect(stdioNames).toContain('create_task');
    expect(stdioNames).toContain('wsjf_health');
    expect(stdioNames).toContain('topology_check');
  });

  // ── Pure-helper negative cases (deterministic) ────────────────────────────

  it('parityViolations detects a stdio tool missing from remote', () => {
    expect(parityViolations(['only_stdio_tool'], new Set(), [])).toEqual([
      'only_stdio_tool',
    ]);
    expect(
      parityViolations(['only_stdio_tool'], new Set(), [
        { name: 'only_stdio_tool', reason: 'direct-DB only' },
      ]),
    ).toEqual([]);
  });

  it('validateAllowlist rejects an empty reason', () => {
    expect(() => validateAllowlist([{ name: 'x', reason: '  ' }])).toThrow();
    expect(() => validateAllowlist([{ name: 'x', reason: '' }])).toThrow();
    expect(() =>
      validateAllowlist([{ name: 'x', reason: 'good reason' }]),
    ).not.toThrow();
  });

  it('the shipped allowlist has only reason-annotated entries', () => {
    expect(() => validateAllowlist(LOCAL_ONLY_ALLOWLIST)).not.toThrow();
  });

  // The current tree must have FULL parity — the allowlist is empty.
  it('the shipped allowlist is empty (current tree has full parity)', () => {
    expect(LOCAL_ONLY_ALLOWLIST).toEqual([]);
  });
});
