import * as Sentry from '@sentry/node';
import { config } from './config.js';

let initialized = false;

const IGNORED_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
]);

export function initSentry(release?: string): void {
  if (!config.SENTRY_BACKEND_DSN || !config.SENTRY_ENABLED) {
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_BACKEND_DSN,
    environment: config.SENTRY_ENVIRONMENT || config.NODE_ENV,
    release,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    beforeSend(event) {
      // Filter out expected operational errors (SSH/network to unreachable servers)
      const code = (event.exception?.values?.[0]?.value ?? '').match(/code[:\s]+['"]?(\w+)/i)?.[1];
      if (code && IGNORED_ERROR_CODES.has(code)) {
        return null;
      }
      return event;
    },
  });

  initialized = true;
  console.log('[Sentry] Initialized backend error monitoring');
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;

  Sentry.captureException(error, context ? { extra: context } : undefined);
}

export function getSentryConfig(appVersion: string): {
  frontendDsn: string | undefined;
  environment: string;
  release: string;
} {
  return {
    frontendDsn: config.SENTRY_ENABLED ? config.SENTRY_FRONTEND_DSN : undefined,
    environment: config.SENTRY_ENVIRONMENT || config.NODE_ENV,
    release: appVersion,
  };
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;

  await Sentry.flush(timeoutMs);
}
