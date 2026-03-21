import { execSync, type ChildProcess } from 'child_process';
import crossSpawn from 'cross-spawn';
import { parse as parseCommand } from 'shell-quote';
import type { Logger } from './logger.js';

export interface ProcessManagerOptions {
  /** Full command string (e.g. "npx -y @delorenj/mcp-server-trello") */
  command: string;
  /** Environment variables to pass to the child process */
  env?: Record<string, string>;
  /** Logger instance */
  logger: Logger;
}

export interface ManagedProcess {
  /** The spawned child process */
  child: ChildProcess;
  /** Kill the process tree and clean up */
  cleanup: () => void;
}

/**
 * Kill an entire process tree rooted at the given PID.
 *
 * Windows: taskkill /F /T /PID — kills entire tree including intermediaries.
 * Unix: direct pid SIGTERM — npx child processes are cleaned up when parent dies.
 * detached is NOT used, so process group kill (-pid) is not applicable.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return; // Invalid PID — nothing to kill
  }

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch {
      // Process already exited — ignore
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already exited — ignore
    }
  }
}

/**
 * Parse a command string into executable and arguments.
 * Uses shell-quote for proper handling of quotes, escapes, and spaces.
 */
export function parseCommandString(command: string): { file: string; args: string[] } {
  const tokens = parseCommand(command);
  // shell-quote may return operator objects for pipes, etc.
  // We only support simple commands — filter to string tokens only.
  const stringTokens = tokens.filter((t): t is string => typeof t === 'string');

  if (stringTokens.length === 0) {
    throw new Error(`Invalid command: "${command}"`);
  }

  return {
    file: stringTokens[0],
    args: stringTokens.slice(1),
  };
}

/**
 * Spawn a child process with proper lifecycle management.
 *
 * - Uses cross-spawn for Windows .cmd/.bat resolution
 * - shell: false to minimize process tree depth
 * - Returns child process and cleanup function
 * - Signal handling is NOT registered here — the caller (bridge.ts) is
 *   responsible for calling cleanup() in its own signal/shutdown handlers
 *   to avoid conflicting process.exit() calls.
 */
export function spawnManagedProcess(options: ProcessManagerOptions): ManagedProcess {
  const { command, env, logger } = options;

  const { file, args } = parseCommandString(command);
  logger.info(`Spawning: ${file} ${args.join(' ')}`);

  const child = crossSpawn(file, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env,
  });

  if (!child.pid) {
    throw new Error(`Failed to spawn process: ${command}`);
  }

  const pid = child.pid;
  logger.info(`Child process started (PID: ${pid})`);

  let cleanupDone = false;

  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    logger.info(`Cleaning up child process tree (PID: ${pid})`);
    killProcessTree(pid);
  };

  // Stage 2 (last-resort): process 'exit' event safety net.
  // If the caller's signal handler already called cleanup(), cleanupDone
  // prevents double-kill. This catches unexpected exits where no signal
  // handler ran.
  process.once('exit', () => {
    if (!cleanupDone) {
      killProcessTree(pid);
    }
  });

  // Note: child stderr logging is handled by bridge.ts with line-buffered parsing.
  // Do not register a duplicate stderr listener here.

  return { child, cleanup };
}
