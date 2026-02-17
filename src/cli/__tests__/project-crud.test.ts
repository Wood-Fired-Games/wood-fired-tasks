import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    createProject: vi.fn(),
    listProjects: vi.fn(),
    getProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
  };
});

// Mock the env module to avoid validation errors
vi.mock('../config/env.js', () => ({
  env: {
    API_BASE_URL: 'http://localhost:3000',
    API_KEY: 'test-key',
  },
}));

// Mock the prompts module
vi.mock('../prompts/interactive.js', () => ({
  promptForMissing: vi.fn((field, value) => Promise.resolve(value)),
  confirmAction: vi.fn(),
  shouldPrompt: vi.fn(() => true),
}));

// Mock the json-output module
vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
  messageOutput: vi.fn(),
}));

// Mock the spinner module (used by withApiSpinner in client.js)
vi.mock('../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

// Mock the formatters module
vi.mock('../output/formatters.js', () => ({
  formatProjectDetail: vi.fn((project) => `Project #${project.id}: ${project.name}`),
  formatProjectTable: vi.fn((projects) => `Table with ${projects.length} projects`),
  colorSuccess: vi.fn((text: string) => text),
  colorError: vi.fn((text: string) => text),
  colorWarn: vi.fn((text: string) => text),
  colorInfo: vi.fn((text: string) => text),
  colorBold: vi.fn((text: string) => text),
  isJsonMode: vi.fn(() => false),
  shouldUseColor: vi.fn(() => false),
}));

const mockProject = {
  id: 1,
  name: 'Test Project',
  description: 'A test project',
  created_at: '2026-02-13T00:00:00Z',
  updated_at: '2026-02-13T00:00:00Z',
};

const mockProjectNoDesc = {
  id: 2,
  name: 'No Description',
  description: null,
  created_at: '2026-02-13T00:00:00Z',
  updated_at: '2026-02-13T00:00:00Z',
};

// ── project-create ──────────────────────────────────────────

describe('project-create command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { projectCreateCommand } = await import('../commands/project-create.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(projectCreateCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('creates project with name and description', async () => {
    const { createProject } = await import('../api/client.js');
    vi.mocked(createProject).mockResolvedValue(mockProject);

    await program.parseAsync(['node', 'test', 'project-create', '-n', 'Test Project', '-d', 'A test project']);

    expect(createProject).toHaveBeenCalledWith({
      name: 'Test Project',
      description: 'A test project',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('created successfully'));
  });

  it('prompts for missing name when not provided', async () => {
    const { createProject } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(promptForMissing).mockImplementation(
      (field, value) => Promise.resolve(value || 'Prompted Name')
    );

    vi.mocked(createProject).mockResolvedValue({
      ...mockProject,
      name: 'Prompted Name',
    });

    await program.parseAsync(['node', 'test', 'project-create']);

    expect(promptForMissing).toHaveBeenCalledWith('name', undefined);
  });

  it('outputs JSON when --json flag set', async () => {
    const { createProject } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(createProject).mockResolvedValue(mockProject);

    await program.parseAsync(['node', 'test', '--json', 'project-create', '-n', 'Test Project']);

    expect(jsonOutput).toHaveBeenCalledWith({ project: mockProject }, { id: mockProject.id });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('created successfully'));
  });
});

// ── project-list ────────────────────────────────────────────

describe('project-list command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { projectListCommand } = await import('../commands/project-list.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(projectListCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('lists all projects in table format', async () => {
    const { listProjects } = await import('../api/client.js');
    const { formatProjectTable } = await import('../output/formatters.js');

    vi.mocked(listProjects).mockResolvedValue([mockProject, mockProjectNoDesc]);

    await program.parseAsync(['node', 'test', 'project-list']);

    expect(listProjects).toHaveBeenCalled();
    expect(formatProjectTable).toHaveBeenCalledWith([mockProject, mockProjectNoDesc]);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('2 project(s) found'));
  });

  it('outputs JSON when --json flag set', async () => {
    const { listProjects } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    const projects = [mockProject, mockProjectNoDesc];
    vi.mocked(listProjects).mockResolvedValue(projects);

    await program.parseAsync(['node', 'test', '--json', 'project-list']);

    expect(jsonOutput).toHaveBeenCalledWith(projects, { count: 2 });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('project(s) found'));
  });

  it('shows empty message when no projects', async () => {
    const { listProjects } = await import('../api/client.js');

    vi.mocked(listProjects).mockResolvedValue([]);

    await program.parseAsync(['node', 'test', 'project-list']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No projects found'));
  });
});

// ── project-show ────────────────────────────────────────────

describe('project-show command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { projectShowCommand } = await import('../commands/project-show.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(projectShowCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('shows project details', async () => {
    const { getProject } = await import('../api/client.js');
    const { formatProjectDetail } = await import('../output/formatters.js');

    vi.mocked(getProject).mockResolvedValue(mockProject);

    await program.parseAsync(['node', 'test', 'project-show', '1']);

    expect(getProject).toHaveBeenCalledWith(1);
    expect(formatProjectDetail).toHaveBeenCalledWith(mockProject);
    expect(consoleLogSpy).toHaveBeenCalledWith('Project #1: Test Project');
  });

  it('outputs JSON when --json flag set', async () => {
    const { getProject } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(getProject).mockResolvedValue(mockProject);

    await program.parseAsync(['node', 'test', '--json', 'project-show', '1']);

    expect(jsonOutput).toHaveBeenCalledWith({ project: mockProject });
    const { formatProjectDetail } = await import('../output/formatters.js');
    expect(formatProjectDetail).not.toHaveBeenCalled();
  });

  it('shows error when project not found', async () => {
    const { getProject } = await import('../api/client.js');
    const { ApiClientError } = await import('../api/client.js');

    vi.mocked(getProject).mockRejectedValue(
      new ApiClientError('Project not found', 404, {
        error: 'NOT_FOUND',
        message: 'Project not found',
      })
    );

    await program.parseAsync(['node', 'test', 'project-show', '99999']);

    expect(getProject).toHaveBeenCalledWith(99999);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates project ID is a number', async () => {
    const { getProject } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'project-show', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(getProject).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

// ── project-update ──────────────────────────────────────────

describe('project-update command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { projectUpdateCommand } = await import('../commands/project-update.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(projectUpdateCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('updates project name', async () => {
    const { updateProject } = await import('../api/client.js');
    const updatedProject = { ...mockProject, name: 'Updated Name' };
    vi.mocked(updateProject).mockResolvedValue(updatedProject);

    await program.parseAsync(['node', 'test', 'project-update', '1', '-n', 'Updated Name']);

    expect(updateProject).toHaveBeenCalledWith(1, { name: 'Updated Name' });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('updated successfully'));
  });

  it('updates project description', async () => {
    const { updateProject } = await import('../api/client.js');
    const updatedProject = { ...mockProject, description: 'New description' };
    vi.mocked(updateProject).mockResolvedValue(updatedProject);

    await program.parseAsync(['node', 'test', 'project-update', '1', '-d', 'New description']);

    expect(updateProject).toHaveBeenCalledWith(1, { description: 'New description' });
  });

  it('requires at least one field', async () => {
    const { updateProject } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'project-update', '1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('No updates specified')
    );
    expect(process.exitCode).toBe(1);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('outputs JSON when --json flag set', async () => {
    const { updateProject } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    const updatedProject = { ...mockProject, name: 'JSON Updated' };
    vi.mocked(updateProject).mockResolvedValue(updatedProject);

    await program.parseAsync(['node', 'test', '--json', 'project-update', '1', '-n', 'JSON Updated']);

    expect(jsonOutput).toHaveBeenCalledWith({ project: updatedProject }, { id: updatedProject.id });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('updated successfully'));
  });

  it('validates project ID is a number', async () => {
    const { updateProject } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'project-update', 'invalid', '-n', 'Test']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(updateProject).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

// ── project-delete ──────────────────────────────────────────

describe('project-delete command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { projectDeleteCommand } = await import('../commands/project-delete.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(projectDeleteCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('deletes project when confirmed', async () => {
    const { deleteProject, getProject } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(getProject).mockResolvedValue(mockProject);
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteProject).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', 'project-delete', '1']);

    expect(getProject).toHaveBeenCalledWith(1);
    expect(confirmAction).toHaveBeenCalledWith("Delete project 'Test Project'?", false);
    expect(deleteProject).toHaveBeenCalledWith(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('deleted successfully'));
  });

  it('skips deletion when not confirmed', async () => {
    const { deleteProject, getProject } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(getProject).mockResolvedValue(mockProject);
    vi.mocked(confirmAction).mockResolvedValue(false);

    await program.parseAsync(['node', 'test', 'project-delete', '1']);

    expect(getProject).toHaveBeenCalledWith(1);
    expect(confirmAction).toHaveBeenCalledWith("Delete project 'Test Project'?", false);
    expect(deleteProject).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('deletes project with --force flag', async () => {
    const { deleteProject, getProject } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(getProject).mockResolvedValue(mockProject);
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteProject).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', '--force', 'project-delete', '1']);

    expect(getProject).toHaveBeenCalledWith(1);
    expect(deleteProject).toHaveBeenCalledWith(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('deleted successfully'));
  });

  it('outputs JSON when --json flag set', async () => {
    const { deleteProject, getProject } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(getProject).mockResolvedValue(mockProject);
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteProject).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', '--json', '--force', 'project-delete', '1']);

    expect(jsonOutput).toHaveBeenCalledWith({}, { message: 'Project 1 deleted' });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('deleted successfully'));
  });

  it('shows error when project not found', async () => {
    const { getProject, deleteProject } = await import('../api/client.js');
    const { ApiClientError } = await import('../api/client.js');

    vi.mocked(getProject).mockRejectedValue(
      new ApiClientError('Project not found', 404, {
        error: 'NOT_FOUND',
        message: 'Project not found',
      })
    );

    await program.parseAsync(['node', 'test', 'project-delete', '99999']);

    expect(getProject).toHaveBeenCalledWith(99999);
    expect(deleteProject).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates project ID is a number', async () => {
    const { deleteProject } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'project-delete', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(deleteProject).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
