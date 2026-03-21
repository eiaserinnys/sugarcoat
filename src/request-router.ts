import type { Writable } from 'stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './logger.js';

/**
 * Minimal interface for sending JSON-RPC messages.
 * Decouples RequestRouter from StreamableHTTPServerTransport for testability.
 */
export interface Sendable {
  send(msg: JSONRPCMessage): Promise<void>;
}

export interface RequestRouterOptions {
  childStdin: Writable;
  logger: Logger;
}

/**
 * Manages request ID namespacing, response routing, and notification routing
 * for multiple HTTP sessions sharing a single child process.
 *
 * - Requests get namespaced IDs (`sc_N`) to prevent collisions between sessions.
 * - Responses are routed back to the originating session with restored IDs.
 * - Progress notifications (with progressToken) are routed to the requesting session only.
 * - Other notifications are broadcast to all sessions.
 */
export class RequestRouter {
  private pendingRequests = new Map<string, { originalId: string | number; transport: Sendable }>();
  private sessions = new Map<string, Sendable>();
  private progressTokenMap = new Map<string | number, Sendable>();
  private globalRequestCounter = 0;

  private readonly childStdin: Writable;
  private readonly logger: Logger;

  constructor(options: RequestRouterOptions) {
    this.childStdin = options.childStdin;
    this.logger = options.logger;
  }

  // --- Session management ---

  addSession(sessionId: string, transport: Sendable): void {
    this.sessions.set(sessionId, transport);
  }

  removeSession(sessionId: string): void {
    const transport = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (transport) {
      this.removeSessionPending(transport);
    }
  }

  getSession(sessionId: string): Sendable | undefined {
    return this.sessions.get(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // --- Core routing ---

  /**
   * Forward a message from a client session to the child process.
   * Requests (with id) get namespaced IDs; notifications pass through as-is.
   */
  sendToChild(msg: JSONRPCMessage, transport: Sendable): void {
    if ('id' in msg && msg.id !== undefined && 'method' in msg) {
      const originalId = msg.id as string | number;
      const childId = `sc_${++this.globalRequestCounter}`;
      this.pendingRequests.set(childId, { originalId, transport });

      // Track progressToken for notification routing
      if ('params' in msg) {
        const params = (msg as Record<string, unknown>).params as Record<string, unknown> | undefined;
        const meta = params?._meta as Record<string, unknown> | undefined;
        const progressToken = meta?.progressToken as string | number | undefined;
        if (progressToken !== undefined) {
          this.progressTokenMap.set(progressToken, transport);
        }
      }

      const namespacedMsg = { ...msg, id: childId };
      this.childStdin.write(JSON.stringify(namespacedMsg) + '\n');
    } else {
      // Notifications (no id) — forward as-is
      this.childStdin.write(JSON.stringify(msg) + '\n');
    }
  }

  /**
   * Route a response from the child process back to the originating session.
   * If no pending request is found, broadcast to all sessions.
   */
  routeResponse(msg: JSONRPCMessage): void {
    if ('id' in msg && msg.id !== undefined) {
      const childId = String(msg.id);
      const pending = this.pendingRequests.get(childId);
      if (pending) {
        this.pendingRequests.delete(childId);
        const restored = { ...msg, id: pending.originalId } as JSONRPCMessage;
        pending.transport.send(restored).catch((err) => {
          this.logger.error(`Failed to send response: ${err}`);
        });
      } else {
        // No pending request found — broadcast (server-initiated message)
        this.broadcastToAll(msg);
      }
    } else {
      // Notifications (no id) — broadcast to all active sessions
      this.broadcastToAll(msg);
    }
  }

  /**
   * Route a notification from the child process.
   * Progress notifications (with progressToken) go to the requesting session only.
   * All other notifications are broadcast to all sessions.
   */
  routeNotification(msg: JSONRPCMessage): void {
    if ('method' in msg) {
      const method = (msg as Record<string, unknown>).method as string;
      if (method === 'notifications/progress') {
        const params = (msg as Record<string, unknown>).params as Record<string, unknown> | undefined;
        const progressToken = params?.progressToken as string | number | undefined;
        if (progressToken !== undefined) {
          const transport = this.progressTokenMap.get(progressToken);
          if (transport) {
            transport.send(msg).catch((err) => {
              this.logger.error(`Failed to send progress notification: ${err}`);
            });
            return;
          }
        }
      }
    }
    // Fallback: broadcast to all sessions
    this.broadcastToAll(msg);
  }

  /**
   * Send error responses to all pending requests (e.g., child process crashed).
   * Best-effort — transports may already be closed.
   */
  drainPending(): void {
    for (const [childId, pending] of this.pendingRequests) {
      const errorResponse = {
        jsonrpc: '2.0' as const,
        id: pending.originalId,
        error: {
          code: -32000,
          message: 'Child process exited unexpectedly',
        },
      };
      pending.transport.send(errorResponse as JSONRPCMessage).catch(() => {
        // Best-effort — transport may already be closed
      });
      this.pendingRequests.delete(childId);
    }
  }

  // --- Internal ---

  private broadcastToAll(msg: JSONRPCMessage): void {
    for (const [sessionId, transport] of this.sessions) {
      transport.send(msg).catch((err) => {
        this.logger.debug(`Failed to broadcast to session ${sessionId}: ${err}`);
      });
    }
  }

  private removeSessionPending(transport: Sendable): void {
    for (const [childId, pending] of this.pendingRequests) {
      if (pending.transport === transport) {
        this.pendingRequests.delete(childId);
      }
    }
    // Also clean up progressTokenMap entries for this transport
    for (const [token, t] of this.progressTokenMap) {
      if (t === transport) {
        this.progressTokenMap.delete(token);
      }
    }
  }
}
