import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './logger.js';
import { spawnManagedProcess } from './process-manager.js';
import { loadEnvFiles } from './env-loader.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SUGARCOAT_VERSION = '1.0.0';

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
 * Initialization:
 *   The child is initialized ONCE at startup. Subsequent HTTP sessions
 *   receive cached capabilities without re-initializing the child.
 *   This prevents stateful MCP servers (e.g., chrome-devtools-mcp)
 *   from losing internal state due to repeated initialization.
 *
 * Request ID namespacing:
 *   Multiple HTTP sessions may use the same JSON-RPC id (e.g., both send id=1).
 *   To prevent routing collisions, sugarcoat prepends a session-unique prefix
 *   when forwarding to the child, and strips it when routing responses back.
 *
 * Routing:
 * - Requests (with id): namespaced, tracked in {childId -> (originalId, transport)}
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

  // Request-response routing with id namespacing:
  // childId (namespaced) -> { originalId, transport }
  const pendingRequests = new Map<string, {
    originalId: string | number;
    transport: StreamableHTTPServerTransport;
  }>();

  // Per-session counter for generating unique namespaced ids
  let globalRequestCounter = 0;

  // Buffer for incomplete lines from child stdout
  let stdoutBuffer = '';

  // Handle stdin write errors (e.g., child process died while writing)
  child.stdin!.on('error', (err) => {
    logger.debug(`stdin write error: ${err.message}`);
  });

  // Forward child stderr to logger for diagnostics
  let stderrBuffer = '';
  child.stderr!.on('data', (data: Buffer) => {
    stderrBuffer += data.toString();
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        logger.info(`[child stderr] ${trimmed}`);
      }
    }
  });

  // === Child initialization ===
  // Initialize the child process ONCE at startup and cache the result.
  // HTTP sessions receive cached capabilities without re-initializing.

  let cachedInitResult: unknown = null;
  let childInitialized = false;
  let initResolve: (() => void) | null = null;
  const initId = `__sugarcoat_init_${Date.now()}`;

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

        // During startup initialization, intercept the init response
        if (!childInitialized && 'id' in msg && msg.id === initId) {
          cachedInitResult = (msg as Record<string, unknown>).result;
          childInitialized = true;
          logger.info('Child process initialized');
          // Complete handshake: send initialized notification
          child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          }) + '\n');
          initResolve?.();
          continue;
        }

        routeResponse(msg);
      } catch {
        logger.debug(`Non-JSON from child stdout: ${trimmed}`);
      }
    }
  });

  // Send initialize request to child
  child.stdin!.write(JSON.stringify({
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sugarcoat', version: SUGARCOAT_VERSION },
    },
  }) + '\n');

  // Wait for child to respond
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Child initialization timed out (30s)'));
    }, 30000);
    initResolve = () => {
      clearTimeout(timeout);
      resolve();
    };
  });

  // === Response routing with id de-namespacing ===

  function routeResponse(msg: JSONRPCMessage): void {
    if ('id' in msg && msg.id !== undefined) {
      // Look up the namespaced id to find the original id and transport
      const childId = String(msg.id);
      const pending = pendingRequests.get(childId);
      if (pending) {
        pendingRequests.delete(childId);
        // Restore the original id before sending to client
        const restored = { ...msg, id: pending.originalId } as JSONRPCMessage;
        pending.transport.send(restored).catch((err) => {
          logger.error(`Failed to send response: ${err}`);
        });
      } else {
        // No pending request found — broadcast (server-initiated message)
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
    if ('id' in msg && msg.id !== undefined && 'method' in msg) {
      // Namespace the id to prevent collisions between sessions
      const originalId = msg.id as string | number;
      const childId = `sc_${++globalRequestCounter}`;
      pendingRequests.set(childId, { originalId, transport });
      // Replace id and forward to child
      const namespacedMsg = { ...msg, id: childId };
      child.stdin!.write(JSON.stringify(namespacedMsg) + '\n');
    } else {
      // Notifications (no id) — forward as-is
      child.stdin!.write(JSON.stringify(msg) + '\n');
    }
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
        // Intercept initialize — return cached response without forwarding to child
        if ('method' in msg && (msg as Record<string, unknown>).method === 'initialize' && 'id' in msg) {
          if (childInitialized) {
            const response = {
              jsonrpc: '2.0' as const,
              id: (msg as Record<string, unknown>).id,
              result: cachedInitResult,
            };
            transport.send(response as JSONRPCMessage).catch((err) => {
              logger.error(`Failed to send cached init response: ${err}`);
            });
          }
          return;
        }

        // Intercept initialized notification — child already initialized
        if ('method' in msg && (msg as Record<string, unknown>).method === 'notifications/initialized') {
          return;
        }

        // Everything else: forward to child with namespaced id
        sendToChild(msg, transport);
      };

      transport.onclose = () => {
        const id = newSessionId;
        transports.delete(id);
        // Clean up any pending requests for this transport
        for (const [reqId, pending] of pendingRequests) {
          if (pending.transport === transport) {
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
