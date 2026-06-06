import { describe, it, expect } from 'vitest';
import { buildNpmInvocation, npmBin, quoteWin32Arg } from '../npm-spawn.js';

/**
 * Task #794: npm must be invoked safely on Windows. Two hazards, one helper:
 *   - npm.cmd cannot be spawned without a shell (CVE-2024-27980 → EINVAL).
 *   - a `shell:true` invocation splits args containing spaces unless quoted.
 *
 * The `setup --fix-npm-prefix` arg vector carries the user's home path, which
 * on Windows can contain spaces (C:\Users\John Doe\...). These tests pin the
 * well-formed invocation for that exact vector on win32, plus the no-op POSIX
 * behavior and the self-update constant-arg vector.
 */
describe('npm-spawn helper', () => {
  it('npmBin is npm.cmd on win32 and npm elsewhere', () => {
    expect(npmBin('win32')).toBe('npm.cmd');
    expect(npmBin('linux')).toBe('npm');
    expect(npmBin('darwin')).toBe('npm');
  });

  describe('quoteWin32Arg', () => {
    it('leaves space-free, metacharacter-free args untouched', () => {
      expect(quoteWin32Arg('config')).toBe('config');
      expect(quoteWin32Arg('wood-fired-tasks@latest')).toBe('wood-fired-tasks@latest');
      expect(quoteWin32Arg('C:\\Users\\jdoe\\.npm-global')).toBe('C:\\Users\\jdoe\\.npm-global');
    });

    it('double-quotes args containing spaces', () => {
      expect(quoteWin32Arg('C:\\Users\\John Doe\\.npm-global')).toBe(
        '"C:\\Users\\John Doe\\.npm-global"',
      );
    });

    it('quotes shell metacharacters and escapes embedded quotes', () => {
      expect(quoteWin32Arg('a&b')).toBe('"a&b"');
      expect(quoteWin32Arg('a"b')).toBe('"a""b"');
      expect(quoteWin32Arg('')).toBe('""');
    });
  });

  describe('buildNpmInvocation — fix-npm-prefix vector with a spaced home', () => {
    const args = ['config', 'set', 'prefix', 'C:\\Users\\John Doe\\.npm-global'];

    it('on win32: uses npm.cmd through a shell with the prefix quoted (no EINVAL, no split)', () => {
      const inv = buildNpmInvocation(args, 'win32');
      expect(inv.command).toBe('npm.cmd');
      expect(inv.shell).toBe(true);
      expect(inv.args).toEqual(['config', 'set', 'prefix', '"C:\\Users\\John Doe\\.npm-global"']);
      // The shelled command line keeps the spaced path as a single token.
      const line = `${inv.command} ${inv.args.join(' ')}`;
      expect(line).toBe('npm.cmd config set prefix "C:\\Users\\John Doe\\.npm-global"');
    });

    it('on linux/macOS: plain shell-less npm, args untouched', () => {
      for (const platform of ['linux', 'darwin'] as const) {
        const inv = buildNpmInvocation(args, platform);
        expect(inv.command).toBe('npm');
        expect(inv.shell).toBe(false);
        expect(inv.args).toEqual(args);
      }
    });
  });

  describe('buildNpmInvocation — self-update constant vector', () => {
    const args = ['i', '-g', 'wood-fired-tasks@latest'];

    it('on win32: npm.cmd + shell, no quoting needed (no spaces)', () => {
      const inv = buildNpmInvocation(args, 'win32');
      expect(inv).toEqual({ command: 'npm.cmd', args, shell: true });
    });

    it('elsewhere: npm, no shell', () => {
      const inv = buildNpmInvocation(args, 'linux');
      expect(inv).toEqual({ command: 'npm', args, shell: false });
    });
  });
});
