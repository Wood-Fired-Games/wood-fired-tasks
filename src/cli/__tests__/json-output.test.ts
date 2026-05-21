/**
 * Unit tests for src/cli/output/json-output.ts (task #249).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  jsonOutput,
  jsonError,
  messageOutput,
} from '../output/json-output.js';

describe('jsonOutput', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('writes a success envelope with data field', () => {
    jsonOutput({ id: 1, name: 'thing' });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ id: 1, name: 'thing' });
  });

  it('includes metadata when provided', () => {
    jsonOutput([1, 2, 3], { count: 3, source: 'api' });

    const written = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.metadata).toEqual({ count: 3, source: 'api' });
  });

  it('emits trailing newline for line-based consumers', () => {
    jsonOutput({ ok: true });
    const written = stdoutSpy.mock.calls[0][0] as string;
    expect(written.endsWith('\n')).toBe(true);
  });

  it('pretty-prints output with 2-space indent', () => {
    jsonOutput({ a: 1, b: 2 });
    const written = stdoutSpy.mock.calls[0][0] as string;
    // Pretty output includes newlines between fields.
    expect(written.split('\n').length).toBeGreaterThan(2);
    expect(written).toContain('  ');
  });
});

describe('jsonError', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('writes a failure envelope with error message', () => {
    jsonError('something broke');
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toBe('something broke');
  });

  it('includes optional error code when provided', () => {
    jsonError('not found', 'ERR_NOT_FOUND');
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(parsed.error.code).toBe('ERR_NOT_FOUND');
  });

  it('omits explicit code when undefined', () => {
    jsonError('plain error');
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    // code property is present but undefined → JSON.stringify drops it.
    expect(parsed.error.code).toBeUndefined();
  });
});

describe('messageOutput', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTty: boolean | undefined;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    originalIsTty = process.stderr.isTTY;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    // Restore stderr.isTTY exactly as we found it (could be undefined).
    Object.defineProperty(process.stderr, 'isTTY', {
      value: originalIsTty,
      configurable: true,
    });
  });

  it('writes to stderr when stderr is a TTY', () => {
    Object.defineProperty(process.stderr, 'isTTY', {
      value: true,
      configurable: true,
    });
    messageOutput('hello');
    expect(stderrSpy).toHaveBeenCalledWith('hello\n');
  });

  it('suppresses output when stderr is not a TTY', () => {
    Object.defineProperty(process.stderr, 'isTTY', {
      value: false,
      configurable: true,
    });
    messageOutput('hello');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
