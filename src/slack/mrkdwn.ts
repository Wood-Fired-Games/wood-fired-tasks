/**
 * Slack mrkdwn escaping primitive.
 *
 * Slack's mrkdwn parser treats `<...>` as control sequences: `<!channel>` /
 * `<!here>` broadcast pings, `<@U123>` user mentions, and `<https://x|label>`
 * spoofable links. User-controlled text (task/project/comment fields) flowing
 * into a `mrkdwn` (or even a `plain_text`) block must be escaped so it renders
 * as literal characters instead of injecting pings or fake links.
 *
 * Per Slack's spec only three characters need escaping, and ORDER MATTERS:
 * `&` first so the `&amp;` we emit for `<`/`>` isn't itself re-escaped, then
 * `<` → `&lt;`, then `>` → `&gt;`. Mirrors `escapeHtml` in `src/web/html.ts`.
 *
 * null / undefined collapse to '' so optional fields render cleanly without
 * forcing every call site to defend against missing data.
 */
const AMP = /&/g;
const LT = /</g;
const GT = />/g;

export function escapeSlackMrkdwn(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s.replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;');
}
