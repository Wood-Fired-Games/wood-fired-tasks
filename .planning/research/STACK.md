# Stack Research

**Domain:** Task Tracking Service (REST API + MCP Server + CLI)
**Researched:** 2026-02-13
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 22 LTS | Runtime environment | Current LTS with native SQLite support (v22.5.0+), stable for production services. v22 is the recommended LTS version for 2025-2026. |
| TypeScript | 5.7+ | Type-safe development | Industry standard for Node.js services. Version 5.7+ adds native Node.js TypeScript execution support with proper module resolution. |
| Fastify | 5.7.4 | REST API framework | 2.7x faster than Express (45k vs 15k RPS), built-in schema validation, native TypeScript support, HTTP/2 ready. Modern architecture with plugin system. |
| better-sqlite3 | 12.6.2 | SQLite driver | 5-10x faster than node-sqlite3, synchronous API perfect for local services, most mature SQLite library for Node.js. Handles tens of thousands of tasks efficiently. |
| MCP TypeScript SDK | 1.x (latest) | MCP server implementation | Official SDK from Model Context Protocol team. v1.x is production-ready with optional middleware for Express/Hono/Node.js HTTP. v2 coming Q1 2026. |
| Commander | 12.x | CLI framework | Zero dependencies, clean syntax for Git-style subcommands, 12M weekly downloads. Perfect for `wfb task create` style commands. |
| Zod | 3.x | Schema validation | TypeScript-first with automatic type inference, required by MCP SDK, zero dependencies. Keeps types and validation in sync. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Pino | 9.x | Structured logging | Fast (5x faster than Winston), JSON output, low overhead. Perfect for production services. |
| dotenvx | latest | Environment configuration | Next-gen .env management with encryption, multi-environment support, cross-platform. Successor to dotenv. |
| tsx | latest | TypeScript execution | 5-10x faster than ts-node for development, uses esbuild, integrated watch mode. Development only. |
| Vitest | latest | Testing framework | Modern, fast, Vite-based. Better TypeScript support than Jest, compatible API for easy migration. |
| ESLint | 9.x | Linting | Flat config system (2025 standard), TypeScript support via @typescript-eslint plugins. |
| Prettier | 3.x | Code formatting | Industry standard formatter, integrates with ESLint via eslint-config-prettier. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| pnpm | Package manager | 70% disk space savings vs npm, fastest install times, monorepo-ready. Recommended for 2025. |
| @tsconfig/node22 | TypeScript config base | Pre-configured tsconfig optimized for Node.js 22 with ESM support. |
| systemd | Service management | Built into Ubuntu, more reliable than PM2 for single-service deployments, journalctl integration. |

## Installation

```bash
# Initialize project with pnpm
pnpm init

# Core runtime dependencies
pnpm add fastify better-sqlite3 @modelcontextprotocol/sdk commander zod pino @dotenvx/dotenvx

# MCP middleware (choose based on integration pattern)
pnpm add @modelcontextprotocol/node  # For standalone MCP server

# Development dependencies
pnpm add -D typescript @types/node @types/better-sqlite3
pnpm add -D tsx vitest @vitest/ui
pnpm add -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
pnpm add -D prettier eslint-config-prettier eslint-plugin-prettier
pnpm add -D @tsconfig/node22

# Optional: Drizzle ORM if not using raw SQL
pnpm add drizzle-orm
pnpm add -D drizzle-kit
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Runtime | Node.js 22 | Bun, Deno | Node.js has mature ecosystem, native SQLite support, and better-sqlite3 compatibility. Bun/Deno lack MCP SDK maturity. |
| API Framework | Fastify | Express | Express is 2.7x slower, lacks modern features (HTTP/2, native TypeScript), larger ecosystem but Fastify plugins cover needs. |
| SQLite Driver | better-sqlite3 | node:sqlite, sqlite3 | node:sqlite is experimental (v1.1 stability). better-sqlite3 is proven, faster, and production-ready. |
| ORM | Raw SQL/Drizzle | Prisma | Prisma 90% larger bundle, requires generation step, slower for SQLite. Drizzle is SQL-first with zero-overhead TypeScript. |
| CLI Framework | Commander | Yargs | Commander has zero deps vs Yargs' 16. Commander's syntax cleaner for Git-style subcommands. Yargs better for complex validation but overkill here. |
| TS Execution | tsx | ts-node | tsx 5-10x faster compilation via esbuild, better watch mode, same compatibility. ts-node slower due to tsc. |
| Logger | Pino | Winston | Pino 5x faster, smaller bundle, structured JSON. Winston more customizable but unnecessary complexity. |
| Validation | Zod | Joi | Zod TypeScript-native with type inference, required by MCP SDK. Joi JavaScript-first with less type safety. |
| Package Manager | pnpm | npm, Yarn | pnpm 70% disk savings, fastest installs, monorepo-ready. npm bundled but slower/wasteful. Yarn PnP complex. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| PM2 | Unnecessary complexity for single-service deployment. Adds another layer vs native systemd. | systemd with service file |
| dotenv (classic) | Author recommends dotenvx for encryption, multi-env, better debugging. | @dotenvx/dotenvx |
| node:sqlite | Still experimental (v1.1 stability), synchronous-only API may block future async patterns. | better-sqlite3 |
| Express | 2.7x slower, missing modern features (HTTP/2, schema validation), stagnant development. | Fastify |
| Jest | Slower than Vitest, requires more config for TypeScript/ESM, duplicates Vite pipeline. | Vitest |
| ts-node | 5-10x slower compilation, poor watch mode, uses tsc instead of fast transpilers. | tsx |

## Stack Patterns by Variant

**For MCP Server Integration:**
- Use `@modelcontextprotocol/node` middleware if MCP runs as separate endpoint
- MCP SDK requires Zod for schema validation (already in dependencies)
- Fastify plugin pattern allows clean separation of REST vs MCP routes

**For SQLite Schema Management:**
- Option 1: Raw SQL migrations (simple, direct, no dependencies)
- Option 2: Drizzle Kit for migrations (TypeScript schemas, type-safe queries, minimal overhead)
- Avoid Prisma: 90% larger bundle, slower SQLite performance, generation step friction

**For Service Deployment:**
- systemd service file for process management (native Linux, reliable restart policies)
- Environment variables via dotenvx with encrypted .env files
- Logs via journalctl (automatic with systemd, Pino JSON output integrates cleanly)

**For Development Workflow:**
- tsx for fast TypeScript execution with watch mode
- Vitest for testing (faster than Jest, better TypeScript support)
- ESLint flat config (2025 standard) + Prettier for code quality

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Fastify 5.x | Node.js 20+ | Requires Node.js 20 or above (our 22 LTS is compatible) |
| better-sqlite3 12.x | Node.js 18-22 | Native bindings require build tools on first install |
| MCP SDK 1.x | Zod 3+ | MCP SDK has peer dependency on Zod for schema validation |
| Vitest | Node.js 18+ | Works with native Node.js test runner or standalone |
| @tsconfig/node22 | TypeScript 5.5+ | Optimized for Node.js 22 with module: "NodeNext" |
| pnpm 9.x | Node.js 18.12+ | Recommended Node.js version for package manager |

## TypeScript Configuration

```json
{
  "extends": "@tsconfig/node22/tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## ESLint + Prettier Configuration

**Install:**
```bash
pnpm add -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier eslint-config-prettier eslint-plugin-prettier
```

**eslint.config.js (Flat Config - 2025 Standard):**
```javascript
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['dist/', 'node_modules/', '**/*.d.ts', 'coverage/']
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...prettierConfig.rules
    }
  }
];
```

## Systemd Service Configuration

**/etc/systemd/system/wood-fired-bugs.service:**
```ini
[Unit]
Description=Wood Fired Bugs Task Tracking Service
After=network.target

[Service]
Type=simple
User=wfb
WorkingDirectory=/opt/wood-fired-bugs
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/wood-fired-bugs/dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wfb

[Install]
WantedBy=multi-user.target
```

**Enable and start:**
```bash
sudo systemctl enable wood-fired-bugs
sudo systemctl start wood-fired-bugs
sudo journalctl -u wood-fired-bugs -f  # Follow logs
```

## Sources

### High Confidence (Official Documentation)
- [Fastify Official](https://fastify.dev/benchmarks/) - Performance benchmarks, v5 features
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - v1.x production status, v2 timeline
- [Node.js SQLite Module](https://nodejs.org/api/sqlite.html) - Experimental status, v22.5.0+ availability
- [TypeScript TSConfig](https://www.typescriptlang.org/tsconfig/) - Configuration reference
- [better-sqlite3 GitHub](https://github.com/WiseLibs/better-sqlite3) - Performance claims, usage patterns

### Medium Confidence (Verified comparisons, recent 2025 articles)
- [Express or Fastify in 2025](https://medium.com/codetodeploy/express-or-fastify-in-2025-whats-the-right-node-js-framework-for-you-6ea247141a86)
- [Fastify vs Express Performance](https://betterstack.com/community/guides/scaling-nodejs/fastify-express/)
- [Pino vs Winston Comparison](https://betterstack.com/community/comparisons/pino-vs-winston/)
- [Zod vs Joi Validation](https://betterstack.com/community/guides/scaling-nodejs/joi-vs-zod/)
- [Commander vs Yargs](https://medium.com/@sohail_saifi/command-line-argument-parsing-yargs-vs-commander-and-why-you-should-care-e9c8dac1fcc5)
- [tsx vs ts-node](https://betterstack.com/community/guides/scaling-nodejs/tsx-vs-ts-node/)
- [Vitest vs Jest 2025](https://medium.com/@ruverd/jest-vs-vitest-which-test-runner-should-you-use-in-2025-5c85e4f2bda9)
- [pnpm vs npm vs Yarn 2025](https://medium.com/@djantchengamo/npm-yarn-or-pnpm-in-2025-which-package-manager-should-you-choose-d1a351810fd4)
- [dotenvx Next Generation](https://dotenvx.com/blog/2024/06/24/dotenvx-next-generation-config-management.html)
- [systemd Node.js Best Practices](https://www.cloudbees.com/blog/running-node-js-linux-systemd)
- [Drizzle vs Prisma SQLite](https://www.bytebase.com/blog/drizzle-vs-prisma/)
- [Node.js 2025 TypeScript Setup](https://medium.com/@gabrieldrouin/node-js-2025-guide-how-to-setup-express-js-with-typescript-eslint-and-prettier-b342cd21c30d)

---
*Stack research for: Wood Fired Bugs Task Tracking Service*
*Researched: 2026-02-13*
*Overall confidence: HIGH - All core technologies verified via official docs or recent 2025-2026 sources*
