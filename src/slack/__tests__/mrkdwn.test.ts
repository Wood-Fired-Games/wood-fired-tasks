import { describe, it, expect } from 'vitest';
import { escapeSlackMrkdwn } from '../mrkdwn.js';

describe('escapeSlackMrkdwn', () => {
  it('neutralizes a <!channel> broadcast ping', () => {
    expect(escapeSlackMrkdwn('<!channel>')).toBe('&lt;!channel&gt;');
  });

  it('neutralizes a <!here> broadcast ping', () => {
    expect(escapeSlackMrkdwn('<!here>')).toBe('&lt;!here&gt;');
  });

  it('neutralizes a <@U123> user mention', () => {
    expect(escapeSlackMrkdwn('<@U123>')).toBe('&lt;@U123&gt;');
  });

  it('neutralizes an angle-bracket link with a pipe label', () => {
    expect(escapeSlackMrkdwn('<https://evil.example|Slack>')).toBe(
      '&lt;https://evil.example|Slack&gt;',
    );
  });

  it('escapes a bare ampersand', () => {
    expect(escapeSlackMrkdwn('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('escapes a bare less-than', () => {
    expect(escapeSlackMrkdwn('a < b')).toBe('a &lt; b');
  });

  it('escapes a bare greater-than', () => {
    expect(escapeSlackMrkdwn('b > a')).toBe('b &gt; a');
  });

  it('leaves a pipe character untouched (not a control char outside <>)', () => {
    expect(escapeSlackMrkdwn('a|b')).toBe('a|b');
  });

  it('leaves a benign string unchanged', () => {
    expect(escapeSlackMrkdwn('Fix the login bug')).toBe('Fix the login bug');
  });

  it('escapes & FIRST so emitted entities are not double-encoded', () => {
    // If < were escaped before &, the resulting "&lt;" would have its & re-escaped
    // to "&amp;lt;". Correct order yields exactly one entity per source char.
    expect(escapeSlackMrkdwn('&<>')).toBe('&amp;&lt;&gt;');
    expect(escapeSlackMrkdwn('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('does not double-encode an existing entity-looking sequence', () => {
    // A literal "&amp;" in source must become "&amp;amp;" (the & is escaped once).
    expect(escapeSlackMrkdwn('&amp;')).toBe('&amp;amp;');
  });

  it('coerces null and undefined to empty string', () => {
    expect(escapeSlackMrkdwn(null)).toBe('');
    expect(escapeSlackMrkdwn(undefined)).toBe('');
  });

  it('coerces non-string values via String()', () => {
    expect(escapeSlackMrkdwn(42)).toBe('42');
  });
});
