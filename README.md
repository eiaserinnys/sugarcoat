# sugarcoat

A lightweight bridge that wraps stdio-based [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers and exposes them as [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) endpoints.

Built to solve the zombie process problems that plague tools like supergateway on Windows.

## Features

- **Proper process lifecycle management** — child process trees are fully cleaned up on shutdown
- **No shell intermediaries** — commands are parsed and spawned directly (`shell: false`), minimizing process tree depth
- **Windows-first design** — handles `taskkill /F /T` for tree kill, SIGBREAK for console close, and `.cmd`/`.bat` resolution via [cross-spawn](https://github.com/moxystudio/node-cross-spawn)
- **Built-in .env loading** — no need for wrapper scripts; `.env` files are loaded and injected into the child process environment without polluting the parent
- **MCP Streamable HTTP spec compliant** — POST, GET (SSE), and DELETE endpoints per the MCP specification
- **Single child process** — one sugarcoat instance manages one child process, shared across all HTTP sessions

## Installation

```bash
# Clone and build
git clone https://github.com/eiaserinnys/sugarcoat.git
cd sugarcoat
pnpm install
pnpm build

# Or use directly
node dist/index.js --stdio "your-mcp-server" --port 3000
```

## Usage

```bash
# Basic usage
sugarcoat --stdio "npx -y @delorenj/mcp-server-trello" --port 3102

# With .env file for child process
sugarcoat --stdio "npx -y slack-mcp-server@latest" --port 3101 --env-file ./services/mcp-slack/.env

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

[supergateway](https://github.com/nicobrinkkemper/supergateway) is a great tool, but it has structural issues on Windows that cause zombie processes:

1. **`shell: true` spawn** — creates `cmd.exe` intermediaries that survive parent death
2. **Missing cleanup callbacks** — `onSignals()` is called without cleanup functions
3. **No Windows signal handling** — SIGTERM/SIGHUP are not delivered on Windows
4. **No process tree kill** — `child.kill()` only kills the direct child, not grandchildren

sugarcoat solves all of these:

- Uses `cross-spawn` with `shell: false` — no intermediary processes
- Multi-path cleanup with `cleanupDone` guard — SIGINT, SIGTERM, SIGHUP, SIGBREAK, stdin close, exit event
- `taskkill /F /T /PID` on Windows for full tree kill
- Built-in `.env` loading eliminates PowerShell/cmd.exe wrapper layers

## License

MIT
