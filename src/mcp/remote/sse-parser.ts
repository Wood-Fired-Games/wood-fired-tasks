/**
 * Minimal Server-Sent Events (SSE) frame parser for the remote MCP server.
 *
 * Reimplemented locally (task #481) rather than importing the wft-router
 * package's parser — that package is a standalone build with its own
 * dependency graph, and the remote MCP client must stay importable from a
 * minimal stdio subprocess (same constraint that duplicates the PAT prefix
 * constant in `rest-client.ts`). The semantics here mirror the WHATWG HTML
 * "Server-sent events" wire format, scoped to the two fields the remote
 * `wait_for_unblock` tool consumes off `GET /api/v1/events`:
 *
 *   - `event:` optional event name
 *   - `data:`  payload (multiple `data:` lines in one block join with `\n`)
 *
 * `id:` / `retry:` are parsed and ignored — the wait tool does not resume a
 * cursor (it opens a fresh stream per call). Lines beginning with `:` are SSE
 * comments / keep-alive heartbeats and are silently dropped. Both `\n` and
 * `\r\n` line endings are accepted.
 *
 * Feed-in / get-out design: call `feed(chunk)` for every decoded text chunk
 * arriving off the wire; each event whose terminating blank line has been
 * seen is returned. Trailing partial data is held until the next `feed()`.
 * Pure function, no I/O.
 */

export interface RemoteSSEEvent {
  /** Optional event-name field (defaults to "message" if omitted). */
  event?: string;
  /** Concatenated data payload (multiple `data:` lines joined with `\n`). */
  data: string;
}

export interface RemoteSSEParser {
  /** Feed a decoded text chunk; returns any events completed by this chunk. */
  feed(chunk: string): RemoteSSEEvent[];
}

interface PendingBlock {
  event: string | undefined;
  dataLines: string[];
  hasField: boolean;
}

const newBlock = (): PendingBlock => ({
  event: undefined,
  dataLines: [],
  hasField: false,
});

/**
 * Create a fresh, independent SSE parser. Each call returns its own stateful
 * `feed` so two streams in the same process never cross-talk.
 */
export function createRemoteSSEParser(): RemoteSSEParser {
  let lineBuffer = '';
  let pending = newBlock();

  const finalize = (out: RemoteSSEEvent[]): void => {
    if (!pending.hasField) {
      // Blank line with no preceding fields = keep-alive only, no event.
      pending = newBlock();
      return;
    }
    const event: RemoteSSEEvent = { data: pending.dataLines.join('\n') };
    if (pending.event !== undefined) event.event = pending.event;
    out.push(event);
    pending = newBlock();
  };

  const processLine = (rawLine: string, out: RemoteSSEEvent[]): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '') {
      finalize(out);
      return;
    }
    if (line.startsWith(':')) {
      // SSE comment / keep-alive — ignore.
      return;
    }

    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      // Per spec, strip a single leading space from the value.
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'event':
        pending.event = value;
        pending.hasField = true;
        break;
      case 'data':
        pending.dataLines.push(value);
        pending.hasField = true;
        break;
      // `id:` / `retry:` are intentionally ignored — the wait tool does not
      // resume a cursor. Unknown fields are dropped per spec.
      default:
        break;
    }
  };

  return {
    feed(chunk: string): RemoteSSEEvent[] {
      const out: RemoteSSEEvent[] = [];
      const combined = lineBuffer + chunk;
      const parts = combined.split('\n');
      // The final element is whatever follows the last \n (held for next feed).
      lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        processLine(line, out);
      }
      return out;
    },
  };
}
