#!/usr/bin/env node
import { program } from 'commander';
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
import { backupCommand } from '../commands/backup.js';
import { doctorCommand } from '../commands/doctor.js';
import { statsCommand } from '../commands/stats.js';
import { completedCommand } from '../commands/completed.js';
import { dbCheckCommand } from '../commands/db-check.js';
import { dbCommand } from '../commands/db.js';
import { createCompletionsCommand } from '../commands/completions.js';

// Configure CLI program
program
  .name('tasks')
  .description('Wood Fired Bugs - Task management CLI')
  .version('1.0.0');

// Global options must be registered before subcommands to inherit properly
// Commands access via program.optsWithGlobals() or process.argv check
program.option('--json', 'Output as JSON (machine-readable)');
program.option('--no-input', 'Disable interactive prompts (fail on missing required fields)');
program.option('--force', 'Skip confirmation prompts for destructive actions');

// Register task commands
program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(updateCommand);
program.addCommand(deleteCommand);
program.addCommand(showCommand);

// Register project commands
program.addCommand(projectCreateCommand);
program.addCommand(projectListCommand);
program.addCommand(projectShowCommand);
program.addCommand(projectUpdateCommand);
program.addCommand(projectDeleteCommand);

// Register dependency commands
program.addCommand(depAddCommand);
program.addCommand(depRemoveCommand);
program.addCommand(depListCommand);

// Register comment commands
program.addCommand(commentAddCommand);
program.addCommand(commentListCommand);
program.addCommand(commentDeleteCommand);

// Register subtask commands
program.addCommand(subtaskCreateCommand);
program.addCommand(subtaskListCommand);

// Register claim command
program.addCommand(claimCommand);

// Register health command
program.addCommand(healthCommand);

// Register backup command
program.addCommand(backupCommand);

// Register diagnostic commands
program.addCommand(doctorCommand);
program.addCommand(statsCommand);
program.addCommand(completedCommand);
program.addCommand(dbCheckCommand);
// Nested parent for new-style `tasks db <subcommand>` commands (Plan 28-07).
// Coexists with the flat `db-check` registration above — both invocation
// forms remain supported, per RESEARCH §5.
program.addCommand(dbCommand);

// Register completions command (factory binds to `program` so generated
// scripts derive their command list from the same Commander registry — no
// hardcoded parallel list to keep in sync; see task #247).
program.addCommand(createCompletionsCommand(program));

// Export the configured program so tests can drive `program.parseAsync(...)`
// against the real registry. The bottom guard mirrors src/db/migrate.ts:133
// and src/index.ts — only auto-parse when invoked as a script.
export { program };

// Parse command-line arguments (async to support async command handlers).
// Guarded by import.meta.url === `file://${process.argv[1]}` so that
// importing this module from a test does NOT execute the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parseAsync(process.argv);
}
