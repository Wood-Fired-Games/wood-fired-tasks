#!/usr/bin/env -S npx tsx
/**
 * webhook-bridge — reference wft-router adapter (vendor-neutral).
 *
 * Bridges `agent_session_dispatch` to an HTTP endpoint: it POSTs the event JSON
 * (read from stdin) to the URL given by the `url=` argv pair. This shows how to
 * do HTTP from adapter code when you want addressing (`target=`, `channel=`,
 * …) threaded through the adapter contract.
 *
 * For a plain HTTP sink you usually want the built-in `webhook_post` handler
 * instead — it has TLS/loopback posture guards and templating. This adapter is
 * a demonstration of the contract, not a replacement for that handler.
 *
 * Contract: event JSON on stdin; `with:` keys as `key=value` argv; exit 0 on a
 * 2xx response (non-zero triggers a router retry); first stdout line = session
 * id. An optional bearer token is read from the scrubbed env var
 * `WEBHOOK_BRIDGE_TOKEN` (declare it via the rule's `token_env`/`env:`).
 *
 * SECURITY: argv values are UNTRUSTED task content. This example forwards the
 * event body as-is and never interpolates argv into a shell.
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

  const url = pairs.url;
  if (url === undefined || url.length === 0) {
    console.error('[webhook-bridge] missing required `url=` argv pair');
    process.exit(1);
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.WEBHOOK_BRIDGE_TOKEN;
  if (token !== undefined && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, { method: 'POST', headers, body: event });
  console.error(`[webhook-bridge] POST ${url} -> ${res.status}`);
  if (!res.ok) {
    process.exit(1);
  }

  const target = pairs.target ?? 'default';
  process.stdout.write(`webhook-bridge-${target}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[webhook-bridge] failed: ${message}`);
  process.exit(1);
});
