# Security Policy

For repository structure and agent-context entry, see [`AGENTS.md`](AGENTS.md).

We take the security of wood-fired-bugs seriously. This document explains
which versions receive security fixes, how to report a vulnerability, and
what is in scope.

## Supported Versions

Only the current `main` branch and the most recent tagged release receive
security updates. Older tags are provided as-is.

| Version           | Supported          |
| ----------------- | ------------------ |
| `main` (HEAD)     | :white_check_mark: |
| `v1.11` (latest)  | :white_check_mark: |
| `v1.0` – `v1.10`  | :x:                |

"Latest" tracks whichever tag is most recent on GitHub; at the time of
writing that is `v1.11`. If you are reading this on an older checkout,
verify the current latest release via
`git tag --sort=-creatordate | head -1` or the GitHub Releases page.

## Reporting a Vulnerability

**Preferred:** open a private report via GitHub Security Advisories:

  https://github.com/Wood-Fired-Games/wood-fired-bugs/security/advisories/new

**Fallback:** email `security@woodfiredgames.com` with steps to reproduce,
affected version/commit, and the impact you observed. Please do not file
public GitHub issues for suspected vulnerabilities.

We will:

- Acknowledge your report within **5 business days**.
- Aim to ship a fix or documented workaround within **30 days** for issues
  rated high or critical. Lower-severity issues are batched into the next
  routine release.
- Credit reporters in the release notes unless you ask us not to.

## Scope

**In scope:**

- The Fastify REST API (TypeScript, Node ≥22) under `src/api/` — routes,
  plugins (auth, rate-limit, SSE), and request/response validation.
- The MCP server under `src/mcp/` — both transports: the **stdio** server
  (`npm run mcp` / installed Claude Code stdio target) and the **remote
  HTTP** server (`npm run mcp:remote`), including its tool implementations
  and prompt/resource handlers.
- The `tasks` CLI under `src/cli/` — command parsers, HTTP client, and the
  small set of offline subcommands that touch SQLite directly
  (`backup`, `doctor`, `stats`, `db-check`, `completed`).
- The Slack integration under `src/slack/` — Bolt subprocess, slash-command
  handlers, signed-request verification, and the EventBus → Slack notifier
  path.
- The shared service / repository / workflow layer under `src/services/`,
  `src/repositories/`, and `src/events/` that all four entry points sit on
  top of.

**Out of scope:**

- Third-party dependencies — please report those directly upstream
  (e.g. Fastify, `@slack/bolt`, `@modelcontextprotocol/sdk`,
  `better-sqlite3`, `commander`, `zod`).
- User-side customizations layered on top of the project, including
  custom auth proxies in front of the API, self-hosted reverse proxies,
  or forked deployments with modified middleware.
- Findings from automated scanners (SAST/DAST/dependency CVE noise)
  submitted without a working proof-of-concept against this codebase.

## What We Consider Security-Relevant

Issues we will prioritize include, but are not limited to:

- Authentication or authorization bypass on any endpoint, including
  bypassing the `X-API-Key` check, the admin-key check on write
  endpoints, or the SSE auth path.
- Secrets exposure (API keys, Slack tokens, `.env` leakage, log
  scrubbing gaps in pino redaction, Slack signing-secret disclosure).
- SQL injection or FTS5 injection in task/comment/project queries
  (better-sqlite3 prepared statements, search filters, sort/order
  parameters).
- Server-Side Request Forgery (SSRF) in any outbound HTTP call.
- Prompt-injection vectors via MCP tool descriptions, task fields,
  comment bodies, or resource contents that cause an MCP client to
  take unintended action.
- Signature-verification bypass on the Slack webhook / events endpoint,
  or replay of signed Slack requests.
- Anything that allows unauthenticated mutation of tasks, projects,
  comments, dependencies, or Slack channel subscriptions — including
  bypassing the admin-key check on write endpoints or escalating
  read-only access to write access on either MCP transport.

Thank you for helping keep wood-fired-bugs and its users safe.
