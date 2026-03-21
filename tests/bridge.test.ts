import { describe, it, expect, beforeAll } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// Bridge tests are integration-level since they require Express + child process.
// Basic smoke tests are kept here; full integration testing requires running services.

describe('bridge', () => {
  it('should be importable', async () => {
    const mod = await import('../src/bridge.js');
    expect(mod.startBridge).toBeDefined();
    expect(typeof mod.startBridge).toBe('function');
  });
});

describe('classifyIncomingMessage', () => {
  let classifyIncomingMessage: (msg: JSONRPCMessage, childInitialized: boolean) => string;

  beforeAll(async () => {
    const mod = await import('../src/bridge.js');
    classifyIncomingMessage = mod.classifyIncomingMessage;
  });

  it('should return "return-cached-init" for initialize request when child is initialized', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } as JSONRPCMessage;
    expect(classifyIncomingMessage(msg, true)).toBe('return-cached-init');
  });

  it('should return "forward-to-child" for initialize request when child is NOT initialized', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } as JSONRPCMessage;
    expect(classifyIncomingMessage(msg, false)).toBe('forward-to-child');
  });

  it('should return "drop-initialized-notification" for notifications/initialized', () => {
    const msg = { jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage;
    expect(classifyIncomingMessage(msg, true)).toBe('drop-initialized-notification');
  });

  it('should return "forward-to-child" for regular tools/call', () => {
    const msg = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_file' } } as JSONRPCMessage;
    expect(classifyIncomingMessage(msg, true)).toBe('forward-to-child');
  });
});
