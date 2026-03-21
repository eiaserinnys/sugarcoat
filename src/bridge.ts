import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './logger.js';
import { spawnManagedProcess } from './process-manager.js';
import { loadEnvFiles } from './env-loader.js';
import { RequestRouter } from './request-router.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SUGARCOAT_VERSION = '0.1.0';

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
 * Classify an incoming message from a client session.
 *
 * - initialize requests: return cached result (if child already initialized) or forward
 * - notifications/initialized: drop (child is already initialized)
 * - everything else: forward to child
 */
export function classifyIncomingMessage(
  msg: JSONRPCMessage,
  childInitialized: boolean,
): 'return-cached-init' | 'drop-initialized-notification' | 'forward-to-child' {
  if ('method' in msg) {
    const method = (msg as Record<string, unknown>).method as string;
    if (method === 'initialize' && 'id' in msg) {
      return childInitialized ? 'return-cached-init' : 'forward-to-child';
    }
    if (method === 'notifications/initialized') {
      return 'drop-initialized-notification';
    }
  }
  return 'forward-to-child';
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
 * - Progress notifications (with progressToken): routed to requesting session only
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

  // Request router: handles ID namespacing, response routing, notification routing
  const router = new RequestRouter({ childStdin: child.stdin!, logger });

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

        // Route responses and notifications from child
        if ('id' in msg && msg.id !== undefined) {
          router.routeResponse(msg);
        } else {
          router.routeNotification(msg);
        }
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

    if (sessionId && router.hasSession(sessionId)) {
      transport = router.getSession(sessionId)! as StreamableHTTPServerTransport;
    } else if (isInitializeRequest(req.body)) {
      // New session
      const newSessionId = randomUUID();
      logger.info(`New session: ${newSessionId}`);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id) => {
          router.addSession(id, transport);
          logger.debug(`Session initialized: ${id}`);
        },
      });

      transport.onmessage = (msg) => {
        const action = classifyIncomingMessage(msg, childInitialized);
        switch (action) {
          case 'return-cached-init': {
            const response = {
              jsonrpc: '2.0' as const,
              id: (msg as Record<string, unknown>).id,
              result: cachedInitResult,
            };
            transport.send(response as JSONRPCMessage).catch((err) => {
              logger.error(`Failed to send cached init response: ${err}`);
            });
            break;
          }
          case 'drop-initialized-notification':
            // Silently drop — child is already initialized
            break;
          case 'forward-to-child':
            router.sendToChild(msg, transport);
            break;
        }
      };

      transport.onclose = () => {
        router.removeSession(newSessionId);
        logger.debug(`Session closed: ${newSessionId}`);
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
    if (!sessionId || !router.hasSession(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    const transport = router.getSession(sessionId)! as StreamableHTTPServerTransport;
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — Session termination
  app.delete(path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !router.hasSession(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    const transport = router.getSession(sessionId)! as StreamableHTTPServerTransport;
    await transport.handleRequest(req, res);
  });

  // Health check
  app.get(healthEndpoint, (_req, res) => {
    res.send('ok');
  });

  // Child process exit — send errors to pending requests, close server, exit
  child.on('exit', (code, signal) => {
    logger.error(`Child process died unexpectedly (code: ${code}, signal: ${signal})`);
    router.drainPending();

    // Close Express server, then exit
    server.close(() => {
      process.exit(code ?? 1);
    });
    // If server.close hangs, force exit after 3 seconds
    setTimeout(() => process.exit(code ?? 1), 3000).unref();
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
