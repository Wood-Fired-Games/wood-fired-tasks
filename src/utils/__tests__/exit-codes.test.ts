import { describe, it, expect } from 'vitest';
import { ExitCodes, CliExitCodes } from '../../utils/exit-codes.js';

describe('ExitCodes', () => {
  it('should define EX_OK as 0', () => {
    expect(ExitCodes.EX_OK).toBe(0);
  });

  it('should define EX_USAGE as 64', () => {
    expect(ExitCodes.EX_USAGE).toBe(64);
  });

  it('should define EX_DATAERR as 65', () => {
    expect(ExitCodes.EX_DATAERR).toBe(65);
  });

  it('should define EX_NOINPUT as 66', () => {
    expect(ExitCodes.EX_NOINPUT).toBe(66);
  });

  it('should define EX_UNAVAILABLE as 69', () => {
    expect(ExitCodes.EX_UNAVAILABLE).toBe(69);
  });

  it('should define EX_SOFTWARE as 70', () => {
    expect(ExitCodes.EX_SOFTWARE).toBe(70);
  });

  it('should define EX_OSERR as 71', () => {
    expect(ExitCodes.EX_OSERR).toBe(71);
  });

  it('should define EX_CANTCREAT as 73', () => {
    expect(ExitCodes.EX_CANTCREAT).toBe(73);
  });

  it('should define EX_IOERR as 74', () => {
    expect(ExitCodes.EX_IOERR).toBe(74);
  });

  it('should define EX_TEMPFAIL as 75', () => {
    expect(ExitCodes.EX_TEMPFAIL).toBe(75);
  });

  it('should define EX_PROTOCOL as 76', () => {
    expect(ExitCodes.EX_PROTOCOL).toBe(76);
  });

  it('should define EX_NOPERM as 77', () => {
    expect(ExitCodes.EX_NOPERM).toBe(77);
  });

  it('should define EX_CONFIG as 78', () => {
    expect(ExitCodes.EX_CONFIG).toBe(78);
  });

  it('should have all sysexits.h values', () => {
    const expectedCodes = {
      EX_OK: 0,
      EX_USAGE: 64,
      EX_DATAERR: 65,
      EX_NOINPUT: 66,
      EX_UNAVAILABLE: 69,
      EX_SOFTWARE: 70,
      EX_OSERR: 71,
      EX_CANTCREAT: 73,
      EX_IOERR: 74,
      EX_TEMPFAIL: 75,
      EX_PROTOCOL: 76,
      EX_NOPERM: 77,
      EX_CONFIG: 78,
    };

    expect(ExitCodes).toMatchObject(expectedCodes);
  });

  it('should have readonly codes (const assertion)', () => {
    // TypeScript ensures this at compile time
    // Runtime check: values should not be undefined
    Object.values(ExitCodes).forEach((code) => {
      expect(typeof code).toBe('number');
      expect(code).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('CliExitCodes', () => {
  it('should define SUCCESS as 0', () => {
    expect(CliExitCodes.SUCCESS).toBe(0);
  });

  it('should define GENERAL_ERROR as 1', () => {
    expect(CliExitCodes.GENERAL_ERROR).toBe(1);
  });

  it('should define USAGE_ERROR as 2', () => {
    expect(CliExitCodes.USAGE_ERROR).toBe(2);
  });

  it('should define CONFIG_ERROR as 78', () => {
    expect(CliExitCodes.CONFIG_ERROR).toBe(78);
  });

  it('should have simplified CLI codes', () => {
    const expectedCodes = {
      SUCCESS: 0,
      GENERAL_ERROR: 1,
      USAGE_ERROR: 2,
      CONFIG_ERROR: 78,
    };

    expect(CliExitCodes).toMatchObject(expectedCodes);
  });
});
