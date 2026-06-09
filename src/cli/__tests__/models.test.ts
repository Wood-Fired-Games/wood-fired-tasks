import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module — preserve ApiClientError etc., stub the calls.
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    listModels: vi.fn(),
    updateProject: vi.fn(),
    setModelPolicyDefault: vi.fn(),
  };
});

// Mock the env module to avoid validation errors.
vi.mock('../config/env.js', () => ({
  env: {
    API_BASE_URL: 'http://localhost:3000',
    API_KEY: 'test-key',
  },
}));

// Mock the json-output module so we can assert the envelope.
vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
  jsonError: vi.fn(),
  messageOutput: vi.fn(),
}));

// Mock the spinner module (used by withApiSpinner in client.js).
vi.mock('../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

function makeProgram(command: Command): Command {
  const program = new Command();
  program.option('--json', 'Output as JSON (machine-readable)');
  program.addCommand(command);
  return program;
}

// ── models list ─────────────────────────────────────────────

describe('models list command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NO_COLOR = '1';
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('prints one line per catalog entry (no stale marker when fresh)', async () => {
    const { listModels } = await import('../api/client.js');
    const { modelsCommand } = await import('../commands/models.js');
    vi.mocked(listModels).mockResolvedValue({
      stale: false,
      models: [
        { id: 'claude-opus-4-8', display_name: 'Opus 4.8', family: 'opus', created_at: 'x' },
        { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5', family: 'haiku', created_at: 'y' },
      ],
    });

    const program = makeProgram(modelsCommand);
    await program.parseAsync(['node', 'test', 'models', 'list']);

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('claude-opus-4-8'))).toBe(true);
    expect(lines.some((l) => l.includes('claude-haiku-4-5'))).toBe(true);
    // Exactly two model lines (no stale warning line).
    expect(lines.filter((l) => l.startsWith('claude-')).length).toBe(2);
    expect(lines.some((l) => l.includes('(stale)'))).toBe(false);
  });

  it('appends a (stale) marker to each line when the catalog is stale', async () => {
    const { listModels } = await import('../api/client.js');
    const { modelsCommand } = await import('../commands/models.js');
    vi.mocked(listModels).mockResolvedValue({
      stale: true,
      models: [
        { id: 'claude-opus-4-8', display_name: 'Opus 4.8', family: 'opus', created_at: 'x' },
      ],
    });

    const program = makeProgram(modelsCommand);
    await program.parseAsync(['node', 'test', 'models', 'list']);

    const lines = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const modelLine = lines.find((l) => l.startsWith('claude-opus-4-8'));
    expect(modelLine).toBeDefined();
    expect(modelLine).toContain('(stale)');
  });
});

// ── project set-models ──────────────────────────────────────

describe('project-set-models command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const mockProject = {
    id: 7,
    name: 'P',
    description: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NO_COLOR = '1';
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('persists the merged model_policy via updateProject', async () => {
    const { updateProject } = await import('../api/client.js');
    const { projectSetModelsCommand } = await import('../commands/project-set-models.js');
    vi.mocked(updateProject).mockResolvedValue(mockProject);

    const program = makeProgram(projectSetModelsCommand);
    await program.parseAsync([
      'node',
      'test',
      'project-set-models',
      '7',
      '--execution-heavy',
      'claude-opus-4-8',
      '--validation-default',
      'auto',
    ]);

    expect(updateProject).toHaveBeenCalledWith(7, {
      model_policy: {
        execution: { byCategory: { heavy: 'claude-opus-4-8' } },
        validation: { default: 'auto' },
      },
    });
    expect(process.exitCode).toBe(0);
  });

  it('errors (exit 1) when no model flags are supplied', async () => {
    const { updateProject } = await import('../api/client.js');
    const { projectSetModelsCommand } = await import('../commands/project-set-models.js');

    const program = makeProgram(projectSetModelsCommand);
    await program.parseAsync(['node', 'test', 'project-set-models', '7']);

    expect(updateProject).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects an invalid (empty) model ref', async () => {
    const { updateProject } = await import('../api/client.js');
    const { projectSetModelsCommand } = await import('../commands/project-set-models.js');

    const program = makeProgram(projectSetModelsCommand);
    await program.parseAsync(['node', 'test', 'project-set-models', '7', '--execution-heavy', '']);

    expect(updateProject).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

// ── settings set-models ─────────────────────────────────────

describe('settings-set-models command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NO_COLOR = '1';
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('calls the global default setter (setModelPolicyDefault)', async () => {
    const { setModelPolicyDefault } = await import('../api/client.js');
    const { settingsSetModelsCommand } = await import('../commands/settings-set-models.js');
    vi.mocked(setModelPolicyDefault).mockResolvedValue({
      planning: { constant: 'auto' },
    });

    const program = makeProgram(settingsSetModelsCommand);
    await program.parseAsync([
      'node',
      'test',
      'settings-set-models',
      '--planning-constant',
      'auto',
    ]);

    expect(setModelPolicyDefault).toHaveBeenCalledWith({
      planning: { constant: 'auto' },
    });
    expect(process.exitCode).toBe(0);
  });

  it('errors (exit 1) when no model flags are supplied', async () => {
    const { setModelPolicyDefault } = await import('../api/client.js');
    const { settingsSetModelsCommand } = await import('../commands/settings-set-models.js');

    const program = makeProgram(settingsSetModelsCommand);
    await program.parseAsync(['node', 'test', 'settings-set-models']);

    expect(setModelPolicyDefault).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
