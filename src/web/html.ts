/**
 * Phase 29 Plan 07 — HTML rendering primitives.
 *
 * Pure template literals — no view engine, no JSX. The tagged-template
 * `html\`...\`` auto-escapes interpolated values via `escapeHtml` so
 * authors don't have to remember; the explicit `unsafe()` escape hatch
 * lets pre-rendered HTML fragments pass through.
 *
 * Anti-XSS contract: every interpolation that flows from user/IdP input
 * MUST stay un-`unsafe()`'d. `unsafe()` is reserved for COMBINING already-
 * rendered fragments (e.g. embedding a page body into the layout, or
 * splicing an array of pre-rendered table rows). It MUST NEVER wrap a
 * value that originated outside this file's templates.
 */
const AMP = /&/g;
const LT = /</g;
const GT = />/g;
const DQ = /"/g;
const SQ = /'/g;

/**
 * Escape a value for safe HTML text/attribute interpolation.
 *
 * Replacement order MATTERS: `&` first so the entity replacements we
 * append don't get double-escaped. The five replacements together cover
 * every HTML5 special character that can break out of a text node or a
 * quoted attribute value.
 *
 * null / undefined collapse to '' so optional fields render cleanly
 * without forcing every call site to defend against missing data.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s
    .replace(AMP, '&amp;')
    .replace(LT, '&lt;')
    .replace(GT, '&gt;')
    .replace(DQ, '&quot;')
    .replace(SQ, '&#39;');
}

const UNSAFE = Symbol('unsafe-html');
interface UnsafeHtml {
  [UNSAFE]: string;
}

/**
 * Marker for trusted, pre-rendered HTML. Wrap a string with `unsafe()`
 * ONLY to combine rendered template fragments — never to pass through
 * user input. The marker is a Symbol-keyed property so it cannot be
 * forged via JSON.parse or accidentally collide with user-supplied keys.
 */
export function unsafe(raw: string): UnsafeHtml {
  return { [UNSAFE]: raw };
}

function isUnsafe(v: unknown): v is UnsafeHtml {
  return (
    typeof v === 'object' &&
    v !== null &&
    UNSAFE in (v as Record<symbol, unknown>)
  );
}

/**
 * Tagged-template HTML builder. Interpolated values are escaped via
 * `escapeHtml`; values wrapped in `unsafe()` are inserted verbatim.
 * Arrays are joined without a separator (caller renders separators
 * explicitly, e.g. for table rows). Each array element is escaped
 * individually unless wrapped in `unsafe()`.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (isUnsafe(v)) {
        out += v[UNSAFE];
      } else if (Array.isArray(v)) {
        out += v
          .map((item) => (isUnsafe(item) ? item[UNSAFE] : escapeHtml(item)))
          .join('');
      } else {
        out += escapeHtml(v);
      }
    }
  }
  return out;
}

export interface LayoutOptions {
  title: string;
  /**
   * Pre-rendered fragment. Pass via `unsafe(rendered)` when nesting an
   * `html\`...\`` result — the layout treats the body as already-safe HTML
   * by contract. (Direct string assembly without `html\`...\`` is a bug
   * waiting to happen; always build via the tagged template.)
   */
  body: string;
}

/**
 * Minimal inline CSS. System font stack, light/dark color scheme, a
 * single 48-rem container. ~30 lines kept inline by design (project
 * developer profile: backend-focused; no extra files for styling).
 */
const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.5; margin: 0; padding: 2rem 1rem; }
main { max-width: 48rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin-top: 0; }
table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #888; }
form { margin: 1rem 0; }
input[type=text], input[type=datetime-local] { width: 100%; padding: 0.5rem; margin: 0.25rem 0; }
button { padding: 0.5rem 1rem; cursor: pointer; }
.minted-token { background: #ffd; padding: 1rem; border: 1px solid #cc9; margin: 1rem 0; word-break: break-all; }
.revoked { color: #888; }
.error-code { color: #888; font-size: 0.875rem; }
`;

/**
 * Render a full HTML5 document. The `body` is concatenated verbatim —
 * callers MUST build it via the `html\`...\`` tagged template so every
 * dynamic value is escaped.
 */
export function layout(opts: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${opts.body}
</main>
</body>
</html>`;
}
