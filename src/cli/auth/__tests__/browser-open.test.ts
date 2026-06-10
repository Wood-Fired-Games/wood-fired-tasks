/**
 * Phase 30 Plan 06 Task 1 — Unit tests for the browser-open helper.
 *
 * Mocks `node:child_process.spawn` so the tests don't actually launch a
 * browser. Each test sets `process.platform` and `process.env.DISPLAY` to
 * exercise one branch of the dispatcher.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock factory must be a function literal (vitest hoists `vi.mock`).
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { openBrowser } from '../browser-open.js';

interface FakeChild {
  unref: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  return {
    unref: vi.fn(),
    on: vi.fn(),
  };
}

let origPlatform: NodeJS.Platform;
let origDisplay: string | undefined;
let origNoBrowser: string | undefined;

beforeEach(() => {
  origPlatform = process.platform;
  origDisplay = process.env.DISPLAY;
  // vitest.setup.ts sets WFT_NO_BROWSER=1 globally so no test launches a real
  // browser. THIS file is the one place that must exercise openBrowser's real
  // spawn dispatch, so opt out of the global guard for its tests.
  origNoBrowser = process.env.WFT_NO_BROWSER;
  delete process.env.WFT_NO_BROWSER;
  spawnMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: origPlatform });
  if (origDisplay === undefined) {
    delete process.env.DISPLAY;
  } else {
    process.env.DISPLAY = origDisplay;
  }
  if (origNoBrowser === undefined) {
    delete process.env.WFT_NO_BROWSER;
  } else {
    process.env.WFT_NO_BROWSER = origNoBrowser;
  }
});

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p });
}

describe('openBrowser', () => {
  it('spawns xdg-open on linux when DISPLAY is set and returns true', () => {
    setPlatform('linux');
    process.env.DISPLAY = ':0';
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);

    const ok = openBrowser('https://example.test/auth/device?user_code=ABCD-EFGH');

    expect(ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe('xdg-open');
    expect(args).toEqual(['https://example.test/auth/device?user_code=ABCD-EFGH']);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('returns false on linux when DISPLAY is unset (no spawn)', () => {
    setPlatform('linux');
    delete process.env.DISPLAY;

    const ok = openBrowser('https://example.test/');
    expect(ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns "open" on darwin and returns true', () => {
    setPlatform('darwin');
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);

    const ok = openBrowser('https://example.test/x');
    expect(ok).toBe(true);
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe('open');
    expect(args).toEqual(['https://example.test/x']);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('spawns "cmd /c start "" <url>" on win32 and returns true', () => {
    setPlatform('win32');
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);

    const ok = openBrowser('https://example.test/y');
    expect(ok).toBe(true);
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '""', 'https://example.test/y']);
  });

  it('returns false (no throw) when spawn itself throws', () => {
    setPlatform('darwin');
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn ENOENT');
    });

    const ok = openBrowser('https://example.test/z');
    expect(ok).toBe(false);
  });

  it('returns false on unknown platforms even when DISPLAY is set', () => {
    setPlatform('freebsd');
    process.env.DISPLAY = ':0';

    const ok = openBrowser('https://example.test/q');
    expect(ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('never sets shell:true (avoids shell injection via verification_uri)', () => {
    setPlatform('darwin');
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);

    openBrowser('https://example.test/safe');

    const opts = spawnMock.mock.calls[0]![2] as { shell?: boolean };
    // Either absent (Node defaults shell=false) or explicitly false; never true.
    expect(opts.shell === undefined || opts.shell === false).toBe(true);
  });

  // WR-03 (Phase 30 review) — URL validation gate.
  describe('URL validation (WR-03)', () => {
    it('returns false WITHOUT spawning when URL is unparseable', () => {
      setPlatform('darwin');
      const ok = openBrowser('not-a-url');
      expect(ok).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns false WITHOUT spawning for non-http(s) protocols (file:)', () => {
      setPlatform('darwin');
      const ok = openBrowser('file:///etc/passwd');
      expect(ok).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns false WITHOUT spawning for javascript: URLs', () => {
      setPlatform('darwin');
      const ok = openBrowser('javascript:alert(1)');
      expect(ok).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns false WITHOUT spawning for Windows cmd-injection attempt', () => {
      // Simulates a malicious server returning a verification_uri_complete
      // containing embedded double quotes designed to escape libuv's WinAPI
      // arg quoting and inject `& calc &` as a separate cmd statement. The
      // round-trip equality check rejects this BEFORE the URL ever reaches
      // the spawn call.
      setPlatform('win32');
      // eslint-disable-next-line no-script-url
      const malicious = 'http://x" & calc & "';
      const ok = openBrowser(malicious);
      expect(ok).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns false WITHOUT spawning for URL whose toString() does not round-trip', () => {
      setPlatform('darwin');
      // Unencoded whitespace — URL parser normalizes to %20, breaking the
      // round-trip check.
      const sneaky = 'http://example.test/path with space';
      const ok = openBrowser(sneaky);
      expect(ok).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('accepts a well-formed verification_uri_complete', () => {
      setPlatform('darwin');
      const child = makeFakeChild();
      spawnMock.mockReturnValueOnce(child);
      const ok = openBrowser('https://example.test/auth/device?user_code=ABCDEFGH');
      expect(ok).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });
});
