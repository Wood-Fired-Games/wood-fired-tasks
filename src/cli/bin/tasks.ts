#!/usr/bin/env node
import { program } from 'commander';
import { createCommand } from '../commands/create.js';

// Configure CLI program
program
  .name('tasks')
  .description('Wood Fired Bugs - Task management CLI')
  .version('1.0.0');

// Register commands
program.addCommand(createCommand);

// Parse command-line arguments
program.parse(process.argv);
