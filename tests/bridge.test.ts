import { describe, it, expect } from 'vitest';

// Bridge tests are integration-level since they require Express + child process.
// Basic smoke tests are kept here; full integration testing requires running services.

describe('bridge', () => {
  it('should be importable', async () => {
    const mod = await import('../src/bridge.js');
    expect(mod.startBridge).toBeDefined();
    expect(typeof mod.startBridge).toBe('function');
  });
});
