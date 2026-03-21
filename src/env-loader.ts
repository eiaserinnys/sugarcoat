import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'dotenv';
import type { Logger } from './logger.js';

/**
 * Load environment variables from .env files without polluting process.env.
 * Returns a merged object of all parsed variables.
 */
export function loadEnvFiles(
  filePaths: string[],
  logger: Logger,
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const filePath of filePaths) {
    const resolved = resolve(filePath);
    try {
      const content = readFileSync(resolved, 'utf-8');
      const parsed = parse(content);
      Object.assign(merged, parsed);
      logger.debug(`Loaded env file: ${resolved} (${Object.keys(parsed).length} vars)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load env file ${resolved}: ${message}`);
    }
  }

  return merged;
}
