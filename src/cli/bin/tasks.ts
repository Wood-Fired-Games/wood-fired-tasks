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

// Parse command-line arguments (async to support async command handlers)
program.parseAsync(process.argv);
