import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  mergeClaudeJson,
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
