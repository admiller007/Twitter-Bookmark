import type { DiagnosticEvent } from './types';
import { errorMessage, nowIso } from './util';

type Sink = (event: Omit<DiagnosticEvent, 'id'>) => void;

let sink: Sink | null = null;

/**
 * Diagnostics are intentionally local-only. The background worker installs a
 * sink that persists events to IndexedDB; every other context just logs to the
 * console so nothing is silently swallowed.
 */
export function setDiagnosticSink(next: Sink | null): void {
  sink = next;
}

function emit(
  level: DiagnosticEvent['level'],
  scope: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  const event: Omit<DiagnosticEvent, 'id'> = { ts: nowIso(), level, scope, message };
  if (detail) event.detail = detail;

  const prefix = `[XBV:${scope}]`;
  if (level === 'error') console.error(prefix, message, detail ?? '');
  else if (level === 'warn') console.warn(prefix, message, detail ?? '');
  else console.info(prefix, message, detail ?? '');

  try {
    sink?.(event);
  } catch (error) {
    console.error('[XBV:logger] diagnostic sink failed', errorMessage(error));
  }
}

export const log = {
  info: (scope: string, message: string, detail?: Record<string, unknown>) =>
    emit('info', scope, message, detail),
  warn: (scope: string, message: string, detail?: Record<string, unknown>) =>
    emit('warn', scope, message, detail),
  error: (scope: string, message: string, detail?: Record<string, unknown>) =>
    emit('error', scope, message, detail),
};
