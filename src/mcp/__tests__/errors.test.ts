import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { convertToMcpError } from '../errors.js';
import { ValidationError, NotFoundError, BusinessError } from '../../services/errors.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

describe('convertToMcpError', () => {
  it('converts ValidationError to McpError with InvalidParams code', () => {
    const error = new ValidationError({
      title: ['Title is required'],
      priority: ['Invalid value'],
    });

    const result = convertToMcpError(error);

    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InvalidParams);
    expect(result.message).toContain('Validation failed');
    expect(result.data).toEqual({
      fieldErrors: {
        title: ['Title is required'],
        priority: ['Invalid value'],
      },
    });
  });

  it('converts NotFoundError to McpError with InvalidRequest code', () => {
    const error = new NotFoundError('Task', 42);

    const result = convertToMcpError(error);

    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InvalidRequest);
    expect(result.message).toContain('Task');
    expect(result.message).toContain('42');
    expect(result.data).toEqual({
      entity: 'Task',
      id: 42,
    });
  });

  it('converts BusinessError to McpError with InvalidRequest code', () => {
    const error = new BusinessError("Invalid status transition from 'open' to 'done'");

    const result = convertToMcpError(error);

    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InvalidRequest);
    expect(result.message).toContain("Invalid status transition from 'open' to 'done'");
  });

  it('converts unknown Error to McpError with InternalError code', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('something unexpected');

    const result = convertToMcpError(error);

    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InternalError);
    expect(result.message).toContain('An internal error occurred');
    expect(result.message).not.toContain('something unexpected');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Unexpected error in MCP handler:', error);

    consoleErrorSpy.mockRestore();
  });

  it('converts non-Error unknown value to McpError with InternalError code', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = convertToMcpError('string error');

    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InternalError);
    expect(result.message).toContain('An internal error occurred');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Unexpected error in MCP handler:',
      'string error',
    );

    consoleErrorSpy.mockRestore();
  });
});
