#!/usr/bin/env node
import { program } from 'commander';
import { createCommand } from '../commands/create.js';
import { listCommand } from '../commands/list.js';
import { updateCommand } from '../commands/update.js';

// Configure CLI program
program
  .name('tasks')
  .description('Wood Fired Bugs - Task management CLI')
  .version('1.0.0');

// Register commands
program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(updateCommand);

// Parse command-line arguments
program.parse(process.argv);
