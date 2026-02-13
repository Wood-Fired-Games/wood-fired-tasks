import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    checkHealth: vi.fn(),
  };
});

// Mock the env module to avoid validation errors
vi.mock('../config/env.js', () => ({
  env: {
    API_BASE_URL: 'http://localhost:3000',
    API_KEY: 'test-key',
  },
}));

// Mock the json-output module
vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
}));

// Mock the formatters module
vi.mock('../output/formatters.js', () => ({
  formatHealthStatus: vi.fn((health) => {
    const status = health.status === 'healthy' ? 'OK' : 'ERROR';
    const db = health.checks.database === 'ok' ? 'Connected' : 'Disconnected';
    let result = `Service Status: ${status}\nDatabase: ${db}`;
    if (health.version) result += `\nVersion: ${health.version}`;
    return result;
  }),
}));

const mockHealthOk = {
  status: 'healthy',
  timestamp: '2024-01-15T10:30:00Z',
  version: '1.0.0',
  checks: {
    database: 'ok',
  },
};

const mockHealthError = {
  status: 'unhealthy',
  timestamp: '2024-01-15T10:30:00Z',
  version: '1.0.0',
  checks: {
    database: 'failed',
  },
};

describe('health command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { healthCommand } = await import('../commands/health.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(healthCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('shows health status with database connected', async () => {
    const { checkHealth } = await import('../api/client.js');
    const { formatHealthStatus } = await import('../output/formatters.js');

    vi.mocked(checkHealth).mockResolvedValue(mockHealthOk);

    await program.parseAsync(['node', 'test', 'health']);

    expect(checkHealth).toHaveBeenCalled();
    expect(formatHealthStatus).toHaveBeenCalledWith(mockHealthOk);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('OK'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Connected'));
  });

  it('shows health status with database disconnected', async () => {
    const { checkHealth } = await import('../api/client.js');
    const { formatHealthStatus } = await import('../output/formatters.js');

    vi.mocked(checkHealth).mockResolvedValue(mockHealthError);

    await program.parseAsync(['node', 'test', 'health']);

    expect(checkHealth).toHaveBeenCalled();
    expect(formatHealthStatus).toHaveBeenCalledWith(mockHealthError);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Disconnected'));
  });

  it('outputs JSON when --json flag set', async () => {
    const { checkHealth } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(checkHealth).mockResolvedValue(mockHealthOk);

    await program.parseAsync(['node', 'test', '--json', 'health']);

    expect(jsonOutput).toHaveBeenCalledWith(mockHealthOk);
    const { formatHealthStatus } = await import('../output/formatters.js');
    expect(formatHealthStatus).not.toHaveBeenCalled();
  });

  it('shows version when present', async () => {
    const { checkHealth } = await import('../api/client.js');

    vi.mocked(checkHealth).mockResolvedValue(mockHealthOk);

    await program.parseAsync(['node', 'test', 'health']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('1.0.0'));
  });

  it('handles API connection errors', async () => {
    const { checkHealth } = await import('../api/client.js');

    vi.mocked(checkHealth).mockRejectedValue(new Error('Cannot reach API server'));

    await program.parseAsync(['node', 'test', 'health']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
