/**
 * Node runtime version advisories (task #752).
 *
 * `package.json` `engines.node` stays `>=22`, which permits both even-numbered
 * LTS majors (22, 24, …) and odd-numbered "Current" majors (23, 25, …). Odd
 * majors are short-lived, non-LTS releases that drop out of support quickly, so
 * running the CLI on one is a footgun worth flagging — but NOT a hard error
 * (`engines` already enforces the `>=22` floor). This module provides a pure
 * predicate plus a NON-FATAL warning emitter the CLI calls at startup.
 *
 * Contract: the warning NEVER throws and NEVER exits. It writes one line to
 * stderr (via the injected sink, defaulting to `console.warn`) and returns.
 */

/**
 * True when `major` is an even-numbered Node major (an LTS line: 22, 24, 26…).
 * Returns false for odd "Current" majors (23, 25…) and for any non-finite /
 * non-positive input (defensive — callers treat "unknown" as not-even-LTS but
 * the warning path additionally guards on a parseable major).
 */
export function isEvenLtsMajor(major: number): boolean {
  return Number.isInteger(major) && major > 0 && major % 2 === 0;
}

/**
 * Parse the major version out of a `process.version`-style string
 * (e.g. `'v23.4.0'` -> 23). Returns `null` when it cannot be parsed.
 */
export function parseNodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : null;
}

export interface NodeVersionWarningOptions {
  /** Override the version string (testing). Defaults to `process.version`. */
  version?: string;
  /** Injectable warning sink (testing). Defaults to `console.warn`. */
  warn?: (line: string) => void;
}

/**
 * Emit a NON-FATAL warning when the running Node major is odd ("Current",
 * non-LTS). Never throws, never exits. Returns true when a warning was emitted
 * (i.e. the running major is a known odd/non-LTS major), false otherwise (even
 * LTS, or an unparseable version where we stay silent rather than risk a
 * false positive).
 */
export function warnIfNotEvenLts(
  options: NodeVersionWarningOptions = {}
): boolean {
  const version = options.version ?? process.version;
  const warn = options.warn ?? ((line: string) => console.warn(line));

  const major = parseNodeMajor(version);
  // Unparseable: stay silent (don't risk a spurious warning).
  if (major === null) return false;
  // Even LTS line: nothing to warn about.
  if (isEvenLtsMajor(major)) return false;

  warn(
    `warning: wood-fired-tasks is running on Node ${version}, an odd-numbered ` +
      `"Current" (non-LTS) release. This is supported (engines: >=22) but ` +
      `even-numbered LTS majors (22, 24, …) are recommended for stability.`
  );
  return true;
}
