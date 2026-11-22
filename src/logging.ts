/**
 * @module src/logging
 *
 * Server log through LogTape: categories ["doorking", <area>] (session, gate, gates, camera, schedule, email, api,
 * request, change, dks, server), each entry printed to the console (journalctl) as text from info up, and written to
 * logs/server.jsonl as JSON Lines (one JSON object per line) from debug up, with the request or gate-connection
 * context (requestId, user, gate, job) of web/requests.ts and web/jobs.ts. The file is rotated at maxBytes, keeping
 * maxFiles old ones. Secret fields (passwords, master codes, tokens, keys) and secret-looking text (API keys,
 * user:password@ in URLs, email addresses) are replaced before anything is written.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { configure, getConsoleSink, reset, getLogger, getTextFormatter, withFilter, type LogLevel, type LogRecord, type Logger, type Sink } from '@logtape/logtape';
import { getRotatingFileSink } from '@logtape/file';
import { DEFAULT_REDACT_FIELDS, EMAIL_ADDRESS_PATTERN, redactByField, redactByPattern, type RedactionPatterns } from '@logtape/redaction';

export const LOG_CATEGORY = 'doorking';
export const LOG_FILE = 'server.jsonl';

/**
 * Logger.
 *
 * @param area - `string` value.
 * @returns `Logger` result.
 */
export const logger = (area: string): Logger => getLogger([LOG_CATEGORY, area]);

/**
 * For the log(message) callbacks of src/ (camera runner, DKS Cloud client, email outbox): each message at level, or at
 * warning when it reports a problem.
 */
const PROBLEM = /fail|error|did not|not sent|refused|timed out|could not/i;
/**
 * Log messages.
 *
 * @param area - `string` value.
 * @param [level] - `'debug' | 'info'` value.
 * @returns Computed result.
 */
export const logMessages = (area: string, level: 'debug' | 'info' = 'info') => (message: string): void => {
  logger(area)[PROBLEM.test(message) ? 'warn' : level]`${message}`;
};

const SECRET_FIELDS = [...DEFAULT_REDACT_FIELDS, /master.?code/i, /dks.?password/i];
const SECRET_TEXT: RedactionPatterns = [
  { pattern: /dkg_[0-9a-f]{12}_[\w-]+/g, replacement: 'dkg_[API key]' },
  { pattern: /(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, replacement: '$1[login]@' },
  EMAIL_ADDRESS_PATTERN,
];

/**
 * One JSON object per line: { time, level, category, message, ...context and properties }. Text values in the message
 * appear as they are (LogTape's JSON Lines formatter would quote them).
 *
 * @param record - LogTape log record to serialize as JSON.
 * @returns `string` result.
 */
function jsonLine(record: LogRecord): string {
  const message = record.message.map((part, i) => (i % 2 && typeof part !== 'string' ? inspect(part) : String(part))).join('');
  return `${JSON.stringify({ time: new Date(record.timestamp).toISOString(), level: record.level, category: record.category.join('.'),
    message, ...record.properties })}\n`;
}

/**
 * A sink that reports its own failures (disk full, folder removed) on stderr instead of throwing into the code that
 * logged; keeps the sink's dispose so reset() still flushes it.
 *
 * @param sink - `T` value.
 * @returns `T` result.
 */
function neverThrows<T extends Sink>(sink: T): T {
  const safe = ((record: LogRecord) => {
    try { sink(record); } catch (err) { console.error(`Log not written: ${(err as Error).message}`); }
  }) as T;
  const { [Symbol.dispose]: syncDispose } = sink as Partial<Disposable>;
  const { [Symbol.asyncDispose]: asyncDispose } = sink as Partial<AsyncDisposable>;
  return Object.assign(safe, syncDispose && { [Symbol.dispose]: syncDispose.bind(sink) }, asyncDispose && { [Symbol.asyncDispose]: asyncDispose.bind(sink) });
}

export interface LoggingOptions {
  logsDir: string;
  toConsole?: boolean; // false: the file only (tests)
  consoleLevel?: LogLevel;
  fileLevel?: LogLevel;
  maxBytes?: number;
  maxFiles?: number;
}

/**
 * Sets up the sinks; call once before anything logs (again with other options replaces the setup).
 *
 * @param options - Options object.
 * @param options.logsDir - Logs dir.
 * @param [options.toConsole] - To console.
 * @param [options.consoleLevel] - Console level.
 * @param [options.fileLevel] - File level.
 * @param [options.maxBytes] - Max bytes.
 * @param [options.maxFiles] - Max files.
 */
export async function configureLogging({ logsDir, toConsole = true, consoleLevel = 'info', fileLevel = 'debug',
  maxBytes = 5 * 1024 * 1024, maxFiles = 5 }: LoggingOptions): Promise<void> {
  fs.mkdirSync(logsDir, { recursive: true });
  const text = redactByPattern(getTextFormatter({ timestamp: 'none', category: '.', value: 'bare' }), SECRET_TEXT);
  const json = redactByPattern(jsonLine, SECRET_TEXT);
  await configure({
    reset: true,
    contextLocalStorage: new AsyncLocalStorage(),
    sinks: {
      console: withFilter(redactByField(getConsoleSink({ formatter: text }), SECRET_FIELDS), consoleLevel),
      file: neverThrows(redactByField(getRotatingFileSink(path.join(logsDir, LOG_FILE), { formatter: json, maxSize: maxBytes, maxFiles }), SECRET_FIELDS)),
    },
    loggers: [
      { category: [LOG_CATEGORY], sinks: toConsole ? ['file', 'console'] : ['file'], lowestLevel: fileLevel },
      { category: ['logtape', 'meta'], sinks: toConsole ? ['console'] : ['file'], lowestLevel: 'warning' },
    ],
  });
}

/** Writes out what is buffered, closes the file and removes the setup (server shutdown; tests). */
export const closeLogging = (): Promise<void> => reset();
