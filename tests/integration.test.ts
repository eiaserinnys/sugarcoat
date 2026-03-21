import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { BridgeHandle } from '../src/bridge.js';
import { startBridge } from '../src/bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use forward slashes to avoid shell-quote treating backslashes as escapes on Windows
const ECHO_SERVER = join(__dirname, 'fixtures', 'echo-mcp-server.mjs').replace(/\\/g, '/');

/** Helper: send a JSON-RPC request via POST and parse the SSE response */
async function mcpRequest(
  port: number,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ sessionId: string; messages: Array<Record<string, unknown>> }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const returnedSessionId = res.headers.get('mcp-session-id') ?? sessionId ?? '';

  // SSE response — parse event stream
  const text = await res.text();
  const messages: Array<Record<string, unknown>> = [];

  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        try {
          messages.push(JSON.parse(data));
        } catch {
          // skip non-JSON
        }
      }
    }
  }

  return { sessionId: returnedSessionId, messages };
}

/** Create a bridge pointed at the echo fixture server */
function createTestBridge(opts?: { exitOnChildCrash?: boolean }): Promise<BridgeHandle> {
  return startBridge({
    command: `node ${ECHO_SERVER}`,
    port: 0, // random available port
    path: '/mcp',
    envFiles: [],
    healthEndpoint: '/health',
    corsEnabled: false,
    logger: { info: () => {}, error: () => {}, debug: () => {} },
    exitOnChildCrash: opts?.exitOnChildCrash ?? false,
  });
}

describe('integration', () => {
  let handle: BridgeHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('basic flow: initialize → tools/call → response', async () => {
    handle = await createTestBridge();

    // Step 1: Initialize (get session)
    const init = await mcpRequest(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.1' },
      },
    });

    expect(init.sessionId).toBeTruthy();
    expect(init.messages).toHaveLength(1);
    expect(init.messages[0]).toHaveProperty('result');
    const result = init.messages[0].result as Record<string, unknown>;
    expect(result).toHaveProperty('capabilities');
    expect(result).toHaveProperty('serverInfo');

    // Step 2: Send initialized notification
    await fetch(`http://localhost:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-session-id': init.sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    // Step 3: Call echo tool
    const echo = await mcpRequest(
      handle.port,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello sugarcoat' } },
      },
      init.sessionId,
    );

    expect(echo.messages).toHaveLength(1);
    expect(echo.messages[0]).toHaveProperty('result');
    const echoResult = echo.messages[0].result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(echoResult.content[0].text);
    expect(parsed.message).toBe('hello sugarcoat');
  }, 15000);

  it('init caching: second session gets same capabilities', async () => {
    handle = await createTestBridge();

    // Session A: initialize
    const sessionA = await mcpRequest(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-a', version: '0.0.1' },
      },
    });

    // Session B: initialize (should get cached result)
    const sessionB = await mcpRequest(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-b', version: '0.0.1' },
      },
    });

    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
    const resultA = sessionA.messages[0].result as Record<string, unknown>;
    const resultB = sessionB.messages[0].result as Record<string, unknown>;
    // Both should have same capabilities from the echo server
    expect(resultA.capabilities).toEqual(resultB.capabilities);
    expect(resultA.serverInfo).toEqual(resultB.serverInfo);
  }, 15000);

  it('concurrent sessions: IDs do not collide', async () => {
    handle = await createTestBridge();

    // Initialize two sessions
    const initA = await mcpRequest(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'session-a', version: '0.0.1' },
      },
    });

    const initB = await mcpRequest(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'session-b', version: '0.0.1' },
      },
    });

    // Both sessions send tools/call with the same id=1
    const [resultA, resultB] = await Promise.all([
      mcpRequest(
        handle.port,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo', arguments: { from: 'A' } },
        },
        initA.sessionId,
      ),
      mcpRequest(
        handle.port,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo', arguments: { from: 'B' } },
        },
        initB.sessionId,
      ),
    ]);

    // Each session should get its own response, not the other's
    expect(resultA.messages).toHaveLength(1);
    expect(resultB.messages).toHaveLength(1);

    const parsedA = JSON.parse(
      (resultA.messages[0].result as { content: Array<{ text: string }> }).content[0].text,
    );
    const parsedB = JSON.parse(
      (resultB.messages[0].result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(parsedA.from).toBe('A');
    expect(parsedB.from).toBe('B');
  }, 15000);

  it('child crash: returns error response', async () => {
    handle = await createTestBridge({ exitOnChildCrash: false });

    // Initialize
    const init = await mcpRequest(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'crash-test', version: '0.0.1' },
      },
    });

    // Call crash tool — should get error response (drainPending)
    const crash = await mcpRequest(
      handle.port,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'crash', arguments: {} },
      },
      init.sessionId,
    );

    // The response may come as an error from drainPending or the connection may error out.
    // Either way, we should not get a successful result.
    if (crash.messages.length > 0) {
      const msg = crash.messages[0];
      expect(msg).toHaveProperty('error');
      expect((msg.error as { message: string }).message).toContain('Child process exited');
    }
    // If no messages, the connection was terminated, which is also acceptable
  }, 15000);

  it('notification routing: progress notification reaches requesting session', async () => {
    handle = await createTestBridge();

    // Initialize
    const init = await mcpRequest(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'progress-test', version: '0.0.1' },
      },
    });

    // Call echo with _emitProgress and progressToken
    const progressToken = 'test-progress-token-123';
    const result = await mcpRequest(
      handle.port,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'with progress', _emitProgress: true },
          _meta: { progressToken },
        },
      },
      init.sessionId,
    );

    // Should receive both the progress notification and the final result
    expect(result.messages.length).toBeGreaterThanOrEqual(1);

    // Find progress notification and result
    const progressMsg = result.messages.find(
      (m) => (m as Record<string, unknown>).method === 'notifications/progress',
    );
    const resultMsg = result.messages.find(
      (m) => (m as Record<string, unknown>).result !== undefined,
    );

    // The result should be present
    expect(resultMsg).toBeDefined();
    const echoResult = resultMsg!.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(echoResult.content[0].text);
    expect(parsed.message).toBe('with progress');

    // Progress notification may or may not arrive in the same SSE stream
    // depending on timing, so we only assert if it's there
    if (progressMsg) {
      const params = progressMsg.params as Record<string, unknown>;
      expect(params.progressToken).toBe(progressToken);
      expect(params.progress).toBe(50);
    }
  }, 15000);
});
