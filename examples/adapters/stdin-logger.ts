#!/usr/bin/env -S npx tsx
/**
 * stdin-logger — reference wft-router adapter (vendor-neutral).
 *
 * The minimal `agent_session_dispatch` adapter: it reads the event JSON from
 * stdin, parses the `key=value` argv entries the router passes from the rule's
 * `with:` block, logs them to stderr, and prints an opaque session id on
 * stdout. Copy it as the skeleton for a real adapter.
 *
 * Contract: event JSON on stdin; `with:` keys as `key=value` argv; exit 0 =
 * success (non-zero triggers a router retry); the FIRST stdout line is captured
 * as the session id. Diagnostics therefore go to stderr, never stdout.
 *
 * SECURITY: argv values are UNTRUSTED task content. Never `eval` them, never
 * expand env vars from them, and validate length/charset before using a value
 * in a shell command. This example only echoes them.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseArgvPairs(argv: readonly string[]): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const entry of argv) {
    const eq = entry.indexOf('=');
    if (eq > 0) {
      pairs[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  return pairs;
}

async function main(): Promise<void> {
  const event = await readStdin();
  const pairs = parseArgvPairs(process.argv.slice(2));

  // Diagnostics go to stderr — stdout's first line is the captured session id.
  console.error(`[stdin-logger] argv pairs: ${JSON.stringify(pairs)}`);
  console.error(`[stdin-logger] event bytes: ${event.length}`);

  // A real adapter would return its actual session/channel identifier here.
  const target = pairs.target ?? 'default';
  process.stdout.write(`stdin-logger-${target}-${Date.now()}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[stdin-logger] failed: ${message}`);
  process.exit(1);
});
