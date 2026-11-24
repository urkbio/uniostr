export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Record<string, unknown>;

const MAX_CONTEXT_LENGTH = 1000;

let currentLevel: LogLevel = 'info';

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function formatContext(context: LogContext): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) {
      continue;
    }
    const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    parts.push(`${key}=${text}`);
  }
  if (parts.length === 0) {
    return '';
  }
  const rendered = parts.join(' ');
  return rendered.length > MAX_CONTEXT_LENGTH ? `${rendered.slice(0, MAX_CONTEXT_LENGTH)}...` : rendered;
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) {
    return;
  }

  const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), message];
  const contextText = context ? formatContext(context) : '';
  if (contextText) {
    line.push(contextText);
  }

  const output = line.join(' ');
  if (level === 'warn' || level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug(message: string, context?: LogContext): void {
    write('debug', message, context);
  },
  info(message: string, context?: LogContext): void {
    write('info', message, context);
  },
  warn(message: string, context?: LogContext): void {
    write('warn', message, context);
  },
  error(message: string, context?: LogContext): void {
    write('error', message, context);
  },
};
