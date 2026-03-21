export type LogLevel = 'debug' | 'info' | 'none';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

export function createLogger(level: LogLevel): Logger {
  const timestamp = () => new Date().toISOString();
  const shouldLog = (msgLevel: 'debug' | 'info' | 'error'): boolean => {
    if (level === 'none') return msgLevel === 'error';
    if (level === 'info') return msgLevel !== 'debug';
    return true; // debug level logs everything
  };

  return {
    debug(message: string) {
      if (shouldLog('debug')) {
        process.stderr.write(`[sugarcoat] ${timestamp()} DEBUG ${message}\n`);
      }
    },
    info(message: string) {
      if (shouldLog('info')) {
        process.stderr.write(`[sugarcoat] ${timestamp()} INFO  ${message}\n`);
      }
    },
    error(message: string) {
      if (shouldLog('error')) {
        process.stderr.write(`[sugarcoat] ${timestamp()} ERROR ${message}\n`);
      }
    },
  };
}
