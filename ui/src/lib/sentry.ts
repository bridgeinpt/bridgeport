import * as Sentry from '@sentry/react';

let initialized = false;

export function initSentry(): void {
  fetch('/api/client-config')
    .then((res) => res.json())
    .then((config: { sentryDsn: string | null; sentryEnvironment: string }) => {
      if (!config.sentryDsn) return;

      Sentry.init({
        dsn: config.sentryDsn,
        environment: config.sentryEnvironment,
        beforeSend(event) {
          // Filter out 401 Unauthorized errors (expected during auth flow)
          if (event.exception?.values?.some((v) => v.value === 'Unauthorized')) {
            return null;
          }
          return event;
        },
      });

      initialized = true;
    })
    .catch(() => {
      // Silently fail — Sentry is non-critical
    });
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;

  Sentry.captureException(error, context ? { extra: context } : undefined);
}

export function setSentryUser(user: { id: string; email: string } | null): void {
  if (!initialized) return;

  Sentry.setUser(user);
}
