import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { BridgeHandle } from '../src/bridge.js';
import { startBridge } from '../src/bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use forward slashes to avoid shell-quote treating backslashes as escapes on Windows
const ECHO_SERVER = join(__dirname, 'fixtures', 'echo-mcp-server.mjs').replace(/\\/g, '/');
const DIST_ENTRY = join(__dirname, '..', 'dist', 'index.js');

const silentLogger = { info: () => {}, error: () => {}, debug: () => {} };

/** Start a bridge around the echo fixture with a custom initialization timeout. */
function startTestBridge(command: string, initTimeoutMs: number): Promise<BridgeHandle> {
  return startBridge({
    command,
    port: 0, // random available port
    path: '/mcp',
    envFiles: [],
    healthEndpoint: '/health',
    corsEnabled: false,
    logger: silentLogger,
    exitOnChildCrash: false,
    initTimeoutMs,
  });
}

describe('initialization timeout', () => {
  let handle: BridgeHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('(a) rejects near the limit when the child initializes slower than the limit', async () => {
    const startedAt = Date.now();

    await expect(
      startTestBridge(`node ${ECHO_SERVER} --init-delay=1500`, 300),
    ).rejects.toThrow('Child initialization timed out (0.3s)');

    const elapsed = Date.now() - startedAt;
    // Rejected by the 300ms timer, not by the 1500ms fixture response
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(10000);
  }, 20000);

  it('(b) starts normally when the child initializes within the limit', async () => {
    handle = await startTestBridge(`node ${ECHO_SERVER} --init-delay=200`, 5000);

    expect(handle.port).toBeGreaterThan(0);
  }, 20000);

  it('(c) rejects promptly when the child exits without answering initialize', async () => {
    const startedAt = Date.now();

    await expect(
      startTestBridge(`node ${ECHO_SERVER} --exit-before-init`, 10000),
    ).rejects.toThrow(/Child exited during initialization \(code: 1, signal: .*\)/);

    const elapsed = Date.now() - startedAt;
    // Much faster than the 10s limit — no waiting for the timeout
    expect(elapsed).toBeLessThan(5000);
  }, 20000);

  it('(d) built CLI exits non-zero at --init-timeout seconds', async () => {
    expect(
      existsSync(DIST_ENTRY),
      'dist/index.js is missing — run `pnpm build` before `pnpm test`',
    ).toBe(true);

    const startedAt = Date.now();
    const { code, output } = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            DIST_ENTRY,
            '--stdio', `node ${ECHO_SERVER} --init-delay=10000`,
            '--port', '0',
            '--init-timeout', '0.5',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );

        let output = '';
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
        child.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
        child.on('error', reject);
        child.on('close', (exitCode) => resolve({ code: exitCode, output }));
      },
    );

    const elapsed = Date.now() - startedAt;
    expect(code).not.toBe(0);
    expect(output).toContain('Child initialization timed out (0.5s)');
    expect(elapsed).toBeLessThan(10000);
  }, 30000);
});
