Owner: Repository maintainers

# wft-router

`wft-router` is the event-router binary for wood-fired-tasks. It tails the
event bus, normalizes records, and forwards them to downstream sinks
(webhooks, message queues, log targets) without coupling the core API to
any specific vendor.

The design-of-record is [docs/event-router-design.md](../../docs/event-router-design.md);
the v1 implementation is being built in active development as project 19
in wood-fired-tasks.

## Status

This scaffold (landed by task #421) is a stub. Today the binary only
honours `--version` / `-V`; every other contract flag listed in the
design spec — `--config`, `--endpoint`, `--token`, `--validate`,
`--dry-run`, `--once`, `--metrics-port`, `--metrics-bind`,
`--rebuild-idempotency` — lands in downstream tasks.

## Build

```
cd packages/wft-router
npm run build
node dist/bin/wft-router.js --version
```

The root `npm run build` also compiles this package as part of its
default pipeline.

## Vendor-neutrality

Per the design spec, no provider, AI vendor, chat platform, or CI name
appears in the package name, code, or documentation. New contributions
must hold that line.
