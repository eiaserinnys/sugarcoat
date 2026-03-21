import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import type { Writable } from 'stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { RequestRouter, type Sendable } from '../src/request-router.js';
import type { Logger } from '../src/logger.js';

function createMockTransport(): Sendable & { sent: JSONRPCMessage[] } {
  const sent: JSONRPCMessage[] = [];
  return {
    sent,
    send: vi.fn(async (msg: JSONRPCMessage) => { sent.push(msg); }),
  };
}

function createMockStdin(): Writable & { written: string[] } {
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.write = vi.fn((chunk: any) => { written.push(chunk.toString()); return true; }) as any;
  return Object.assign(stdin, { written });
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
}

function createRouter(stdin?: Writable & { written: string[] }) {
  const mockStdin = stdin ?? createMockStdin();
  const logger = createMockLogger();
  const router = new RequestRouter({ childStdin: mockStdin, logger });
  return { router, stdin: mockStdin, logger };
}

describe('RequestRouter', () => {
  describe('ID Namespacing', () => {
    it('should namespace request IDs as sc_1, sc_2, ...', () => {
      const { router, stdin } = createRouter();
      const transport = createMockTransport();

      const msg1: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} } as JSONRPCMessage;
      const msg2: JSONRPCMessage = { jsonrpc: '2.0', id: 'abc', method: 'tools/list' } as JSONRPCMessage;

      router.sendToChild(msg1, transport);
      router.sendToChild(msg2, transport);

      expect(stdin.written).toHaveLength(2);
      const parsed1 = JSON.parse(stdin.written[0]);
      const parsed2 = JSON.parse(stdin.written[1]);
      expect(parsed1.id).toBe('sc_1');
      expect(parsed2.id).toBe('sc_2');
    });

    it('should restore original ID when routing response back', async () => {
      const { router, stdin } = createRouter();
      const transport = createMockTransport();

      const request: JSONRPCMessage = { jsonrpc: '2.0', id: 42, method: 'tools/call', params: {} } as JSONRPCMessage;
      router.sendToChild(request, transport);

      // Child responds with namespaced ID
      const response: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 'sc_1',
        result: { content: [] },
      } as JSONRPCMessage;
      router.routeResponse(response);

      // Wait for async send
      await vi.waitFor(() => {
        expect(transport.sent).toHaveLength(1);
      });
      expect(transport.sent[0]).toHaveProperty('id', 42);
    });

    it('should remove from pending after response is routed', async () => {
      const { router } = createRouter();
      const transport1 = createMockTransport();
      const transport2 = createMockTransport();

      router.addSession('s1', transport1);
      router.addSession('s2', transport2);

      const request: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} } as JSONRPCMessage;
      router.sendToChild(request, transport1);

      // First response — routed to transport1
      const response: JSONRPCMessage = { jsonrpc: '2.0', id: 'sc_1', result: {} } as JSONRPCMessage;
      router.routeResponse(response);

      await vi.waitFor(() => {
        expect(transport1.sent).toHaveLength(1);
      });

      // Second response with same ID — not in pending, so broadcast
      const response2: JSONRPCMessage = { jsonrpc: '2.0', id: 'sc_1', result: { extra: true } } as JSONRPCMessage;
      router.routeResponse(response2);

      await vi.waitFor(() => {
        expect(transport1.sent).toHaveLength(2); // broadcast
        expect(transport2.sent).toHaveLength(1); // broadcast
      });
    });

    it('should broadcast response with unknown ID to all sessions', async () => {
      const { router } = createRouter();
      const t1 = createMockTransport();
      const t2 = createMockTransport();
      router.addSession('s1', t1);
      router.addSession('s2', t2);

      const response: JSONRPCMessage = { jsonrpc: '2.0', id: 'unknown_id', result: {} } as JSONRPCMessage;
      router.routeResponse(response);

      await vi.waitFor(() => {
        expect(t1.sent).toHaveLength(1);
        expect(t2.sent).toHaveLength(1);
      });
    });

    it('should forward notifications (no id) as-is to child stdin', () => {
      const { router, stdin } = createRouter();
      const transport = createMockTransport();

      const notification: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'x' },
      } as JSONRPCMessage;
      router.sendToChild(notification, transport);

      expect(stdin.written).toHaveLength(1);
      const parsed = JSON.parse(stdin.written[0]);
      expect(parsed).not.toHaveProperty('id');
      expect(parsed.method).toBe('notifications/cancelled');
    });
  });

  describe('Notification Routing', () => {
    it('should route progress notification to the session that sent the request with matching progressToken', async () => {
      const { router } = createRouter();
      const t1 = createMockTransport();
      const t2 = createMockTransport();
      router.addSession('s1', t1);
      router.addSession('s2', t2);

      // Session 1 sends a request with progressToken
      const request: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { _meta: { progressToken: 'pt-1' }, name: 'some_tool' },
      } as JSONRPCMessage;
      router.sendToChild(request, t1);

      // Child sends progress notification with matching token
      const progressNotification: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'pt-1', progress: 50, total: 100 },
      } as JSONRPCMessage;
      router.routeNotification(progressNotification);

      await vi.waitFor(() => {
        expect(t1.sent).toHaveLength(1);
      });
      expect(t2.sent).toHaveLength(0); // Not broadcast to t2
    });

    it('should broadcast notifications without progressToken to all sessions', async () => {
      const { router } = createRouter();
      const t1 = createMockTransport();
      const t2 = createMockTransport();
      router.addSession('s1', t1);
      router.addSession('s2', t2);

      const notification: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: 'file:///a' },
      } as JSONRPCMessage;
      router.routeNotification(notification);

      await vi.waitFor(() => {
        expect(t1.sent).toHaveLength(1);
        expect(t2.sent).toHaveLength(1);
      });
    });

    it('should clean up pending requests when session is removed', async () => {
      const { router } = createRouter();
      const t1 = createMockTransport();
      const t2 = createMockTransport();
      router.addSession('s1', t1);
      router.addSession('s2', t2);

      // Session 1 sends requests
      const req1: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} } as JSONRPCMessage;
      const req2: JSONRPCMessage = { jsonrpc: '2.0', id: 2, method: 'tools/list' } as JSONRPCMessage;
      router.sendToChild(req1, t1);
      router.sendToChild(req2, t1);

      // Session 2 sends a request
      const req3: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} } as JSONRPCMessage;
      router.sendToChild(req3, t2);

      // Remove session 1
      router.removeSession('s1');

      // Response to session 1's request — should broadcast since session was removed
      const response: JSONRPCMessage = { jsonrpc: '2.0', id: 'sc_1', result: {} } as JSONRPCMessage;
      router.routeResponse(response);

      await vi.waitFor(() => {
        // t1 is no longer in sessions, so broadcast goes to t2 only
        expect(t2.sent).toHaveLength(1);
      });
      expect(t1.sent).toHaveLength(0);

      // Response to session 2's request — should route correctly
      const response3: JSONRPCMessage = { jsonrpc: '2.0', id: 'sc_3', result: {} } as JSONRPCMessage;
      router.routeResponse(response3);

      await vi.waitFor(() => {
        expect(t2.sent).toHaveLength(2);
      });
    });
  });

  describe('Drain', () => {
    it('should send error responses to all pending requests', async () => {
      const { router } = createRouter();
      const t1 = createMockTransport();
      const t2 = createMockTransport();

      const req1: JSONRPCMessage = { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: {} } as JSONRPCMessage;
      const req2: JSONRPCMessage = { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: {} } as JSONRPCMessage;
      router.sendToChild(req1, t1);
      router.sendToChild(req2, t2);

      router.drainPending();

      await vi.waitFor(() => {
        expect(t1.sent).toHaveLength(1);
        expect(t2.sent).toHaveLength(1);
      });

      // Check error response structure
      const err1 = t1.sent[0] as any;
      expect(err1.id).toBe('a'); // Original ID restored
      expect(err1.error.code).toBe(-32000);

      const err2 = t2.sent[0] as any;
      expect(err2.id).toBe('b');
      expect(err2.error.code).toBe(-32000);
    });
  });

  describe('Session Management', () => {
    it('should add, get, has, and remove sessions', () => {
      const { router } = createRouter();
      const t = createMockTransport();

      expect(router.hasSession('s1')).toBe(false);
      router.addSession('s1', t);
      expect(router.hasSession('s1')).toBe(true);
      expect(router.getSession('s1')).toBe(t);

      router.removeSession('s1');
      expect(router.hasSession('s1')).toBe(false);
      expect(router.getSession('s1')).toBeUndefined();
    });
  });
});
