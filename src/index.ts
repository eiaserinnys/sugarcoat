#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createLogger, type LogLevel } from './logger.js';
import { startBridge } from './bridge.js';

const argv = await yargs(hideBin(process.argv))
  .scriptName('sugarcoat')
  .usage('$0 --stdio <command> [options]')
  .option('stdio', {
    type: 'string',
    demandOption: true,
    describe: 'The stdio MCP server command to wrap',
  })
  .option('port', {
    type: 'number',
    default: 8000,
    describe: 'HTTP server port',
  })
  .option('path', {
    type: 'string',
    default: '/mcp',
    describe: 'Streamable HTTP endpoint path',
  })
  .option('env-file', {
    type: 'string',
    array: true,
    default: [] as string[],
    describe: 'Path to .env file(s) for child process environment',
  })
  .option('health', {
    type: 'string',
    default: '/health',
    describe: 'Health check endpoint path',
  })
  .option('cors', {
    type: 'boolean',
    default: false,
    describe: 'Enable CORS',
  })
  .option('log-level', {
    type: 'string',
    choices: ['debug', 'info', 'none'] as const,
    default: 'info' as const,
    describe: 'Log level',
  })
  .example(
    '$0 --stdio "npx -y @delorenj/mcp-server-trello" --port 3102 --env-file .env',
    'Bridge a Trello MCP server to HTTP on port 3102',
  )
  .help()
  .parseAsync();

const logger = createLogger(argv.logLevel as LogLevel);

logger.info('sugarcoat starting...');
logger.info(`Command: ${argv.stdio}`);
logger.info(`Port: ${argv.port}`);
logger.info(`Path: ${argv.path}`);

await startBridge({
  command: argv.stdio,
  port: argv.port,
  path: argv.path,
  envFiles: argv.envFile,
  healthEndpoint: argv.health,
  corsEnabled: argv.cors,
  logger,
});
