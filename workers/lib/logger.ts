/**
 * Minimal structured logger for the worker process. Keeps output greppable
 * without pulling in a logging dependency.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) || 'info';

function emit(level: Level, scope: string, message: string, meta?: object) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta } : {}),
  };
  const serialized = JSON.stringify(line, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: object) => emit('debug', scope, message, meta),
    info: (message: string, meta?: object) => emit('info', scope, message, meta),
    warn: (message: string, meta?: object) => emit('warn', scope, message, meta),
    error: (message: string, meta?: object) => emit('error', scope, message, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
