import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import {
  colorSuccess,
  colorError,
  colorWarn,
  colorInfo,
  colorBold,
  shouldUseColor,
} from '../output/formatters.js';

describe('Color consistency', () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];
  const originalLevel = chalk.level;

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    chalk.level = originalLevel;
  });

  describe('with NO_COLOR set', () => {
    beforeEach(() => {
      process.env.NO_COLOR = '1';
    });

    it('colorSuccess returns plain text', () => {
      expect(colorSuccess('done')).toBe('done');
    });

    it('colorError returns plain text', () => {
      expect(colorError('fail')).toBe('fail');
    });

    it('colorWarn returns plain text', () => {
      expect(colorWarn('caution')).toBe('caution');
    });

    it('colorInfo returns plain text', () => {
      expect(colorInfo('note')).toBe('note');
    });

    it('colorBold returns plain text', () => {
      expect(colorBold('header')).toBe('header');
    });

    it('shouldUseColor returns false', () => {
      expect(shouldUseColor()).toBe(false);
    });
  });

  describe('with --json flag', () => {
    beforeEach(() => {
      delete process.env.NO_COLOR;
      process.argv = ['node', 'tasks', '--json'];
    });

    it('shouldUseColor returns false', () => {
      expect(shouldUseColor()).toBe(false);
    });

    it('colorSuccess returns plain text', () => {
      expect(colorSuccess('done')).toBe('done');
    });

    it('colorError returns plain text', () => {
      expect(colorError('fail')).toBe('fail');
    });
  });

  describe('without NO_COLOR and without --json (forced color)', () => {
    beforeEach(() => {
      delete process.env.NO_COLOR;
      // Remove --json from argv if present
      process.argv = process.argv.filter((a) => a !== '--json');
      // Force chalk to produce ANSI codes (chalk disables color in non-TTY/test environments)
      chalk.level = 1;
    });

    it('shouldUseColor returns true', () => {
      expect(shouldUseColor()).toBe(true);
    });

    it('colorSuccess returns ANSI-colored text', () => {
      const result = colorSuccess('done');
      expect(result).not.toBe('done');
      expect(result).toContain('done');
    });

    it('colorError returns ANSI-colored text', () => {
      const result = colorError('fail');
      expect(result).not.toBe('fail');
      expect(result).toContain('fail');
    });

    it('colorWarn returns ANSI-colored text', () => {
      const result = colorWarn('caution');
      expect(result).not.toBe('caution');
      expect(result).toContain('caution');
    });

    it('colorInfo returns ANSI-colored text', () => {
      const result = colorInfo('note');
      expect(result).not.toBe('note');
      expect(result).toContain('note');
    });

    it('colorBold returns ANSI-colored text', () => {
      const result = colorBold('header');
      expect(result).not.toBe('header');
      expect(result).toContain('header');
    });
  });
});
