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

// Explicit secret-scrub safety net. Sentry is already conservative here
// (sendDefaultPii:false, and the error handler attaches only a curated
// {method,url,statusCode,requestId}), but this guarantees that any object
// passed as `extra` — now or in future call sites — has secret-bearing keys
// redacted before it leaves the process.
const SECRET_KEY_RE =
  /(secret|password|passwd|token|api[-_]?key|authorization|cookie|private[-_]?key|master[-_]?key|encrypted|nonce)/i;

function scrubSecrets(value: unknown, depth = 0): unknown {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : scrubSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

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
      // Redact secret-bearing keys from any attached extra/contexts data.
      if (event.extra) event.extra = scrubSecrets(event.extra) as typeof event.extra;
      if (event.contexts) event.contexts = scrubSecrets(event.contexts) as typeof event.contexts;
      return event;
    },
  });

  initialized = true;
  console.log('[Sentry] Initialized backend error monitoring');
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;

  const extra = context ? (scrubSecrets(context) as Record<string, unknown>) : undefined;
  Sentry.captureException(error, extra ? { extra } : undefined);
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

export function isBackendSentryConfigured(): boolean {
  return config.SENTRY_ENABLED && !!config.SENTRY_BACKEND_DSN;
}

export function isFrontendSentryConfigured(): boolean {
  return config.SENTRY_ENABLED && !!config.SENTRY_FRONTEND_DSN;
}

export function getSentryStatus(): {
  backendConfigured: boolean;
  frontendConfigured: boolean;
  environment: string;
} {
  return {
    backendConfigured: isBackendSentryConfigured(),
    frontendConfigured: isFrontendSentryConfigured(),
    environment: config.SENTRY_ENVIRONMENT || config.NODE_ENV,
  };
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;

  await Sentry.flush(timeoutMs);
}
