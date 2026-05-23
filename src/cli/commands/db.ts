/**
 * `tasks db ...` parent command — nested subcommand namespace introduced in
 * Plan 28-07. Hosts `mint-token` today; future DB-admin commands attach here.
 *
 * The existing flat `tasks db-check` registration in tasks.ts STAYS — per
 * 28-RESEARCH §5, the two coexist by design. This file does not subsume
 * `db-check`; backward compatibility for that invocation is preserved.
 */
import { Command } from 'commander';
import { dbMintTokenCommand } from './db-mint-token.js';

export const dbCommand = new Command('db')
  .description('Database administration commands')
  .addCommand(dbMintTokenCommand);
