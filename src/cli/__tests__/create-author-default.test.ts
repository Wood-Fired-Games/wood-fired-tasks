/**
 * Papercut #1007 — non-interactive `tasks create` / `tasks comment-add` should
 * default the attribution field (`--created-by` / `--author`) to the logged-in
 * identity (credentials PAT user) instead of failing with
 * "Missing required field: ...".
 *
 * These tests exercise the REAL command + REAL promptForMissing + REAL
 * credentials resolver against the on-disk credentials harness (a tmp file
 * pointed at by WFT_CREDENTIALS_PATH), so they cover the full default path:
 *   - with creds  → attribution defaults to the credentials display_name
 *   - without creds → the existing "Missing required field" error remains
 *
 * Only the API client + spinner/formatter output are mocked (no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'smol-toml';
import type { Credentials } from '../auth/credentials.js';

// Mock the API client so no network happens; preserve ApiClientError.
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    createTask: vi.fn(),
    addComment: vi.fn(),
  };
});

vi.mock('../config/env.js', () => ({
  env: { API_BASE_URL: 'http://localhost:3000', API_KEY: 'test-key' },
}));

// Spinner passthrough so withApiSpinner just runs the fn.
vi.mock('../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

vi.mock('../output/formatters.js', () => ({
  formatTaskDetail: vi.fn((task) => `Task #${task.id}: ${task.title}`),
  formatCommentList: vi.fn(() => ''),
  colorSuccess: vi.fn((t: string) => t),
  colorError: vi.fn((t: string) => t),
  colorWarn: vi.fn((t: string) => t),
  colorInfo: vi.fn((t: string) => t),
  colorBold: vi.fn((t: string) => t),
  isJsonMode: vi.fn(() => false),
  shouldUseColor: vi.fn(() => false),
}));

vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
  messageOutput: vi.fn(),
}));

const sampleCreds: Credentials = {
  active: {
    token: 'wft_pat_ABCDEFG1234567890',
    token_id: 17,
    server: 'https://woodfiredbugs.local',
    user_id: 1,
    display_name: 'Stuart Jeff',
    email: 'stuart@woodfiredgames.com',
    logged_in_at: '2026-05-23T12:34:56Z',
  },
};

let tmpDir: string;
let credPath: string;
let origCredPath: string | undefined;

function writeCredsFile(creds: Credentials): void {
  writeFileSync(credPath, stringify(creds), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(credPath, 0o600);
}

describe('create / comment-add identity defaulting (#1007)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    tmpDir = mkdtempSync(join(tmpdir(), 'wft-1007-'));
    credPath = join(tmpDir, 'credentials');
    origCredPath = process.env.WFT_CREDENTIALS_PATH;
    process.env.WFT_CREDENTIALS_PATH = credPath;
  });

  afterEach(() => {
    if (origCredPath === undefined) delete process.env.WFT_CREDENTIALS_PATH;
    else process.env.WFT_CREDENTIALS_PATH = origCredPath;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  async function buildProgram(): Promise<Command> {
    const { createCommand } = await import('../commands/create.js');
    const { commentAddCommand } = await import('../commands/comment-add.js');
    const program = new Command();
    program.option('--json', 'Output as JSON');
    program.option('--no-input', 'Disable interactive prompts');
    program.exitOverride();
    program.addCommand(createCommand);
    program.addCommand(commentAddCommand);
    return program;
  }

  it('create: defaults created_by to the credentials identity when --created-by omitted', async () => {
    writeCredsFile(sampleCreds);
    const { createTask } = await import('../api/client.js');
    vi.mocked(createTask).mockResolvedValue({
      id: 1,
      title: 'Scripted task',
      description: null,
      status: 'open',
      priority: 'medium',
      project_id: 1,
      assignee: null,
      created_by: 'Stuart Jeff',
      due_date: null,
      created_at: '2026-06-10T00:00:00Z',
      updated_at: '2026-06-10T00:00:00Z',
      tags: [],
    });

    const program = await buildProgram();
    // No --created-by, no TTY (vitest) → must NOT throw, defaults to identity.
    await program.parseAsync(['node', 'test', 'create', '-t', 'Scripted task', '-p', '1']);

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Scripted task',
        project_id: 1,
        created_by: 'Stuart Jeff',
      }),
    );
    expect(process.exitCode).toBe(0);
  });

  it('create: explicit --created-by still wins over the credentials identity', async () => {
    writeCredsFile(sampleCreds);
    const { createTask } = await import('../api/client.js');
    vi.mocked(createTask).mockResolvedValue({
      id: 2,
      title: 'Scripted task',
      description: null,
      status: 'open',
      priority: 'medium',
      project_id: 1,
      assignee: null,
      created_by: 'override',
      due_date: null,
      created_at: '2026-06-10T00:00:00Z',
      updated_at: '2026-06-10T00:00:00Z',
      tags: [],
    });

    const program = await buildProgram();
    await program.parseAsync([
      'node',
      'test',
      'create',
      '-t',
      'Scripted task',
      '-p',
      '1',
      '-c',
      'override',
    ]);

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ created_by: 'override' }));
  });

  it('create: without credentials, the existing "Missing required field: created-by" error remains', async () => {
    // No credentials file written.
    const { createTask } = await import('../api/client.js');

    const program = await buildProgram();
    await program.parseAsync(['node', 'test', 'create', '-t', 'Scripted task', '-p', '1']);

    expect(createTask).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errMsg = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errMsg).toContain('Missing required field: created-by');
  });

  it('comment-add: defaults author to the credentials identity when --author omitted', async () => {
    writeCredsFile(sampleCreds);
    const { addComment } = await import('../api/client.js');
    vi.mocked(addComment).mockResolvedValue({
      id: 5,
      task_id: 1,
      author: 'Stuart Jeff',
      content: 'scripted comment',
      created_at: '2026-06-10T00:00:00Z',
    });

    const program = await buildProgram();
    await program.parseAsync(['node', 'test', 'comment-add', '1', '-c', 'scripted comment']);

    expect(addComment).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ author: 'Stuart Jeff', content: 'scripted comment' }),
    );
    expect(process.exitCode).toBe(0);
  });

  it('comment-add: without credentials, the existing "Missing required field: author" error remains', async () => {
    const { addComment } = await import('../api/client.js');

    const program = await buildProgram();
    await program.parseAsync(['node', 'test', 'comment-add', '1', '-c', 'scripted comment']);

    expect(addComment).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errMsg = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errMsg).toContain('Missing required field: author');
  });
});
