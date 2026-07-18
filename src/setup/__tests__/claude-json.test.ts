import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  mergeClaudeJson,
  removeClaudeJsonServer,
  type ClaudeMcpServerEntry,
} from '../claude-json.js';

const ENTRY: ClaudeMcpServerEntry = {
  type: 'stdio',
  command: '/usr/bin/node',
  args: ['/opt/wft/dist/mcp/index.js'],
  env: { WFT_DB_PATH: '/var/lib/wft/tasks.db' },
};

describe('mergeClaudeJson', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-claude-json-'));
    filePath = path.join(dir, '.claude.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds the wood-fired-tasks MCP entry and preserves unrelated keys', () => {
    fs.writeFileSync(filePath, JSON.stringify({ numStartups: 5 }, null, 2) + '\n');

    const result = mergeClaudeJson({ filePath, entry: ENTRY });
    expect(result.unchanged).toBe(false);

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Unrelated key preserved.
    expect(parsed.numStartups).toBe(5);
    // Entry added under default server name.
    expect(parsed.mcpServers['wood-fired-tasks']).toEqual(ENTRY);
  });

  it('creates the file fresh when absent', () => {
    expect(fs.existsSync(filePath)).toBe(false);
    mergeClaudeJson({ filePath, entry: ENTRY });
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.mcpServers['wood-fired-tasks']).toEqual(ENTRY);
  });

  it('is idempotent — file bytes are unchanged on a second merge', () => {
    fs.writeFileSync(filePath, JSON.stringify({ numStartups: 5 }, null, 2) + '\n');
    mergeClaudeJson({ filePath, entry: ENTRY });

    const before = fs.readFileSync(filePath); // Buffer of exact bytes
    const second = mergeClaudeJson({ filePath, entry: ENTRY });
    const after = fs.readFileSync(filePath);

    expect(second.unchanged).toBe(true);
    expect(after.equals(before)).toBe(true);
  });

  it('produces a .bak backup and retries an EPERM rename', () => {
    fs.writeFileSync(filePath, JSON.stringify({ numStartups: 5 }, null, 2) + '\n');

    let calls = 0;
    const result = mergeClaudeJson({
      filePath,
      entry: ENTRY,
      _renameImpl: (oldPath, newPath) => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('operation not permitted') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        fs.renameSync(oldPath, newPath);
      },
    });

    // Rename was retried after the injected EPERM and ultimately succeeded.
    expect(calls).toBe(2);
    expect(result.renameAttempts).toBe(2);

    // .bak exists and holds the prior content.
    expect(result.backupPath).toBe(`${filePath}.bak`);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
    const bak = JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8'));
    expect(bak).toEqual({ numStartups: 5 });

    // Final file has the merged entry.
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.mcpServers['wood-fired-tasks']).toEqual(ENTRY);
  });
});

describe('removeClaudeJsonServer', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-claude-json-rm-'));
    filePath = path.join(dir, '.claude.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removes the entry, preserving foreign servers and non-mcpServers keys, with a .bak', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          numStartups: 5,
          mcpServers: {
            'some-other': { type: 'stdio', command: 'x' },
            'wood-fired-tasks-remote': { type: 'stdio', command: 'y' },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    const before = fs.readFileSync(filePath, 'utf8');

    const result = removeClaudeJsonServer({ filePath, serverName: 'wood-fired-tasks-remote' });
    expect(result.removed).toBe(true);
    expect(result.backupPath).toBe(`${filePath}.bak`);
    expect(result.renameAttempts).toBe(1);

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.mcpServers['wood-fired-tasks-remote']).toBeUndefined();
    expect(parsed.mcpServers['some-other']).toEqual({ type: 'stdio', command: 'x' });
    expect(parsed.numStartups).toBe(5);

    // The .bak holds the prior content byte-for-byte.
    expect(fs.readFileSync(`${filePath}.bak`, 'utf8')).toBe(before);
  });

  it('is a strict no-op when the key is absent (no write, no backup, no temp file)', () => {
    const body =
      JSON.stringify(
        { numStartups: 5, mcpServers: { 'some-other': { type: 'stdio', command: 'x' } } },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(filePath, body, 'utf8');
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    const result = removeClaudeJsonServer({ filePath, serverName: 'wood-fired-tasks-remote' });
    expect(result.removed).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(result.renameAttempts).toBe(0);

    // Nothing was written: same bytes, same mtime, no .bak, no .tmp.
    expect(fs.readFileSync(filePath, 'utf8')).toBe(body);
    expect(fs.statSync(filePath).mtimeMs).toBe(mtimeBefore);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it('is a no-op when the file is absent or has no mcpServers object', () => {
    // Absent file.
    expect(fs.existsSync(filePath)).toBe(false);
    let result = removeClaudeJsonServer({ filePath, serverName: 'wood-fired-tasks' });
    expect(result.removed).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);

    // No mcpServers key at all.
    const body = JSON.stringify({ numStartups: 1 }, null, 2) + '\n';
    fs.writeFileSync(filePath, body, 'utf8');
    result = removeClaudeJsonServer({ filePath, serverName: 'wood-fired-tasks' });
    expect(result.removed).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(body);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
  });

  it('refuses a non-object root (mirrors mergeClaudeJson)', () => {
    fs.writeFileSync(filePath, '[1, 2, 3]\n', 'utf8');
    expect(() => removeClaudeJsonServer({ filePath, serverName: 'wood-fired-tasks' })).toThrow(
      /does not contain a JSON object/,
    );
  });

  it('merge-then-remove round-trips to the original bytes (deterministic serialization)', () => {
    fs.writeFileSync(filePath, JSON.stringify({ numStartups: 5 }, null, 2) + '\n', 'utf8');
    mergeClaudeJson({ filePath, entry: ENTRY });
    const merged = fs.readFileSync(filePath, 'utf8');

    mergeClaudeJson({ filePath, serverName: 'second', entry: ENTRY });
    const removal = removeClaudeJsonServer({ filePath, serverName: 'second' });
    expect(removal.removed).toBe(true);
    // Removing the second entry restores the exact pre-add serialization.
    expect(fs.readFileSync(filePath, 'utf8')).toBe(merged);
  });
});
