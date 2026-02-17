/**
 * sysexits.h standard exit codes
 *
 * These exit codes follow the BSD sysexits.h standard for consistent
 * script integration and error handling. Using these instead of
 * magic numbers makes code more self-documenting.
 *
 * @see https://www.freebsd.org/cgi/man.cgi?query=sysexits
 */
export const ExitCodes = {
  /** Success (0) */
  EX_OK: 0,
  /** Command line usage error (64) */
  EX_USAGE: 64,
  /** Data format error (65) */
  EX_DATAERR: 65,
  /** Cannot open input (66) */
  EX_NOINPUT: 66,
  /** Service unavailable (69) */
  EX_UNAVAILABLE: 69,
  /** Internal software error (70) */
  EX_SOFTWARE: 70,
  /** System error (71) */
  EX_OSERR: 71,
  /** Cannot create output file (73) */
  EX_CANTCREAT: 73,
  /** I/O error (74) */
  EX_IOERR: 74,
  /** Temporary failure (75) */
  EX_TEMPFAIL: 75,
  /** Remote error in protocol (76) */
  EX_PROTOCOL: 76,
  /** Permission denied (77) */
  EX_NOPERM: 77,
  /** Configuration error (78) */
  EX_CONFIG: 78,
} as const;

/**
 * Type of exit codes for type safety
 */
export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

/**
 * Simplified exit codes for CLI use
 *
 * These map to common CLI conventions:
 * - 0: Success
 * - 1: General error
 * - 2: Usage error
 * - 78: Configuration error
 */
export const CliExitCodes = {
  /** Success */
  SUCCESS: 0,
  /** General error */
  GENERAL_ERROR: 1,
  /** Usage error */
  USAGE_ERROR: 2,
  /** Configuration error */
  CONFIG_ERROR: 78,
} as const;

/**
 * Type of CLI exit codes for type safety
 */
export type CliExitCode = (typeof CliExitCodes)[keyof typeof CliExitCodes];
