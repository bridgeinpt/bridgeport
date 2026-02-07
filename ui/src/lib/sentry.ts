import * as Sentry from '@sentry/react';

let initialized = false;

export function initSentry(): void {
  fetch('/api/client-config')
    .then((res) => res.json())
    .then(
      (config: {
        sentryDsn: string | null;
        sentryEnvironment: string;
        sentryRelease: string;
      }) => {
        if (!config.sentryDsn) return;

        Sentry.init({
          dsn: config.sentryDsn,
          environment: config.sentryEnvironment,
          release: config.sentryRelease,
          beforeSend(event) {
            // Filter out 401 Unauthorized errors (expected during auth flow)
            if (event.exception?.values?.some((v) => v.value === 'Unauthorized')) {
              return null;
            }
            return event;
          },
        });

        initialized = true;
      },
    )
    .catch(() => {
      // Silently fail — Sentry is non-critical
    });
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;

  Sentry.captureException(error, context ? { extra: context } : undefined);
}

export function setSentryUser(user: { id: string } | null): void {
  if (!initialized) return;

  Sentry.setUser(user);
}

export function setSentryEnvironment(env: { id: string; name: string } | null): void {
  if (!initialized) return;

  if (env) {
    Sentry.setTag('bridgeport.environment', env.name);
    Sentry.setTag('bridgeport.environment_id', env.id);
  } else {
    Sentry.setTag('bridgeport.environment', undefined);
    Sentry.setTag('bridgeport.environment_id', undefined);
  }
}
