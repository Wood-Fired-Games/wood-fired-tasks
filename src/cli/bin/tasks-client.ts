#!/usr/bin/env node
/**
 * Client CLI entry point for remote machines.
 *
 * Identical to tasks.ts but excludes commands that require local SQLite access:
 * backup, doctor, stats, db-check.
 */
import { program } from 'commander';
import { setTokenOverride } from '../auth/credentials.js';
import { NotAuthenticatedError } from '../api/errors.js';
import { createCommand } from '../commands/create.js';
import { listCommand } from '../commands/list.js';
import { updateCommand } from '../commands/update.js';
import { deleteCommand } from '../commands/delete.js';
import { showCommand } from '../commands/show.js';
import { projectCreateCommand } from '../commands/project-create.js';
import { projectListCommand } from '../commands/project-list.js';
import { projectShowCommand } from '../commands/project-show.js';
import { projectUpdateCommand } from '../commands/project-update.js';
import { projectDeleteCommand } from '../commands/project-delete.js';
import { depAddCommand } from '../commands/dep-add.js';
import { depRemoveCommand } from '../commands/dep-remove.js';
import { depListCommand } from '../commands/dep-list.js';
import { commentAddCommand } from '../commands/comment-add.js';
import { commentListCommand } from '../commands/comment-list.js';
import { commentDeleteCommand } from '../commands/comment-delete.js';
import { subtaskCreateCommand } from '../commands/subtask-create.js';
import { subtaskListCommand } from '../commands/subtask-list.js';
import { healthCommand } from '../commands/health.js';
import { claimCommand } from '../commands/claim.js';
import { createCompletionsCommand } from '../commands/completions.js';
import { loginCommand } from '../commands/login.js';
import { logoutCommand } from '../commands/logout.js';

program
  .name('tasks')
  .description('Wood Fired Bugs - Task management CLI (remote client)')
  .version('1.0.0');

program.option('--json', 'Output as JSON (machine-readable)');
program.option('--no-input', 'Disable interactive prompts (fail on missing required fields)');
program.option('--force', 'Skip confirmation prompts for destructive actions');
// Plan 30-05: --token global flag (mirrors tasks.ts behavior).
program.option(
  '--token <token>',
  'Use the given PAT as Bearer auth (overrides credentials file and API_KEY env)'
);
program.hook('preAction', () => {
  const t = program.opts().token;
  setTokenOverride(typeof t === 'string' && t.length > 0 ? t : null);
});

program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(updateCommand);
program.addCommand(deleteCommand);
program.addCommand(showCommand);
program.addCommand(projectCreateCommand);
program.addCommand(projectListCommand);
program.addCommand(projectShowCommand);
program.addCommand(projectUpdateCommand);
program.addCommand(projectDeleteCommand);
program.addCommand(depAddCommand);
program.addCommand(depRemoveCommand);
program.addCommand(depListCommand);
program.addCommand(commentAddCommand);
program.addCommand(commentListCommand);
program.addCommand(commentDeleteCommand);
program.addCommand(subtaskCreateCommand);
program.addCommand(subtaskListCommand);
program.addCommand(claimCommand);
program.addCommand(healthCommand);
// Register completions command (factory binds to `program` — single source of
// truth for the registered command list; see task #247).
program.addCommand(createCompletionsCommand(program));

// Register login command (Plan 30-06).
program.addCommand(loginCommand);

// Register logout command (Plan 30-07).
program.addCommand(logoutCommand);

// Plan 30-05: top-level catch — friendly NotAuthenticatedError surface.
program.parseAsync(process.argv).catch((err) => {
  if (err instanceof NotAuthenticatedError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
