import { Command } from 'commander';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveAssetPath } from '../../assets/resolve.js';

/**
 * `tasks docs` (task #749).
 *
 * Frictionless access to the user-facing guides shipped in the npm tarball.
 * Every guide is resolved via the #730 asset resolver (`resolveAssetPath`),
 * which locates the package root from `import.meta.url` — NOT the caller's
 * working directory. So `tasks docs show usage-patterns` prints the real
 * bundled guide from any cwd, including from inside `node_modules/` after a
 * global install.
 *
 * Subcommands:
 *   docs list            enumerate the bundled guides (friendly name -> file)
 *   docs show <name>     print a guide to stdout
 *   docs path [<name>]   print a guide's on-disk path (or the docs/ dir)
 *   docs open <name>     open a guide with the platform default app (no sudo)
 */

/**
 * Static catalog mapping a friendly guide name to its bundled filename under
 * the package-root `docs/` directory. Limited to docs guaranteed present in
 * `package.json` `files` so a lookup never 404s on a published install.
 */
export const DOCS_CATALOG: Record<string, string> = {
  'usage-patterns': 'USAGE_PATTERNS.md',
  setup: 'SETUP.md',
  cli: 'CLI.md',
  api: 'API.md',
  mcp: 'MCP.md',
  navigation: 'NAVIGATION.md',
  interfaces: 'INTERFACES.md',
  workflows: 'WORKFLOWS.md',
  slack: 'SLACK.md',
  reliability: 'RELIABILITY.md',
  troubleshooting: 'TROUBLESHOOTING.md',
  architecture: 'ARCHITECTURE.md',
  readme: 'README.md',
  'agent-context': 'AGENT_CONTEXT.md',
};

/** Friendly guide names, sorted for stable enumeration. */
export function docNames(): string[] {
  return Object.keys(DOCS_CATALOG).sort();
}

/**
 * Resolve the absolute on-disk path to a bundled guide via the asset resolver
 * (package root, NOT cwd). Throws on an unknown friendly name.
 */
export function resolveDocPath(name: string): string {
  const file = DOCS_CATALOG[name];
  if (!file) {
    throw new Error(`Unknown doc '${name}'. Known: ${docNames().join(', ')}`);
  }
  return resolveAssetPath('docs', file);
}

/** Absolute path to the bundled `docs/` directory at the package root. */
export function docsDir(): string {
  return resolveAssetPath('docs');
}

export interface DocEntry {
  name: string;
  file: string;
  path: string;
  exists: boolean;
}

/** Build the catalog as resolved entries (path + existence), sorted by name. */
export function listDocs(): DocEntry[] {
  return docNames().map((name) => {
    const docPath = resolveDocPath(name);
    return {
      name,
      file: DOCS_CATALOG[name],
      path: docPath,
      exists: fs.existsSync(docPath),
    };
  });
}

/** Read a bundled guide's full text content (resolved via the asset resolver). */
export function readDoc(name: string): string {
  const docPath = resolveDocPath(name);
  if (!fs.existsSync(docPath)) {
    throw new Error(`Doc file not found on disk: ${docPath}`);
  }
  return fs.readFileSync(docPath, 'utf8');
}

/** A command + args pair an opener runner is asked to execute. */
export type OpenRunner = (cmd: string, args: string[]) => void;

const ELEVATION = /^(sudo|runas|pkexec|doas)$/i;

/**
 * Pick the cross-platform "open with default app" command for a file path.
 *   darwin -> `open <path>`
 *   win32  -> `cmd /c start "" <path>`
 *   else   -> `xdg-open <path>`
 * NEVER returns an elevated command.
 */
export function openCommandFor(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') {
    return { cmd: 'open', args: [filePath] };
  }
  if (platform === 'win32') {
    // `start` is a cmd builtin; the empty "" is the window-title placeholder.
    return { cmd: 'cmd', args: ['/c', 'start', '', filePath] };
  }
  return { cmd: 'xdg-open', args: [filePath] };
}

/**
 * Open a bundled guide with the OS default application. The runner is
 * injectable so tests assert the chosen opener without launching anything.
 * Hard-guards against elevated commands under all circumstances.
 */
export function openDoc(
  name: string,
  options: {
    platform?: NodeJS.Platform;
    runner?: OpenRunner;
  } = {},
): { cmd: string; args: string[]; path: string } {
  const docPath = resolveDocPath(name);
  if (!fs.existsSync(docPath)) {
    throw new Error(`Doc file not found on disk: ${docPath}`);
  }
  const { cmd, args } = openCommandFor(docPath, options.platform);

  // Hard guard: never elevate, regardless of platform mapping.
  if (ELEVATION.test(cmd)) {
    throw new Error('refusing to run elevated command');
  }

  const runner: OpenRunner =
    options.runner ??
    ((c, a) => {
      if (ELEVATION.test(c)) {
        throw new Error('refusing to run elevated command');
      }
      execFileSync(c, a, { stdio: 'ignore' });
    });

  runner(cmd, args);
  return { cmd, args, path: docPath };
}

export const docsCommand = new Command('docs')
  .description('Browse the bundled wood-fired-tasks guides (list/show/path/open)')
  .addHelpText(
    'after',
    `
Subcommands:
  docs list            List the bundled guides (friendly name -> file)
  docs show <name>     Print a guide to stdout
  docs path [<name>]   Print a guide's on-disk path (or the docs/ directory)
  docs open <name>     Open a guide with the platform default app (no sudo)

Guides are resolved from the package root (where the tarball ships them), NOT
the current working directory — so these work from anywhere.

Examples:
  tasks docs list
  tasks docs show usage-patterns
  tasks docs path cli
  tasks docs open setup
`,
  );

docsCommand
  .command('list')
  .description('List the bundled guides')
  .action(() => {
    const entries = listDocs().filter((e) => e.exists);
    const width = entries.reduce((m, e) => Math.max(m, e.name.length), 0);
    for (const e of entries) {
      console.log(`${e.name.padEnd(width)}  ${e.file}`);
    }
  });

docsCommand
  .command('show')
  .description('Print a bundled guide to stdout')
  .argument('<name>', `guide name (one of: ${docNames().join(', ')})`)
  .action((name: string) => {
    process.stdout.write(readDoc(name));
  });

docsCommand
  .command('path')
  .description("Print a guide's on-disk path (or the docs/ directory)")
  .argument('[name]', `guide name (one of: ${docNames().join(', ')})`)
  .action((name?: string) => {
    console.log(name ? resolveDocPath(name) : docsDir());
  });

docsCommand
  .command('open')
  .description('Open a bundled guide with the OS default application')
  .argument('<name>', `guide name (one of: ${docNames().join(', ')})`)
  .action((name: string) => {
    const { cmd, args, path } = openDoc(name);
    console.log(`Opening ${path} (${[cmd, ...args].join(' ')})`);
  });
