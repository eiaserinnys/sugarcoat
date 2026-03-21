# sugarcoat

[![npm version](https://img.shields.io/npm/v/@eiaserinnys/sugarcoat.svg)](https://www.npmjs.com/package/@eiaserinnys/sugarcoat)
[![license](https://img.shields.io/npm/l/@eiaserinnys/sugarcoat.svg)](https://github.com/eiaserinnys/sugarcoat/blob/main/LICENSE)

A lightweight bridge that wraps stdio-based [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers and exposes them as [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) endpoints.

Built to solve the zombie process problems that plague tools like supergateway on Windows.

## Features

- **Proper process lifecycle management** — child process trees are fully cleaned up on shutdown
- **No shell intermediaries** — commands are parsed and spawned directly (`shell: false`), minimizing process tree depth
- **Windows-first design** — handles `taskkill /F /T` for tree kill, SIGBREAK for console close, and `.cmd`/`.bat` resolution via [cross-spawn](https://github.com/moxystudio/node-cross-spawn)
- **Built-in .env loading** — no need for wrapper scripts; `.env` files are loaded and injected into the child process environment without polluting the parent
- **MCP Streamable HTTP spec compliant** — POST, GET (SSE), and DELETE endpoints per the MCP specification
- **Single child process** — one sugarcoat instance manages one child process, shared across all HTTP sessions

## Quick Start

```bash
# Run directly with npx (no install needed)
npx @eiaserinnys/sugarcoat --stdio "npx -y @anthropic/some-mcp-server" --port 3000
```

## Installation

```bash
# Global install
npm install -g @eiaserinnys/sugarcoat

# Or clone and build from source
git clone https://github.com/eiaserinnys/sugarcoat.git
cd sugarcoat
pnpm install
pnpm build
```

## Usage

```bash
# Basic usage (npx)
npx @eiaserinnys/sugarcoat --stdio "npx -y @anthropic/some-mcp-server" --port 3000

# Basic usage (global install)
sugarcoat --stdio "npx -y @anthropic/some-mcp-server" --port 3000

# With .env file for child process
sugarcoat --stdio "npx -y @anthropic/some-mcp-server" --port 3000 --env-file ./.env

# Multiple .env files
sugarcoat --stdio "your-server" --port 8000 --env-file .env.common --env-file .env.local

# Custom endpoint paths
sugarcoat --stdio "your-server" --port 8000 --path /api/mcp --health /api/health

# Enable CORS
sugarcoat --stdio "your-server" --port 8000 --cors

# Debug logging
sugarcoat --stdio "your-server" --port 8000 --log-level debug
```

## CLI Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--stdio` | string | *required* | The stdio MCP server command to wrap |
| `--port` | number | `8000` | HTTP server port |
| `--path` | string | `/mcp` | Streamable HTTP endpoint path |
| `--env-file` | string[] | `[]` | Path(s) to .env file(s) for child process |
| `--health` | string | `/health` | Health check endpoint path |
| `--cors` | boolean | `false` | Enable CORS |
| `--log-level` | string | `info` | Log level: `debug`, `info`, or `none` |

## How It Works

```
Client (Claude Code, etc.)
    │
    ├── POST /mcp   → JSON-RPC request  → child stdin
    ├── GET  /mcp   → SSE stream        ← child stdout
    └── DELETE /mcp → session cleanup
    │
sugarcoat (HTTP server)
    │
    └── child process (stdio MCP server)
        stdin  ← JSON-RPC messages (newline-delimited)
        stdout → JSON-RPC responses (newline-delimited)
```

## Why Not supergateway?

[supergateway](https://github.com/nicobrinkkemper/supergateway) offers two modes — **stateless** (new child per session) and **stateful** (shared child). Both have trade-offs that sugarcoat avoids:

```
                          supergateway    supergateway
                          (stateless)     (stateful)      sugarcoat
                          ─────────────   ─────────────   ─────────────
Process per session       Yes (new child  No (shared)     No (shared)
                          each time)

Windows zombie            No              No              Yes
prevention                                                (taskkill /F /T)

Init caching              N/A             No              Yes

ID namespacing            N/A             No              Yes

.env loading              No              No              Yes (built-in)
```

**supergateway stateless** spawns a new child process per HTTP session. On Windows, these processes accumulate as zombies because `shell: true` creates `cmd.exe` intermediaries that survive parent death, and there is no process tree kill.

**supergateway stateful** shares a single child process, but lacks init caching and request ID namespacing. Without init caching, each new HTTP session re-initializes the child, causing stateful MCP servers (e.g., chrome-devtools-mcp) to lose internal state. Without ID namespacing, concurrent sessions that send the same JSON-RPC id (e.g., both send `id: 1`) cause routing collisions.

**sugarcoat** combines the shared-process model with init caching and ID namespacing, plus Windows-specific cleanup (`taskkill /F /T`, SIGBREAK handling, `.env` loading to avoid shell wrappers).

## Limitations

- **No shell operators** — Pipe (`|`), redirection (`>`), and other shell operators in the `--stdio` command are not supported. Commands are parsed and spawned directly without a shell.
- **Shared child process** — A single child process is shared across all HTTP sessions. For stateful MCP servers, sugarcoat initializes the child once at startup and caches the init result, so subsequent sessions receive cached capabilities without re-initializing.
- **Windows-first** — sugarcoat was designed for Windows environments. It works on Linux/macOS as well, but the primary use case and testing target is Windows.

## Contributing

Issues and pull requests are welcome.

This project uses [pnpm](https://pnpm.io/) as its package manager:

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
