import type { HealthCheckResultData } from './types';
import { getOverallStatusDotColor, getContainerHealthTextColor } from './utils';

interface HealthCheckResultCardProps {
  healthCheckError: string | null;
  healthCheckResult: HealthCheckResultData | null;
  onDismiss: () => void;
}

export function HealthCheckResultCard({
  healthCheckError,
  healthCheckResult,
  onDismiss,
}: HealthCheckResultCardProps) {
  if (!healthCheckError && !healthCheckResult) {
    return null;
  }

  return (
    <div className="card mb-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Health Check Result</h3>
        <button
          onClick={onDismiss}
          className="text-slate-400 hover:text-white text-sm"
        >
          Dismiss
        </button>
      </div>

      {healthCheckError && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-red-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-red-400 font-medium">Health Check Failed</p>
              <p className="text-red-300/80 text-sm mt-1">{healthCheckError}</p>
            </div>
          </div>
        </div>
      )}

      {healthCheckResult && (
        <div className="space-y-4">
          {/* Overall Status */}
          <div className="flex items-center gap-3">
            <span className={`w-3 h-3 rounded-full ${getOverallStatusDotColor(healthCheckResult.status)}`} />
            <span className="text-white font-medium capitalize">{healthCheckResult.status}</span>
          </div>

          {/* Container Details */}
          <div className="p-3 bg-slate-800 rounded-lg">
            <p className="text-slate-400 text-sm mb-2">Container</p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-slate-500">State</dt>
                <dd className="text-white">{healthCheckResult.container.state}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Status</dt>
                <dd className="text-white">{healthCheckResult.container.status}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Running</dt>
                <dd className={healthCheckResult.container.running ? 'text-green-400' : 'text-red-400'}>
                  {healthCheckResult.container.running ? 'Yes' : 'No'}
                </dd>
              </div>
              {healthCheckResult.container.health && (
                <div>
                  <dt className="text-slate-500">Health</dt>
                  <dd className={getContainerHealthTextColor(healthCheckResult.container.health)}>
                    {healthCheckResult.container.health}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* URL Check Details */}
          {healthCheckResult.url && (
            <div className="p-3 bg-slate-800 rounded-lg">
              <p className="text-slate-400 text-sm mb-2">URL Health Check</p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-slate-500">Status</dt>
                  <dd className={healthCheckResult.url.success ? 'text-green-400' : 'text-red-400'}>
                    {healthCheckResult.url.success ? 'Success' : 'Failed'}
                  </dd>
                </div>
                {healthCheckResult.url.statusCode && (
                  <div>
                    <dt className="text-slate-500">HTTP Code</dt>
                    <dd className="text-white">{healthCheckResult.url.statusCode}</dd>
                  </div>
                )}
                {healthCheckResult.url.error && (
                  <div className="col-span-2">
                    <dt className="text-slate-500">Error</dt>
                    <dd className="text-red-400 text-xs">{healthCheckResult.url.error}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
