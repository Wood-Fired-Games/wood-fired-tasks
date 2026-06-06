/**
 * Tests for the wft-router templating renderer (task #426).
 *
 * Coverage matches the acceptance criterion "template.test.ts covers each
 * of the 6 rules with positive + negative cases". Each rule has a dedicated
 * describe block with at least two assertions (one allowed, one rejected
 * or modified). All vendor-neutral — no provider, AI vendor, chat platform,
 * or CI name appears in titles, comments, or fixtures.
 */

import { describe, expect, it } from 'vitest';

import { renderWith, TemplatingError, type TemplateLogger } from '../template.js';
import type { EventPayloadShape } from '../predicate.js';
import { redactForLogging } from '../../util/redaction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Captures WARN payloads emitted by the renderer so individual assertions
 * can pin both the message and the fields without coupling to console.
 */
function makeRecordingLogger(): {
  logger: TemplateLogger;
  warns: Array<{ msg: string; fields?: Record<string, unknown> }>;
} {
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: TemplateLogger = {
    warn(msg, fields) {
      warns.push({ msg, fields });
    },
  };
  return { logger, warns };
}

/** Default event used by most tests. */
function makeEvent(overrides: Partial<EventPayloadShape> = {}): EventPayloadShape {
  return {
    type: 'task.updated',
    task: {
      id: 42,
      project_id: 7,
      project_slug: 'sample',
      status: 'open',
      tags: ['urgent'],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule 1 — Substitution position (defensive re-check at runtime)
// ---------------------------------------------------------------------------

describe('Rule 1 — substitution position', () => {
  it('accepts a pure substitution (entire string is the token)', () => {
    const out = renderWith({ title: '{{task.project_slug}}' }, makeEvent());
    expect(out).toEqual({ title: 'sample' });
  });

  it('rejects mixed substitution at runtime with TemplatingError', () => {
    expect(() => renderWith({ title: 'prefix-{{task.project_slug}}' }, makeEvent())).toThrow(
      TemplatingError,
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — Encoding via type preservation
// ---------------------------------------------------------------------------

describe('Rule 2 — encoding via type preservation', () => {
  it('preserves a numeric value as a number, not a string', () => {
    const out = renderWith({ id: '{{task.id}}' }, makeEvent());
    expect(out).toEqual({ id: 42 });
    expect(typeof (out as Record<string, unknown>).id).toBe('number');
  });

  it('preserves embedded quotes verbatim (JSON round-trips cleanly)', () => {
    const event = makeEvent({
      task: { id: 1, status: 'open', tags: [], title: 'hello "world"' } as never,
    });
    const out = renderWith({ message: '{{task.title}}' }, event);
    const roundTripped = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    expect(roundTripped.message).toBe('hello "world"');
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — Length cap at 4 KiB UTF-8 bytes
// ---------------------------------------------------------------------------

describe('Rule 3 — length cap', () => {
  it('truncates an oversize string to <head>…<tail> and WARN-logs', () => {
    const big = 'A'.repeat(8192); // 8 KiB ASCII
    const event = makeEvent({
      task: { id: 1, status: 'open', tags: [], summary: big } as never,
    });
    const { logger, warns } = makeRecordingLogger();
    const out = renderWith({ body: '{{task.summary}}' }, event, { logger }) as Record<
      string,
      unknown
    >;

    const rendered = out.body as string;
    expect(typeof rendered).toBe('string');
    expect(rendered.includes('…')).toBe(true);
    expect(rendered.startsWith('A')).toBe(true);
    expect(rendered.endsWith('A')).toBe(true);

    // Bytes: 2048 (head) + 3 (ellipsis '…' is 3 UTF-8 bytes) + 2048 (tail) = 4099
    const ellipsisBytes = Buffer.byteLength('…', 'utf8');
    expect(Buffer.byteLength(rendered, 'utf8')).toBe(2048 + ellipsisBytes + 2048);

    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe('templating_truncated');
    expect(warns[0]?.fields?.original_bytes).toBe(8192);
    expect(warns[0]?.fields?.with_path).toBe('with.body');
  });

  it('passes through a string under the cap with no WARN', () => {
    const small = 'A'.repeat(100);
    const event = makeEvent({
      task: { id: 1, status: 'open', tags: [], summary: small } as never,
    });
    const { logger, warns } = makeRecordingLogger();
    const out = renderWith({ body: '{{task.summary}}' }, event, { logger });
    expect(out).toEqual({ body: small });
    expect(warns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — Chat-handler control-character strip
// ---------------------------------------------------------------------------

describe('Rule 4 — chat-control strip', () => {
  it('strips <!, <@, <# prefixes when stripChatControls is true', () => {
    const event = makeEvent({
      task: {
        id: 1,
        status: 'open',
        tags: [],
        note: '<!channel> <@U123> <#C456> hello',
      } as never,
    });
    const out = renderWith({ body: '{{task.note}}' }, event, { stripChatControls: true });
    expect(out).toEqual({ body: 'channel> U123> C456> hello' });
  });

  it('leaves control sequences intact when stripChatControls is false (default)', () => {
    const original = '<!channel> hello';
    const event = makeEvent({
      task: { id: 1, status: 'open', tags: [], note: original } as never,
    });
    const out = renderWith({ body: '{{task.note}}' }, event);
    expect(out).toEqual({ body: original });
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — Null on miss
// ---------------------------------------------------------------------------

describe('Rule 5 — null on miss', () => {
  it('substitutes JSON null and WARN-logs when the path misses', () => {
    const { logger, warns } = makeRecordingLogger();
    const out = renderWith({ released: '{{task.metadata.released_version}}' }, makeEvent(), {
      logger,
    });
    expect(out).toEqual({ released: null });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe('templating_miss');
    expect(warns[0]?.fields?.token_path).toBe('task.metadata.released_version');
    expect(warns[0]?.fields?.with_path).toBe('with.released');
  });

  it('does NOT WARN-log when the path resolves cleanly', () => {
    const { logger, warns } = makeRecordingLogger();
    const out = renderWith({ slug: '{{task.project_slug}}' }, makeEvent(), {
      logger,
    });
    expect(out).toEqual({ slug: 'sample' });
    expect(warns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — Redaction is log-only (handler delivery stays verbatim)
// ---------------------------------------------------------------------------

describe('Rule 6 — sensitive-key redaction is log-only', () => {
  it('renders the raw value into the handler-delivery output', () => {
    const event = makeEvent({
      task: { id: 1, status: 'open', tags: [], token: 'Bearer xyz' } as never,
    });
    const out = renderWith({ authorization: '{{task.token}}' }, event);
    expect(out).toEqual({ authorization: 'Bearer xyz' });
  });

  it('redacts only when the rendered output is passed through redactForLogging', () => {
    const event = makeEvent({
      task: { id: 1, status: 'open', tags: [], token: 'Bearer xyz' } as never,
    });
    const out = renderWith({ authorization: '{{task.token}}' }, event);
    expect(out).toEqual({ authorization: 'Bearer xyz' });

    const forLog = redactForLogging(out);
    expect(forLog).toEqual({ authorization: '***' });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting behaviour
// ---------------------------------------------------------------------------

describe('renderWith — cross-cutting', () => {
  it('walks nested objects and arrays', () => {
    const out = renderWith(
      {
        outer: {
          inner: '{{task.project_slug}}',
          list: ['static', '{{task.id}}'],
        },
      },
      makeEvent(),
    );
    expect(out).toEqual({
      outer: {
        inner: 'sample',
        list: ['static', 42],
      },
    });
  });

  it('does NOT mutate the input withBlock', () => {
    const input = { title: '{{task.project_slug}}' };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    renderWith(input, makeEvent());
    expect(input).toEqual(snapshot);
  });

  it('leaves non-template strings untouched', () => {
    const out = renderWith({ label: 'literal-value' }, makeEvent());
    expect(out).toEqual({ label: 'literal-value' });
  });

  it('preserves non-string primitives as-is', () => {
    const out = renderWith({ count: 5, enabled: true, optional: null }, makeEvent());
    expect(out).toEqual({ count: 5, enabled: true, optional: null });
  });
});
