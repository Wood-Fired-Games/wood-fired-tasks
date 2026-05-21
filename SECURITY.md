# Security Policy

We take the security of wood-fired-bugs seriously. This document explains
which versions receive security fixes, how to report a vulnerability, and
what is in scope.

## Supported Versions

Only the current `main` branch and the most recent tagged release receive
security updates. Older tags are provided as-is.

| Version          | Supported          |
| ---------------- | ------------------ |
| `main` (HEAD)    | :white_check_mark: |
| `v1.8` (latest)  | :white_check_mark: |
| `v1.0` – `v1.7`  | :x:                |

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

- The REST API (FastAPI service under `app/`).
- The MCP server (stdio + HTTP transports).
- The CLI (`bugs` / `wfb` entrypoints).
- The Slack integration (slash commands, signed webhook handler).

**Out of scope:**

- Third-party dependencies — please report those directly upstream
  (e.g. FastAPI, Starlette, SQLAlchemy, Slack SDK).
- User-side customizations layered on top of the project, including
  custom auth proxies in front of the API, self-hosted reverse proxies,
  or forked deployments with modified middleware.
- Findings from automated scanners (SAST/DAST/dependency CVE noise)
  submitted without a working proof-of-concept against this codebase.

## What We Consider Security-Relevant

Issues we will prioritize include, but are not limited to:

- Authentication or authorization bypass on any endpoint.
- Secrets exposure (API keys, tokens, `.env` leakage, log scrubbing gaps).
- SQL injection or FTS injection in task/comment/project queries.
- Server-Side Request Forgery (SSRF) in any outbound HTTP call.
- Prompt-injection vectors via MCP tool descriptions, task fields, or
  comment bodies that cause an MCP client to take unintended action.
- Signature-verification bypass on the Slack webhook endpoint.
- Anything that allows unauthenticated mutation of tasks, projects,
  comments, or dependencies — including bypassing the admin-key check
  on write endpoints.

Thank you for helping keep wood-fired-bugs and its users safe.
