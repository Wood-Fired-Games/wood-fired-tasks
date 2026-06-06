import { describe, it, expect } from 'vitest';
import { escapeHtml, html, unsafe, layout } from '../html.js';

describe('escapeHtml', () => {
  it('escapes <script> tag (XSS vector 1)', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes attribute-break onerror (XSS vector 2)', () => {
    expect(escapeHtml('"><img onerror=alert(1) src=x>')).toBe(
      '&quot;&gt;&lt;img onerror=alert(1) src=x&gt;',
    );
  });

  it('escapes single-quote SQL-like payload (XSS vector 3)', () => {
    expect(escapeHtml("'); DROP TABLE; --")).toBe('&#39;); DROP TABLE; --');
  });

  it('does NOT decode already-encoded entities (XSS vector 4)', () => {
    // The ampersand is escaped; already-encoded text becomes double-encoded.
    // Critical: we must NEVER attempt to detect and skip encoded entities —
    // attacker could exploit that to inject raw HTML via partial encoding.
    expect(escapeHtml('&lt;already-encoded')).toBe('&amp;lt;already-encoded');
  });

  it('escapes svg onload (XSS vector 5)', () => {
    expect(escapeHtml('<svg/onload=alert(1)>')).toBe('&lt;svg/onload=alert(1)&gt;');
  });

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('coerces numbers to strings', () => {
    expect(escapeHtml(123)).toBe('123');
  });

  it('coerces booleans to strings', () => {
    expect(escapeHtml(true)).toBe('true');
    expect(escapeHtml(false)).toBe('false');
  });

  it('escapes ampersand FIRST so double-encoding is impossible', () => {
    expect(escapeHtml('&<')).toBe('&amp;&lt;');
  });
});

describe('html tagged template', () => {
  it('auto-escapes plain string interpolation', () => {
    const evil = '<script>alert(1)</script>';
    expect(html`<p>${evil}</p>`).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('does NOT escape unsafe()-wrapped values', () => {
    const trusted = unsafe('<strong>safe</strong>');
    expect(html`<p>${trusted}</p>`).toBe('<p><strong>safe</strong></p>');
  });

  it('joins arrays without a separator, escaping each element', () => {
    const items = ['<a>', '<b>', '<c>'];
    expect(html`<ul>${items}</ul>`).toBe('<ul>&lt;a&gt;&lt;b&gt;&lt;c&gt;</ul>');
  });

  it('preserves unsafe() elements inside arrays', () => {
    const items = [unsafe('<li>safe</li>'), '<evil>'];
    expect(html`<ul>${items}</ul>`).toBe('<ul><li>safe</li>&lt;evil&gt;</ul>');
  });

  it('handles nested interpolations', () => {
    const name = '<x>';
    const inner = html`<i>${name}</i>`;
    expect(html`<b>${unsafe(inner)}</b>`).toBe('<b><i>&lt;x&gt;</i></b>');
  });

  it('escapes numbers and booleans (defensive)', () => {
    expect(html`<p>${42}</p>`).toBe('<p>42</p>');
  });

  it('treats null and undefined as empty', () => {
    expect(html`<p>${null}</p>`).toBe('<p></p>');
    expect(html`<p>${undefined}</p>`).toBe('<p></p>');
  });
});

describe('layout', () => {
  it('escapes the title but passes the body through', () => {
    const out = layout({ title: '<bad>', body: '<p>safe</p>' });
    expect(out).toContain('<title>&lt;bad&gt;</title>');
    expect(out).toContain('<p>safe</p>');
  });

  it('emits HTML5 doctype + charset + viewport meta', () => {
    const out = layout({ title: 'X', body: '' });
    expect(out).toMatch(/^<!doctype html>/i);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  it('wraps body in <main>', () => {
    const out = layout({ title: 'X', body: '<p>hi</p>' });
    expect(out).toContain('<main>');
    expect(out).toContain('</main>');
    expect(out).toContain('<p>hi</p>');
  });

  it('includes an inline <style> block', () => {
    const out = layout({ title: 'X', body: '' });
    expect(out).toContain('<style>');
    expect(out).toContain('font-family');
  });
});
