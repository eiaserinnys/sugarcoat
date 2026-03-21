import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCommandString, killProcessTree } from '../src/process-manager.js';

describe('parseCommandString', () => {
  it('should parse a simple command', () => {
    const result = parseCommandString('echo hello');
    expect(result.file).toBe('echo');
    expect(result.args).toEqual(['hello']);
  });

  it('should parse a command with multiple arguments', () => {
    const result = parseCommandString('npx -y @delorenj/mcp-server-trello');
    expect(result.file).toBe('npx');
    expect(result.args).toEqual(['-y', '@delorenj/mcp-server-trello']);
  });

  it('should handle quoted strings', () => {
    const result = parseCommandString('echo "hello world"');
    expect(result.file).toBe('echo');
    expect(result.args).toEqual(['hello world']);
  });

  it('should handle single-quoted strings', () => {
    const result = parseCommandString("echo 'hello world'");
    expect(result.file).toBe('echo');
    expect(result.args).toEqual(['hello world']);
  });

  it('should handle escaped spaces', () => {
    const result = parseCommandString('echo hello\\ world');
    expect(result.file).toBe('echo');
    expect(result.args).toEqual(['hello world']);
  });

  it('should throw on empty command', () => {
    expect(() => parseCommandString('')).toThrow('Invalid command');
  });

  it('should handle command with flags', () => {
    const result = parseCommandString('npx -y chrome-devtools-mcp@latest --autoConnect');
    expect(result.file).toBe('npx');
    expect(result.args).toEqual(['-y', 'chrome-devtools-mcp@latest', '--autoConnect']);
  });
});

describe('killProcessTree', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should not throw when killing a non-existent process', () => {
    // PID 999999 is very unlikely to exist
    expect(() => killProcessTree(999999)).not.toThrow();
  });

  it('should silently return for invalid PIDs', () => {
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
    expect(() => killProcessTree(NaN)).not.toThrow();
    expect(() => killProcessTree(1.5)).not.toThrow();
  });
});
