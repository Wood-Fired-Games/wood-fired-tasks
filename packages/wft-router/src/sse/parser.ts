/**
 * Server-Sent Events (SSE) parser.
 *
 * Implements the wire format defined in the WHATWG HTML "Server-sent
 * events" section, scoped to the four fields the wft-router actually
 * consumes:
 *
 *   - `event:`  optional event name
 *   - `data:`   event payload (multiple `data:` lines in one block
 *                concatenate with `\n`, per spec)
 *   - `id:`     event id (drives Last-Event-Id resume; see
 *                docs/event-router-design.md §"Resume + cursor") WFT-NEUTRALITY-EXEMPT-LINE
 *   - `retry:`  optional client-side reconnect-delay hint (milliseconds)
 *
 * Lines beginning with `:` are SSE comments (commonly used as keep-alive
 * heartbeats) and are silently ignored. Both `\n` and `\r\n` line endings
 * are accepted — Node's `ReadableStream` text decoder may surface either.
 *
 * The parser is a feed-in / get-out function. The SSE client calls
 * `feed(chunk)` for every decoded text chunk arriving off the wire; every
 * event whose terminating blank line has been seen is returned in the
 * resulting array. Trailing partial data is held in an internal buffer
 * until the next `feed()` (or a final `flush()` at stream end).
 *
 * Pure-function design — no I/O, no clocks, no fetch. Trivially unit
 * testable.
 */

export interface SSEEvent {
  /** Event id; drives Last-Event-Id resume when non-empty. */
  id?: string;
  /** Optional event-name field (defaults to "message" if omitted). */
  event?: string;
  /** Concatenated data payload (multiple `data:` lines joined with `\n`). */
  data: string;
  /** Optional client-reconnect-delay hint in milliseconds. */
  retry?: number;
}

export interface SSEParser {
  /** Feed a decoded text chunk; returns any events completed by this chunk. */
  feed(chunk: string): SSEEvent[];
  /**
   * Force-complete any buffered partial event. Useful when the stream
   * closes without a final blank line. Returns the event if one was
   * pending, or an empty array otherwise.
   */
  flush(): SSEEvent[];
}

/**
 * Per-event accumulator. Reset after every blank-line dispatch.
 */
interface PendingEvent {
  id: string | undefined;
  event: string | undefined;
  dataLines: string[];
  retry: number | undefined;
  /** True once any recognised field has landed in this block. */
  hasField: boolean;
}

const NEW_BLOCK = (): PendingEvent => ({
  id: undefined,
  event: undefined,
  dataLines: [],
  retry: undefined,
  hasField: false,
});

/**
 * Create a fresh SSE parser. Each call returns an independent stateful
 * pair of `feed` and `flush` so two streams in the same process never
 * cross-talk.
 */
export function createSSEParser(): SSEParser {
  /** Bytes that arrived but didn't end in a newline yet. */
  let lineBuffer = '';
  let pending = NEW_BLOCK();

  const finalizeIfReady = (out: SSEEvent[]): void => {
    if (!pending.hasField) {
      // Blank line with no preceding fields = no event (keep-alive only).
      pending = NEW_BLOCK();
      return;
    }
    // Per spec, `data:` lines concatenate with \n. No data lines means
    // an empty-data event, which is still a valid event.
    const event: SSEEvent = { data: pending.dataLines.join('\n') };
    if (pending.id !== undefined) event.id = pending.id;
    if (pending.event !== undefined) event.event = pending.event;
    if (pending.retry !== undefined) event.retry = pending.retry;
    out.push(event);
    pending = NEW_BLOCK();
  };

  const processLine = (rawLine: string, out: SSEEvent[]): void => {
    // Strip trailing \r so CRLF and LF both terminate cleanly.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '') {
      finalizeIfReady(out);
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
      // Field with no value (per spec, the entire line is the field name).
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      // Per spec, a single leading space is stripped from the value.
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
      case 'id':
        // Per spec, an `id:` containing NUL is ignored; otherwise it sets
        // the event id even when the value is the empty string (which
        // explicitly clears the last-event-id at the client). We follow
        // the same rule.
        if (!value.includes('\0')) {
          pending.id = value;
          pending.hasField = true;
        }
        break;
      case 'retry': {
        // Per spec, only integer values are honoured.
        if (/^\d+$/.test(value)) {
          pending.retry = Number(value);
          pending.hasField = true;
        }
        break;
      }
      default:
        // Unknown field — silently ignore per spec.
        break;
    }
  };

  return {
    feed(chunk: string): SSEEvent[] {
      const out: SSEEvent[] = [];
      const combined = lineBuffer + chunk;
      // Split on \n; \r is stripped per-line above. The final element
      // is whatever follows the last \n (possibly empty) and is held
      // for the next feed.
      const parts = combined.split('\n');
      lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        processLine(line, out);
      }
      return out;
    },
    flush(): SSEEvent[] {
      const out: SSEEvent[] = [];
      if (lineBuffer.length > 0) {
        processLine(lineBuffer, out);
        lineBuffer = '';
      }
      // A graceful stream end can leave a complete event in `pending`
      // without a trailing blank line; finalize it.
      finalizeIfReady(out);
      return out;
    },
  };
}
