/**
 * Tests for src/cli/util/prompt.ts (task #804).
 *
 * Each function takes injectable input/output streams, so we drive them with
 * `stream.PassThrough` and never touch a real TTY. We assert:
 *  - selectFromMenu returns the value of the chosen option (by index and label)
 *  - promptLine returns the typed line (CR/LF stripped)
 *  - promptSecret returns the secret but writes NO echo of it to the output
 */
import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { promptLine, promptSecret, selectFromMenu } from './prompt.js';

/** Build a fresh input/output pair backed by PassThrough streams. */
function makeIO(): { input: PassThrough; output: PassThrough; written: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (chunk: Buffer) => {
    captured += chunk.toString('utf8');
  });
  return { input, output, written: () => captured };
}

describe('selectFromMenu', () => {
  it('returns the selected value when chosen by 1-based index', async () => {
    const { input, output } = makeIO();
    const promise = selectFromMenu(
      {
        message: 'Pick a color',
        options: [
          { label: 'Red', value: 'red' },
          { label: 'Green', value: 'green' },
          { label: 'Blue', value: 'blue' },
        ],
      },
      { input, output },
    );

    input.write('2\n');
    const selected = await promise;
    expect(selected).toBe('green');
  });

  it('returns the selected value when chosen by exact label', async () => {
    const { input, output } = makeIO();
    const promise = selectFromMenu(
      {
        message: 'Pick',
        options: [
          { label: 'alpha', value: 1 },
          { label: 'beta', value: 2 },
        ],
      },
      { input, output },
    );

    input.write('beta\n');
    expect(await promise).toBe(2);
  });

  it('renders each option with a 1-based index to the output stream', async () => {
    const { input, output, written } = makeIO();
    const promise = selectFromMenu(
      {
        message: 'Menu',
        options: [
          { label: 'first', value: 'a' },
          { label: 'second', value: 'b' },
        ],
      },
      { input, output },
    );
    input.write('1\n');
    await promise;
    expect(written()).toContain('1) first');
    expect(written()).toContain('2) second');
  });

  it('falls back to defaultValue on an out-of-range selection', async () => {
    const { input, output } = makeIO();
    const promise = selectFromMenu(
      {
        message: 'Pick',
        options: [{ label: 'only', value: 'only' }],
        defaultValue: 'only',
      },
      { input, output },
    );
    input.write('99\n');
    expect(await promise).toBe('only');
  });

  it('rejects on an invalid selection with no defaultValue', async () => {
    const { input, output } = makeIO();
    const promise = selectFromMenu(
      {
        message: 'Pick',
        options: [{ label: 'only', value: 'only' }],
      },
      { input, output },
    );
    input.write('nope\n');
    await expect(promise).rejects.toThrow(/Invalid selection/);
  });

  it('throws synchronously when given no options', async () => {
    await expect(selectFromMenu({ message: 'x', options: [] }, makeIO())).rejects.toThrow(
      /at least one option/,
    );
  });
});

describe('promptLine', () => {
  it('returns the typed line and writes the prompt', async () => {
    const { input, output, written } = makeIO();
    const promise = promptLine('Name: ', { input, output });
    input.write('Ada Lovelace\n');
    expect(await promise).toBe('Ada Lovelace');
    expect(written()).toBe('Name: ');
  });

  it('strips a trailing CRLF', async () => {
    const { input, output } = makeIO();
    const promise = promptLine('', { input, output });
    input.write('windows-style\r\n');
    expect(await promise).toBe('windows-style');
  });

  // #856: raw mode (used by promptSecret on a real TTY) disables CR→LF
  // translation, so the Enter key delivers a BARE `\r` with no following `\n`.
  // readLineFrom previously terminated only on `\n`, so the read hung forever.
  it('terminates on a BARE CR (raw-mode Enter) and strips it', async () => {
    const { input, output } = makeIO();
    const promise = promptLine('', { input, output });
    input.write('raw-mode-line\r');
    expect(await promise).toBe('raw-mode-line');
  });
});

describe('promptSecret', () => {
  it('returns the typed secret', async () => {
    const { input, output } = makeIO();
    const promise = promptSecret('Token: ', { input, output });
    input.write('s3cr3t-token\n');
    expect(await promise).toBe('s3cr3t-token');
  });

  it('does NOT echo the typed secret to the output stream', async () => {
    const { input, output, written } = makeIO();
    const secret = 'do-not-leak-me';
    const promise = promptSecret('Token: ', { input, output });
    input.write(`${secret}\n`);
    await promise;

    // The prompt label is allowed; the secret characters must never appear.
    expect(written()).toBe('Token: ');
    expect(written()).not.toContain(secret);
  });

  // #856: a pasted PAT followed by a bare-CR Enter (the raw-mode keypress) must
  // resolve, not hang. This is the exact shape that wedged `tasks setup` /
  // `tasks login` manual-PAT entry on a real terminal.
  it('returns a secret terminated by a bare CR (the raw-mode hang regression)', async () => {
    const { input, output } = makeIO();
    const promise = promptSecret('Paste a personal access token: ', { input, output });
    input.write('wft_pat_FAKE\r');
    expect(await promise).toBe('wft_pat_FAKE');
  });
});
