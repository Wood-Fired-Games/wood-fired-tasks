import { describe, it, expect } from 'vitest';
import { pathHint, resolveNpmBinDir } from '../util/path-hint.js';

describe('pathHint', () => {
  it('(a) posix dir ON PATH → hash -r hint', () => {
    const out = pathHint({
      platform: 'linux',
      pathEnv: '/usr/bin:/home/u/.npm-global/bin:/bin',
      npmBinDir: '/home/u/.npm-global/bin',
      shell: '/bin/bash',
    });
    expect(out).not.toBeNull();
    expect(out).toContain('hash -r');
    expect(out).not.toContain('export PATH');
  });

  it('(a2) posix ON PATH tolerates trailing slash', () => {
    const out = pathHint({
      platform: 'darwin',
      pathEnv: '/opt/homebrew/bin:/usr/local/bin/',
      npmBinDir: '/usr/local/bin',
      shell: '/bin/zsh',
    });
    expect(out).toContain('hash -r');
  });

  it('(b) posix dir NOT on PATH → export/source hint', () => {
    const out = pathHint({
      platform: 'linux',
      pathEnv: '/usr/bin:/bin',
      npmBinDir: '/home/u/.npm-global/bin',
      shell: '/bin/bash',
    });
    expect(out).not.toBeNull();
    expect(out).toContain('export PATH="/home/u/.npm-global/bin:$PATH"');
    expect(out).toContain('~/.bashrc');
  });

  it('(b2) posix NOT on PATH with zsh → mentions ~/.zshrc', () => {
    const out = pathHint({
      platform: 'darwin',
      pathEnv: '/usr/bin',
      npmBinDir: '/Users/u/.npm-global/bin',
      shell: '/usr/bin/zsh',
    });
    expect(out).toContain('~/.zshrc');
  });

  it('(c) win32 dir ON PATH → null', () => {
    const out = pathHint({
      platform: 'win32',
      pathEnv: 'C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm',
      npmBinDir: 'C:\\Users\\u\\AppData\\Roaming\\npm',
    });
    expect(out).toBeNull();
  });

  it('(c2) win32 ON PATH is case-insensitive + trailing-slash tolerant', () => {
    const out = pathHint({
      platform: 'win32',
      pathEnv: 'C:\\Windows;c:\\users\\u\\appdata\\roaming\\npm\\',
      npmBinDir: 'C:\\Users\\U\\AppData\\Roaming\\npm',
    });
    expect(out).toBeNull();
  });

  it('(d) win32 dir NOT on PATH → PowerShell refresh hint', () => {
    const out = pathHint({
      platform: 'win32',
      pathEnv: 'C:\\Windows;C:\\Windows\\System32',
      npmBinDir: 'C:\\Users\\u\\AppData\\Roaming\\npm',
    });
    expect(out).not.toBeNull();
    expect(out).toContain("$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine')");
    expect(out).toContain('cmd.exe');
  });

  it('(e) unresolvable input (empty bin dir) → null', () => {
    expect(pathHint({ platform: 'linux', pathEnv: '/usr/bin', npmBinDir: '' })).toBeNull();
    expect(pathHint({ platform: 'linux', pathEnv: '/usr/bin', npmBinDir: '   ' })).toBeNull();
  });

  it('(e2) undefined PATH on posix → treated as NOT on path', () => {
    const out = pathHint({
      platform: 'linux',
      pathEnv: undefined,
      npmBinDir: '/home/u/.npm-global/bin',
    });
    expect(out).toContain('export PATH');
  });
});

describe('resolveNpmBinDir', () => {
  it('uses npm_config_prefix on posix → <prefix>/bin', () => {
    expect(resolveNpmBinDir({ platform: 'linux', npmConfigPrefix: '/home/u/.npm-global' })).toBe(
      '/home/u/.npm-global/bin',
    );
  });

  it('uses npm_config_prefix on win32 → prefix dir itself', () => {
    expect(
      resolveNpmBinDir({
        platform: 'win32',
        npmConfigPrefix: 'C:\\Users\\u\\AppData\\Roaming\\npm',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\npm');
  });

  it('derives prefix from module dir on posix (lib/node_modules layout)', () => {
    expect(
      resolveNpmBinDir({
        platform: 'linux',
        npmConfigPrefix: undefined,
        moduleDir: '/home/u/.npm-global/lib/node_modules/wood-fired-tasks/dist/cli/util',
      }),
    ).toBe('/home/u/.npm-global/bin');
  });

  it('returns null when no node_modules in module dir and no prefix', () => {
    expect(
      resolveNpmBinDir({
        platform: 'linux',
        npmConfigPrefix: undefined,
        moduleDir: '/some/random/path',
      }),
    ).toBeNull();
  });
});
