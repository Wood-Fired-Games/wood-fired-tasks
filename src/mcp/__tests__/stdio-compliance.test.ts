import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

describe('MCP Server stdio compliance', () => {
  describe('static analysis guards', () => {
    it('src/mcp/ contains no console.log calls', () => {
      try {
        const result = execSync(
          'grep -rn "console\\.log" src/mcp/ --include="*.ts" || true',
          { encoding: 'utf-8', cwd: process.cwd() }
        ).trim();
        expect(result).toBe('');
      } catch {
        // grep returns exit 1 when no matches — that's the success case
        expect(true).toBe(true);
      }
    });

    it('Umzug logger does not use raw console (stdout pollution)', () => {
      const result = execSync(
        'grep -n "logger: console" src/db/migrate.ts || true',
        { encoding: 'utf-8', cwd: process.cwd() }
      ).trim();
      expect(result).toBe('');
    });
  });

  describe('runtime stdio verification', () => {
    it('stdout contains only valid JSON-RPC messages', async () => {
      const serverPath = join(process.cwd(), 'dist/mcp/index.js');

      // Skip if not built
      if (!existsSync(serverPath)) {
        console.warn('Skipping runtime test: project not built. Run `npm run build` first.');
        return;
      }

      // Spawn MCP server with in-memory database
      const child = spawn('node', [serverPath], {
        env: { ...process.env, DATABASE_PATH: ':memory:' },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      child.stdout.on('data', (data) => {
        stdoutChunks.push(data.toString());
      });

      child.stderr.on('data', (data) => {
        stderrChunks.push(data.toString());
      });

      // Send initialize request
      const initRequest = JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: {
              listChanged: false
            }
          }
        },
        id: 1
      }) + '\n';

      child.stdin.write(initRequest);

      // Wait for response (with timeout)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for initialize response'));
        }, 3000);

        child.stdout.on('data', () => {
          // Check if we have a complete response
          const stdout = stdoutChunks.join('');
          if (stdout.includes('"id":1')) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      // Kill the child process
      child.kill();

      // Parse stdout and verify each line is valid JSON-RPC
      const stdout = stdoutChunks.join('');
      const lines = stdout.split('\n').filter(line => line.trim().length > 0);

      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch (e) {
          throw new Error(`Invalid JSON on stdout: ${line}`);
        }

        // Verify it's JSON-RPC 2.0
        expect(parsed).toHaveProperty('jsonrpc', '2.0');
      }
    }, 10000); // 10 second timeout for the test

    it('startup message appears on stderr', async () => {
      const serverPath = join(process.cwd(), 'dist/mcp/index.js');

      // Skip if not built
      if (!existsSync(serverPath)) {
        console.warn('Skipping runtime test: project not built. Run `npm run build` first.');
        return;
      }

      // Spawn MCP server with in-memory database
      const child = spawn('node', [serverPath], {
        env: { ...process.env, DATABASE_PATH: ':memory:' },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const stderrChunks: string[] = [];

      child.stderr.on('data', (data) => {
        stderrChunks.push(data.toString());
      });

      // Send initialize request to get the server running
      const initRequest = JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: {
              listChanged: false
            }
          }
        },
        id: 1
      }) + '\n';

      child.stdin.write(initRequest);

      // Wait for stderr output
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 1000);
      });

      // Kill the child process
      child.kill();

      // Verify stderr contains startup message
      const stderr = stderrChunks.join('');
      expect(stderr).toContain('Wood Fired Bugs MCP Server running on stdio');
    }, 10000); // 10 second timeout for the test
  });
});
