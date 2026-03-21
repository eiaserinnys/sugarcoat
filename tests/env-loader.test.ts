import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadEnvFiles } from '../src/env-loader.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('none');

describe('loadEnvFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sugarcoat-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should parse basic key-value pairs', () => {
    const envFile = join(tempDir, '.env');
    writeFileSync(envFile, 'KEY1=value1\nKEY2=value2\n');

    const result = loadEnvFiles([envFile], logger);
    expect(result).toEqual({ KEY1: 'value1', KEY2: 'value2' });
  });

  it('should ignore comments and blank lines', () => {
    const envFile = join(tempDir, '.env');
    writeFileSync(envFile, '# Comment\nKEY1=value1\n\n# Another comment\nKEY2=value2\n');

    const result = loadEnvFiles([envFile], logger);
    expect(result).toEqual({ KEY1: 'value1', KEY2: 'value2' });
  });

  it('should handle quoted values', () => {
    const envFile = join(tempDir, '.env');
    writeFileSync(envFile, 'KEY1="value with spaces"\nKEY2=\'single quoted\'\n');

    const result = loadEnvFiles([envFile], logger);
    expect(result).toEqual({ KEY1: 'value with spaces', KEY2: 'single quoted' });
  });

  it('should merge multiple env files', () => {
    const envFile1 = join(tempDir, '.env1');
    const envFile2 = join(tempDir, '.env2');
    writeFileSync(envFile1, 'KEY1=value1\nKEY2=from_first\n');
    writeFileSync(envFile2, 'KEY2=from_second\nKEY3=value3\n');

    const result = loadEnvFiles([envFile1, envFile2], logger);
    expect(result).toEqual({
      KEY1: 'value1',
      KEY2: 'from_second', // Later file wins
      KEY3: 'value3',
    });
  });

  it('should return empty object for no files', () => {
    const result = loadEnvFiles([], logger);
    expect(result).toEqual({});
  });

  it('should throw on non-existent file', () => {
    expect(() => loadEnvFiles(['/nonexistent/.env'], logger)).toThrow('Failed to load env file');
  });

  it('should not pollute process.env', () => {
    const envFile = join(tempDir, '.env');
    const uniqueKey = `SUGARCOAT_TEST_${Date.now()}`;
    writeFileSync(envFile, `${uniqueKey}=test_value\n`);

    loadEnvFiles([envFile], logger);
    expect(process.env[uniqueKey]).toBeUndefined();
  });
});
