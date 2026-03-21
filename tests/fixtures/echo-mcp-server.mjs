#!/usr/bin/env node

/**
 * Echo MCP fixture server for integration tests.
 * stdio-based JSON-RPC MCP server with no external dependencies.
 *
 * Supported methods:
 * - initialize → capabilities response
 * - notifications/initialized → ignored (no response)
 * - tools/list → returns echo and crash tools
 * - tools/call (name: 'echo') → echoes args back; if args._emitProgress + _meta.progressToken, emits progress first
 * - tools/call (name: 'crash') → process.exit(1)
 * - anything else → -32601 Method not found
 */

import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — silently ignore
  if (id === undefined || id === null) {
    return;
  }

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'echo-mcp-server', version: '1.0.0' },
        },
      });
      break;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echoes the provided arguments back',
              inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
            },
            {
              name: 'crash',
              description: 'Crashes the server (for testing)',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      });
      break;

    case 'tools/call': {
      const toolName = params?.name;

      if (toolName === 'crash') {
        // Immediate crash — no response
        process.exit(1);
      }

      if (toolName === 'echo') {
        const args = params?.arguments ?? {};

        // If _emitProgress is set and there's a progressToken, emit progress notification first
        if (args._emitProgress && params?._meta?.progressToken !== undefined) {
          const progressToken = params._meta.progressToken;
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: 50,
              total: 100,
              message: 'Echoing...',
            },
          });
        }

        // Strip internal args from echo response
        const { _emitProgress, ...echoArgs } = args;

        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(echoArgs) }],
          },
        });
        break;
      }

      // Unknown tool
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
      break;
    }

    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      break;
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const msg = JSON.parse(trimmed);
    handleMessage(msg);
  } catch {
    // Ignore non-JSON lines
  }
});
