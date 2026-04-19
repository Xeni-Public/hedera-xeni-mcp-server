// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Minimal stderr logger.
 *
 * Why stderr: stdout is reserved for MCP JSON-RPC traffic when running
 * stdio transport. Anything printed to stdout corrupts the protocol.
 *
 * Format: `[<UTC ISO 8601>] [LEVEL] <message>` — per team convention in
 * `feedback_no_emoji_logs.md`. No emojis.
 *
 * Correlation IDs: threaded through via the optional `correlationId` field
 * in the structured log call. AgentService passes it via MCP request metadata;
 * hooks / policies accept it as part of their context.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()];
}

export interface LogContext {
  // `| undefined` on optional fields is explicit per tsconfig's
  // `exactOptionalPropertyTypes: true`. Callers often thread an
  // optional `correlationId` from a wider context; allowing the
  // property to hold `undefined` saves them a conditional spread.
  correlationId?: string | undefined;
  tool?: string | undefined;
  intent_id?: string | undefined;
  [key: string]: unknown;
}

function format(level: LogLevel, message: string, context?: LogContext): string {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (!context) return `${prefix} ${message}`;
  const keys = Object.keys(context);
  if (keys.length === 0) return `${prefix} ${message}`;
  const parts = keys.map((k) => `${k}=${JSON.stringify(context[k])}`).join(' ');
  return `${prefix} ${message} ${parts}`;
}

export const log = {
  debug(message: string, context?: LogContext): void {
    if (shouldLog('debug')) process.stderr.write(format('debug', message, context) + '\n');
  },
  info(message: string, context?: LogContext): void {
    if (shouldLog('info')) process.stderr.write(format('info', message, context) + '\n');
  },
  warn(message: string, context?: LogContext): void {
    if (shouldLog('warn')) process.stderr.write(format('warn', message, context) + '\n');
  },
  error(message: string, context?: LogContext): void {
    if (shouldLog('error')) process.stderr.write(format('error', message, context) + '\n');
  },
};
