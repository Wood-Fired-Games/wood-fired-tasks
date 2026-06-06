import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runSetup, buildRemoteMcpEntry, commandsDestDir, patCachePath } from '../commands/setup.js';
import { resolveAssetPath } from '../../assets/resolve.js';
import { dataDir } from '../../config/paths.js';

const tasksSkillsDir = resolveAssetPath('dist', 'skills', 'tasks');

// A FAKE token — never a real secret.
const FAKE_PAT = 'wft_pat_FAKE_TEST_TOKEN_0123456789';
const REMOTE_URL = 'http://tasks.example.local:3000';

function withSandbox<T>(fn: (home: string, configDir: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-home-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-cfg-'));
  try {
    return fn(home, configDir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

describe('tasks setup --remote', () => {
  it('writes a wood-fired-tasks-remote MCP entry with WFT_API_URL/WFT_API_KEY, copies skills, and caches the PAT under the config dir', () => {
    withSandbox((home, configDir) => {
      // Pre-seed an unrelated mcpServer to prove preservation.
      const claudeJson = path.join(home, '.claude.json');
      fs.writeFileSync(
        claudeJson,
        JSON.stringify({ mcpServers: { 'some-other': { type: 'stdio', command: 'x' } } }, null, 2) +
          '\n',
        'utf8',
      );

      const result = runSetup({
        home,
        configDir,
        remote: REMOTE_URL,
        token: FAKE_PAT,
        log: () => {},
      });

      // (1) Remote entry present and correctly shaped.
      const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      expect(doc.mcpServers['some-other']).toEqual({
        type: 'stdio',
        command: 'x',
      });
      const remoteEntry = doc.mcpServers['wood-fired-tasks-remote'];
      expect(remoteEntry).toEqual(buildRemoteMcpEntry(REMOTE_URL, FAKE_PAT));
      expect(remoteEntry.type).toBe('stdio');
      expect(remoteEntry.env.WFT_API_URL).toBe(REMOTE_URL);
      expect(remoteEntry.env.WFT_API_KEY).toBe(FAKE_PAT);
      // The local entry is NOT written in the remote path.
      expect(doc.mcpServers['wood-fired-tasks']).toBeUndefined();
      expect(result.serverName).toBe('wood-fired-tasks-remote');
      expect(result.remote).toBe(true);

      // (2) Skills copied in the remote path too.
      const destDir = commandsDestDir(home);
      const copied = fs
        .readdirSync(destDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      const sourceSet = fs
        .readdirSync(tasksSkillsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      expect(copied).toEqual(sourceSet);
      expect(copied.length).toBeGreaterThan(0);

      // (3) PAT cached under the CONFIG dir (NOT the data dir).
      const patPath = patCachePath(configDir);
      expect(result.patCache?.path).toBe(patPath);
      expect(fs.existsSync(patPath)).toBe(true);
      expect(fs.readFileSync(patPath, 'utf8')).toBe(FAKE_PAT);
      // It lives under the injected config dir...
      expect(patPath.startsWith(configDir)).toBe(true);
      // ...and NOT under the real data dir.
      expect(patPath.startsWith(dataDir)).toBe(false);

      // POSIX: file is 0600 (owner-only).
      if (process.platform !== 'win32') {
        const mode = fs.statSync(patPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });

  it('remote-entry write + PAT cache are idempotent on re-run (no spurious changes)', () => {
    withSandbox((home, configDir) => {
      const first = runSetup({
        home,
        configDir,
        remote: REMOTE_URL,
        token: FAKE_PAT,
        log: () => {},
      });
      expect(first.claudeJsonChanged).toBe(true);
      expect(first.patCache?.changed).toBe(true);

      const claudeJson = path.join(home, '.claude.json');
      const jsonAfterFirst = fs.readFileSync(claudeJson, 'utf8');
      const patPath = patCachePath(configDir);
      const patAfterFirst = fs.readFileSync(patPath, 'utf8');

      const second = runSetup({
        home,
        configDir,
        remote: REMOTE_URL,
        token: FAKE_PAT,
        log: () => {},
      });

      // No second-run write to either artifact.
      expect(second.claudeJsonChanged).toBe(false);
      expect(second.patCache?.changed).toBe(false);
      expect(second.skills.written).toEqual([]);

      // Byte-stable on disk.
      expect(fs.readFileSync(claudeJson, 'utf8')).toBe(jsonAfterFirst);
      expect(fs.readFileSync(patPath, 'utf8')).toBe(patAfterFirst);
    });
  });

  it('--remote without --token throws (cannot author a usable WFT_API_KEY)', () => {
    withSandbox((home, configDir) => {
      expect(() => runSetup({ home, configDir, remote: REMOTE_URL, log: () => {} })).toThrow(
        /--token/,
      );
    });
  });
});
