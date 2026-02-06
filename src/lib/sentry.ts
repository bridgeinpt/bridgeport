import * as Sentry from '@sentry/node';
import { config } from './config.js';

let initialized = false;

export function initSentry(release?: string): void {
  if (!config.SENTRY_DSN || !config.SENTRY_ENABLED) {
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT || config.NODE_ENV,
    release,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
  });

  initialized = true;
  console.log('[Sentry] Initialized error monitoring');
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;

  Sentry.captureException(error, context ? { extra: context } : undefined);
}

export function getSentryConfig(): { dsn: string | undefined; environment: string } {
  return {
    dsn: config.SENTRY_ENABLED ? config.SENTRY_DSN : undefined,
    environment: config.SENTRY_ENVIRONMENT || config.NODE_ENV,
  };
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;

  await Sentry.flush(timeoutMs);
}
