#!/usr/bin/env node
import { program } from 'commander';
import { createCommand } from '../commands/create.js';
import { listCommand } from '../commands/list.js';
import { updateCommand } from '../commands/update.js';
import { deleteCommand } from '../commands/delete.js';
import { showCommand } from '../commands/show.js';

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

// Register commands
program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(updateCommand);
program.addCommand(deleteCommand);
program.addCommand(showCommand);

// Parse command-line arguments (async to support async command handlers)
program.parseAsync(process.argv);
