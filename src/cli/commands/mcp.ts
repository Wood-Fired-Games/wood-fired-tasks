import { Command } from 'commander';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/**
 * MCP bridge launcher (task #734).
 *
 * Consolidates the legacy `mcp:start` / `mcp:remote` npm scripts behind a
 * single `tasks mcp` subcommand. By default it launches the LOCAL stdio MCP
 * server (src/mcp/index.ts). When remote configuration is present — either the
 * WFT_API_URL environment variable is set or a `--remote <url>` flag is passed
 * — it launches the REMOTE HTTP bridge (src/mcp/remote/index.ts) instead, which
 * proxies every MCP tool to the backend REST API.
 */

export interface McpSelectionEnv {
  /** Base URL of the REST API; presence flips selection to the remote bridge. */
  WFT_API_URL?: string;
  /** Set when the user passed `--remote <url>`; treated like WFT_API_URL. */
  remote?: string;
}

/** Repo-relative module path to the local stdio MCP entry point. */
export const LOCAL_MCP_ENTRYPOINT = 'src/mcp/index.ts';
/** Repo-relative module path to the remote HTTP bridge entry point. */
export const REMOTE_MCP_ENTRYPOINT = 'src/mcp/remote/index.ts';

/**
 * Pure selection helper: decide which MCP entry point module to launch.
 *
 * Returns the remote bridge path when a remote URL is configured (via the
 * `--remote` flag, surfaced as `env.remote`, or the `WFT_API_URL` environment
 * variable), and the local stdio server path otherwise. Exported so unit tests
 * can assert dispatch for both env states WITHOUT spawning a real server.
 */
export function selectMcpEntrypoint(env: McpSelectionEnv): string {
  const remoteUrl = env.remote ?? env.WFT_API_URL;
  if (typeof remoteUrl === 'string' && remoteUrl.length > 0) {
    return REMOTE_MCP_ENTRYPOINT;
  }
  return LOCAL_MCP_ENTRYPOINT;
}

export const mcpCommand = new Command('mcp')
  .description('Launch the MCP server bridge (local stdio, or remote HTTP bridge)')
  .addHelpText(
    'after',
    `
Selection:
  By default this launches the LOCAL stdio MCP server (${LOCAL_MCP_ENTRYPOINT}).

  When remote configuration is present it launches the REMOTE HTTP bridge
  (${REMOTE_MCP_ENTRYPOINT}) instead, which proxies all MCP tools to the
  backend REST API over HTTP. Remote mode is selected when EITHER:
    - the WFT_API_URL environment variable is set, OR
    - the --remote <url> flag is provided (also sets WFT_API_URL).

Examples:
  tasks mcp                              Launch the local stdio MCP server
  WFT_API_URL=http://host:3000 tasks mcp Launch the remote HTTP bridge
  tasks mcp --remote http://host:3000    Launch the remote HTTP bridge
`
  )
  .option(
    '--remote <url>',
    'Launch the remote HTTP bridge against the given REST API base URL'
  )
  .action(async () => {
    const opts = mcpCommand.opts<{ remote?: string }>();

    const childEnv = { ...process.env };
    // A `--remote <url>` flag is shorthand for setting WFT_API_URL so the
    // remote bridge picks it up through its normal env contract.
    if (opts.remote) {
      childEnv.WFT_API_URL = opts.remote;
    }

    const entrypoint = selectMcpEntrypoint({
      WFT_API_URL: childEnv.WFT_API_URL,
      remote: opts.remote,
    });

    // Resolve the entrypoint relative to the repo root (this file lives at
    // src/cli/commands/, so the repo root is three levels up).
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '../../..');
    const target = resolve(repoRoot, entrypoint);

    const child = spawn(process.execPath, ['--import', 'tsx', target], {
      stdio: 'inherit',
      env: childEnv,
    });

    await new Promise<void>((resolveProc) => {
      child.on('exit', (code) => {
        process.exitCode = code ?? 0;
        resolveProc();
      });
      child.on('error', (err) => {
        process.stderr.write(`Failed to launch MCP server: ${err.message}\n`);
        process.exitCode = 1;
        resolveProc();
      });
    });
  });
