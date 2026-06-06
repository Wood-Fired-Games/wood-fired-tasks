/**
 * In-process tests for src/cli/commands/mcp.ts (task #734).
 *
 * The command's action spawns a child process, so these tests exercise the
 * pure `selectMcpEntrypoint` helper instead — asserting it dispatches to the
 * remote bridge (src/mcp/remote/index.ts) when WFT_API_URL is set (or --remote
 * is provided) and to the local server (src/mcp/index.ts) otherwise.
 */
import { describe, it, expect } from 'vitest';
import {
  selectMcpEntrypoint,
  LOCAL_MCP_ENTRYPOINT,
  REMOTE_MCP_ENTRYPOINT,
  mcpCommand,
} from '../commands/mcp.js';

describe('selectMcpEntrypoint', () => {
  it('dispatches to the local server when no remote config is present', () => {
    expect(selectMcpEntrypoint({})).toBe('src/mcp/index.ts');
    expect(selectMcpEntrypoint({})).toBe(LOCAL_MCP_ENTRYPOINT);
  });

  it('dispatches to the remote bridge when WFT_API_URL is set', () => {
    expect(
      selectMcpEntrypoint({ WFT_API_URL: 'http://host:3000' })
    ).toBe('src/mcp/remote/index.ts');
    expect(
      selectMcpEntrypoint({ WFT_API_URL: 'http://host:3000' })
    ).toBe(REMOTE_MCP_ENTRYPOINT);
  });

  it('dispatches to the remote bridge when --remote is provided', () => {
    expect(selectMcpEntrypoint({ remote: 'http://host:3000' })).toBe(
      REMOTE_MCP_ENTRYPOINT
    );
  });

  it('treats an empty WFT_API_URL as local (not remote)', () => {
    expect(selectMcpEntrypoint({ WFT_API_URL: '' })).toBe(LOCAL_MCP_ENTRYPOINT);
  });

  it('--remote takes precedence and selects remote even with empty env URL', () => {
    expect(
      selectMcpEntrypoint({ WFT_API_URL: '', remote: 'http://host:3000' })
    ).toBe(REMOTE_MCP_ENTRYPOINT);
  });
});

describe('mcp command metadata', () => {
  it('is named "mcp" and documents local vs remote selection', () => {
    expect(mcpCommand.name()).toBe('mcp');
    const help = mcpCommand.helpInformation();
    expect(help).toMatch(/local/i);
    expect(help).toMatch(/remote/i);
    expect(help).toMatch(/--remote/);
  });
});
