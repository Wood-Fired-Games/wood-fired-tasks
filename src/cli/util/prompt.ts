import { shouldPrompt } from '../prompts/interactive.js';

/**
 * Reusable, dependency-light TTY prompt primitives (task #804).
 *
 * Unlike the @clack/prompts-backed helpers in {@link ../prompts/interactive},
 * these functions take their input and output streams as INJECTED options so
 * they are fully unit-testable without a real TTY. Production callers omit the
 * streams and get `process.stdin` / `process.stdout` by default; tests pass a
 * {@link https://nodejs.org/api/stream.html#class-streampassthrough PassThrough}
 * (or any compatible duplex/readable+writable pair) and drive them
 * deterministically.
 *
 * TTY detection is delegated to {@link shouldPrompt} — we do NOT duplicate the
 * `--no-input` / `process.stdin.isTTY` logic here.
 */

/** Minimal readable surface we depend on (a subset of NodeJS.ReadableStream). */
export interface InputStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  pause?(): this;
  resume?(): this;
  setEncoding?(encoding: BufferEncoding): this;
}

/** Minimal writable surface we depend on (a subset of NodeJS.WritableStream). */
export interface OutputStream {
  write(chunk: string): boolean;
}

/** Shared injectable IO options. */
export interface PromptIO {
  /** Input stream to read from (default: `process.stdin`). */
  input?: InputStream;
  /** Output stream to write prompts to (default: `process.stdout`). */
  output?: OutputStream;
}

function resolveInput(io?: PromptIO): InputStream {
  return io?.input ?? (process.stdin as unknown as InputStream);
}

function resolveOutput(io?: PromptIO): OutputStream {
  return io?.output ?? (process.stdout as unknown as OutputStream);
}

/**
 * Read a single line of input from the given stream, resolving when the first
 * newline (`\n`, with an optional preceding `\r`) is seen or the stream ends.
 * The trailing newline is stripped from the returned value.
 *
 * @param prompt - Message written to the output stream before reading.
 * @param io - Injectable input/output streams (defaults to process streams).
 * @returns The typed line, sans trailing CR/LF.
 */
export function promptLine(prompt: string, io?: PromptIO): Promise<string> {
  const input = resolveInput(io);
  const output = resolveOutput(io);

  if (prompt.length > 0) {
    output.write(prompt);
  }

  return readLineFrom(input);
}

/**
 * Read a single line WITHOUT echoing the typed characters to the output stream.
 * Used for secrets (tokens, passwords). On a real TTY this disables terminal
 * echo via raw mode; in tests the fake input simply never gets echoed because
 * this function deliberately writes nothing about the typed characters back to
 * `output`.
 *
 * @param prompt - Message written to the output stream before reading (the
 *   prompt itself is shown; the SECRET the user types is not).
 * @param io - Injectable input/output streams (defaults to process streams).
 * @returns The typed secret, sans trailing CR/LF.
 */
export async function promptSecret(prompt: string, io?: PromptIO): Promise<string> {
  const input = resolveInput(io);
  const output = resolveOutput(io);

  if (prompt.length > 0) {
    output.write(prompt);
  }

  // On a real interactive terminal, suppress echo so the secret never renders.
  // We only touch raw mode when reading from the actual process stdin TTY; for
  // injected fake streams there is nothing to echo, so nothing to suppress.
  const maybeTty = input as unknown as {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const usedRawMode = maybeTty.isTTY === true && typeof maybeTty.setRawMode === 'function';

  if (usedRawMode) {
    maybeTty.setRawMode?.(true);
  }

  try {
    const secret = await readLineFrom(input);
    return secret;
  } finally {
    if (usedRawMode) {
      maybeTty.setRawMode?.(false);
      // Move to a fresh line since the user's Enter keypress was not echoed.
      output.write('\n');
    }
  }
}

/**
 * Present a numbered menu of options and resolve with the selected VALUE.
 *
 * Behaviour:
 *  - The prompt label and each option (1-indexed) are written to `output`.
 *  - A single line is read from `input`; it may be the 1-based index or the
 *    literal option label.
 *  - If `shouldPrompt()` reports a non-interactive environment AND no explicit
 *    input stream was injected, the `defaultValue` (or the first option) is
 *    returned without reading — so non-TTY callers never block.
 *  - An out-of-range / unrecognized selection falls back to `defaultValue` when
 *    provided, otherwise rejects.
 *
 * @typeParam T - The value type carried by each option.
 */
export async function selectFromMenu<T>(
  config: {
    /** Header line shown above the options. */
    message: string;
    /** The selectable options; `label` is shown, `value` is returned. */
    options: ReadonlyArray<{ label: string; value: T }>;
    /** Returned when non-interactive or on an empty selection. */
    defaultValue?: T;
  },
  io?: PromptIO,
): Promise<T> {
  const { message, options, defaultValue } = config;
  if (options.length === 0) {
    throw new Error('selectFromMenu requires at least one option');
  }

  const output = resolveOutput(io);

  // Non-interactive shortcut: only when the caller did NOT inject an input
  // stream (tests always inject one, so they still exercise the read path).
  if (io?.input === undefined && !shouldPrompt()) {
    return defaultValue !== undefined ? defaultValue : options[0]!.value;
  }

  if (message.length > 0) {
    output.write(`${message}\n`);
  }
  options.forEach((opt, i) => {
    output.write(`  ${i + 1}) ${opt.label}\n`);
  });
  output.write('> ');

  const input = resolveInput(io);
  const answer = (await readLineFrom(input)).trim();

  // Match by 1-based index first.
  if (/^\d+$/.test(answer)) {
    const idx = Number.parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < options.length) {
      return options[idx]!.value;
    }
  }

  // Then match by exact label.
  const byLabel = options.find((opt) => opt.label === answer);
  if (byLabel !== undefined) {
    return byLabel.value;
  }

  if (defaultValue !== undefined) {
    return defaultValue;
  }
  throw new Error(`Invalid selection: ${JSON.stringify(answer)}`);
}

/**
 * Resolve with the first line emitted by `input`. Accumulates chunks until a
 * newline is seen (stripping a trailing `\r\n` or `\n`); if the stream ends
 * first, resolves with whatever was buffered.
 */
function readLineFrom(input: InputStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    if (typeof input.setEncoding === 'function') {
      input.setEncoding('utf8');
    }
    input.resume?.();

    const cleanup = () => {
      input.removeListener('data', onData as (...args: never[]) => void);
      input.removeListener('end', onEnd as (...args: never[]) => void);
      input.removeListener('error', onError as (...args: never[]) => void);
      input.pause?.();
    };

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nlIdx = buffer.indexOf('\n');
      if (nlIdx !== -1) {
        let line = buffer.slice(0, nlIdx);
        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }
        finish(line);
      }
    };

    const onEnd = () => {
      // Stream closed without a trailing newline: return what we have.
      let line = buffer;
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      finish(line);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}
