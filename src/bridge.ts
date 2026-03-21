import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './logger.js';
import { spawnManagedProcess } from './process-manager.js';
import { loadEnvFiles } from './env-loader.js';

export interface BridgeOptions {
  command: string;
  port: number;
  path: string;
  envFiles: string[];
  healthEndpoint: string;
  corsEnabled: boolean;
  logger: Logger;
}

/**
 * Start the MCP stdio-to-streamable-HTTP bridge.
 *
 * Architecture: Single child process per sugarcoat instance.
 * All HTTP sessions share the same child process's stdin/stdout.
 *
 * Routing:
 * - Requests (with id): tracked in a {id -> transport} map for response routing
 * - Notifications (no id): broadcast to all active sessions
 */
export async function startBridge(options: BridgeOptions): Promise<void> {
  const { command, port, path, envFiles, healthEndpoint, corsEnabled, logger } = options;

  // Load env files and merge with process.env for child process
  const envFromFiles = envFiles.length > 0 ? loadEnvFiles(envFiles, logger) : {};
  const childEnv = { ...process.env, ...envFromFiles } as Record<string, string>;

  // Spawn single child process
  const { child, cleanup } = spawnManagedProcess({
    command,
    env: childEnv,
    logger,
  });

  // Session management
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Request-response routing: {jsonrpc id -> transport}
  const pendingRequests = new Map<string | number, StreamableHTTPServerTransport>();

  // Buffer for incomplete lines from child stdout
  let stdoutBuffer = '';

  // Listen to child stdout for JSON-RPC responses
  // stdin/stdout are guaranteed to exist since we spawned with stdio: ['pipe', 'pipe', 'pipe']
  child.stdout!.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as JSONRPCMessage;
        routeResponse(msg);
      } catch {
        logger.debug(`Non-JSON from child stdout: ${trimmed}`);
      }
    }
  });

  function routeResponse(msg: JSONRPCMessage): void {
    // Response messages have an 'id' field matching the request
    if ('id' in msg && msg.id !== undefined) {
      const transport = pendingRequests.get(msg.id);
      if (transport) {
        pendingRequests.delete(msg.id);
        transport.send(msg).catch((err) => {
          logger.error(`Failed to send response: ${err}`);
        });
      } else {
        // If no pending request found, broadcast (might be a server-initiated response)
        broadcastToAll(msg);
      }
    } else {
      // Notifications (no id) — broadcast to all active sessions
      broadcastToAll(msg);
    }
  }

  function broadcastToAll(msg: JSONRPCMessage): void {
    for (const [sessionId, transport] of transports) {
      transport.send(msg).catch((err) => {
        logger.debug(`Failed to broadcast to session ${sessionId}: ${err}`);
      });
    }
  }

  function sendToChild(msg: JSONRPCMessage, transport: StreamableHTTPServerTransport): void {
    // Track request for response routing
    if ('id' in msg && msg.id !== undefined && 'method' in msg) {
      pendingRequests.set(msg.id, transport);
    }

    child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  // Express app setup
  const app = express();
  app.use(express.json());
  if (corsEnabled) {
    app.use(cors());
  }

  // POST /mcp — Client → Server messages (JSON-RPC)
  app.post(path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (isInitializeRequest(req.body)) {
      // New session
      const newSessionId = randomUUID();
      logger.info(`New session: ${newSessionId}`);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          logger.debug(`Session initialized: ${id}`);
        },
      });

      transport.onmessage = (msg) => {
        sendToChild(msg, transport);
      };

      transport.onclose = () => {
        const id = newSessionId;
        transports.delete(id);
        // Clean up any pending requests for this transport
        for (const [reqId, t] of pendingRequests) {
          if (t === transport) {
            pendingRequests.delete(reqId);
          }
        }
        logger.debug(`Session closed: ${id}`);
      };
    } else {
      res.status(400).json({ error: 'Bad request: no valid session or initialize request' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp — Server → Client notifications (SSE stream)
  app.get(path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — Session termination
  app.delete(path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // Health check
  app.get(healthEndpoint, (_req, res) => {
    res.send('ok');
  });

  // Child process exit — clean up pending requests and exit
  child.on('exit', (code, signal) => {
    logger.info(`Child process exited (code: ${code}, signal: ${signal})`);
    pendingRequests.clear();
    process.exit(code ?? 1);
  });

  // Start HTTP server
  const server = app.listen(port, () => {
    logger.info(`Listening on http://localhost:${port}${path}`);
    logger.info(`Health check: http://localhost:${port}${healthEndpoint}`);
  });

  // Graceful shutdown: cleanup child → close server → exit
  let shutdownInProgress = false;
  const gracefulShutdown = (signal: string) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info(`Caught ${signal}. Shutting down...`);
    cleanup();
    server.close(() => {
      process.exit(0);
    });
    // If server.close hangs, force exit after 3 seconds
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

  // Windows console close
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
  }

  // stdin close — parent process died
  process.stdin.on('close', () => gracefulShutdown('stdin-close'));
}
