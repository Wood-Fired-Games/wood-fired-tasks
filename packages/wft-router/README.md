Owner: Repository maintainers

# wft-router

`wft-router` is the event-router daemon for wood-fired-tasks. It subscribes to
the API's Server-Sent Events stream (`GET /api/v1/events`), matches each task
event against rules in a `triggers.yaml`, and dispatches matches to
vendor-neutral handlers — without coupling the core API to any specific sink.

Design-of-record: [docs/event-router-design.md](../../docs/event-router-design.md) · recipes in [docs/automation-recipes/](../../docs/automation-recipes/).

## Handlers

Four core handlers ship in v1, selected per rule:

| Handler | Effect |
|---|---|
| `create_task_in_project` | POST a templated task to the REST API |
| `webhook_post` | POST a templated body to an operator URL (TLS/loopback guarded) |
| `shell_exec` | Spawn a local program (never a shell); event JSON on stdin |
| `agent_session_dispatch` | Invoke a confined adapter executable to bridge a session |

Dispatch is at-least-once (SQLite idempotency store) with secret-redacted logs.

## Run

`wft-router` ships inside the [`wood-fired-tasks`](https://www.npmjs.com/package/wood-fired-tasks)
package — installing that puts the `wft-router` bin on your PATH (`npm i -g
wood-fired-tasks`, or invoke via `npx wft-router`). It is not published as a
standalone npm package.

```
wft-router --endpoint https://tasks.example.com --token "$WFT_ROUTER_TOKEN"
```

Endpoint and token may come from flags or env (`WFT_ROUTER_ENDPOINT`,
`WFT_ROUTER_TOKEN`); `triggers.yaml` is resolved from the platform config dir
unless `--config <path>` is given.

| Flag | Purpose |
|---|---|
| `--config <path>` | Path to `triggers.yaml` (default: platform config dir) |
| `--endpoint <url>` | API base URL (or `WFT_ROUTER_ENDPOINT`) |
| `--token <key>` | API key / PAT (or `WFT_ROUTER_TOKEN`) |
| `--validate <path>` | Schema-check a config and exit (0 ok / 78 invalid) |
| `--metrics-port <n>` | Expose Prometheus `/metrics` (off by default) |
| `--metrics-bind <addr>` | Metrics bind address (default `127.0.0.1`) |
| `--stale-resubscribe-after <s>` | Opt-in self-heal: re-open the SSE subscription when no real event arrived for `<s>` seconds while keep-alive pings kept flowing (or `WFT_ROUTER_STALE_RESUBSCRIBE_AFTER`); 0/absent = off |
| `--version` / `-V` | Print version |

Reserved by the design spec, not yet implemented: `--dry-run`, `--once`, `--rebuild-idempotency`.

## Configure

A ready-to-edit starter config ships with the package as
[`triggers.example.yaml`](triggers.example.yaml) — copy it, edit the project
slugs / URL / token-env names, and check it before going live:

```
wft-router --validate triggers.example.yaml
```

**Cold-start sweep** (opt-in, default off): set `sweep_on_start: true` on a
rule or under `defaults:` and the daemon sweeps the OPEN backlog once on
startup, dispatching at most one synthesized event per matching rule — so
backlogs that predate the wiring (or arrived while the router was down) still
wake their targets. Dedup: `sweep:<rule>:<floor(now / idempotency_window)>`,
so a restart within the same window dispatches nothing. See
[docs/event-router-design.md §Cold-start sweep](../../docs/event-router-design.md).

- **Recipes** (full walkthroughs): [docs/automation-recipes/](https://github.com/Wood-Fired-Games/wood-fired-tasks/tree/main/docs/automation-recipes)
- **Reference adapters** for `agent_session_dispatch`: [examples/adapters/](https://github.com/Wood-Fired-Games/wood-fired-tasks/tree/main/examples/adapters)
- **Schema, predicate & templating rules**: [docs/event-router-design.md](https://github.com/Wood-Fired-Games/wood-fired-tasks/blob/main/docs/event-router-design.md)

## Build & deploy

```
npm run build   # repo root (also runs as part of the default pipeline)
node dist/bin/wft-router.js --validate path/to/triggers.yaml
```

Service manifests (systemd / launchd / Windows) are in
[`host-manifests/`](host-manifests/); a `Containerfile` is provided for OCI
builds, and operator deploy assets (container build command, logrotate example)
are in [examples/deploy/](https://github.com/Wood-Fired-Games/wood-fired-tasks/tree/main/examples/deploy).

## Vendor-neutrality

No provider, AI vendor, chat platform, or CI name appears in the package name,
code, or docs. New contributions must hold that line.
