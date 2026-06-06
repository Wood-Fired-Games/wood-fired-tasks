import { Command } from 'commander';
import { checkHealth, withApiSpinner } from '../api/client.js';
import { formatHealthStatus } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

export const healthCommand = new Command('health')
  .description('Check service health status')
  .action(async () => {
    try {
      // Check if JSON mode (global flag from program)
      const program = healthCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts['json'] || false;

      // Check health via API
      const health = await withApiSpinner('Checking health...', () => checkHealth());

      // Display results
      if (isJsonMode) {
        jsonOutput(health);
      } else {
        console.log(formatHealthStatus(health));
      }
    } catch (error) {
      handleError(error);
    }
  });
