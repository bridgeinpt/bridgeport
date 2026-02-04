import type { PlanPreview, PreviewLevel, PreviewStep } from '../lib/api';

interface DeploymentPreviewProps {
  preview: PlanPreview;
  templateName: string;
  onClose: () => void;
  onExecute?: () => void;
  executing?: boolean;
}

export default function DeploymentPreview({
  preview,
  templateName,
  onClose,
  onExecute,
  executing = false,
}: DeploymentPreviewProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <div>
            <h3 className="text-lg font-semibold text-white">
              Deployment Preview: "{templateName}"
            </h3>
            <p className="text-sm text-slate-400">
              {preview.servicesCount} service{preview.servicesCount !== 1 ? 's' : ''} will be deployed
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Preview Content */}
        <div className="p-6 space-y-4">
          {preview.levels.map((level, levelIndex) => (
            <div key={level.order}>
              {/* Level connector */}
              {levelIndex > 0 && (
                <div className="flex justify-center py-2">
                  <div className="w-0.5 h-6 bg-slate-600" />
                </div>
              )}

              <PreviewLevelCard level={level} />
            </div>
          ))}
        </div>

        {/* Warnings */}
        {preview.warnings.length > 0 && (
          <div className="mx-6 mb-4 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 text-yellow-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <p className="text-yellow-400 font-medium">Warnings</p>
                <ul className="text-sm text-yellow-300/80 mt-1 space-y-1">
                  {preview.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-slate-700">
          <div className="text-sm text-slate-400">
            Est. Duration: ~{formatDuration(preview.estimatedDurationMs)}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-ghost">
              Cancel
            </button>
            {onExecute && (
              <button
                onClick={onExecute}
                disabled={executing}
                className="btn btn-primary"
              >
                {executing ? 'Starting...' : 'Execute Now'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface PreviewLevelCardProps {
  level: PreviewLevel;
}

function PreviewLevelCard({ level }: PreviewLevelCardProps) {
  const hasMultipleSteps = level.steps.length > 1;

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
      {/* Level header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-mono text-slate-500">Level {level.order + 1}</span>
        {level.parallel && hasMultipleSteps ? (
          <span className="badge bg-blue-500/20 text-blue-400 text-xs">Parallel</span>
        ) : (
          <span className="badge bg-slate-700 text-slate-400 text-xs">Sequential</span>
        )}
      </div>

      {/* Steps */}
      <div className={`grid gap-3 ${level.parallel && hasMultipleSteps ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-1'}`}>
        {level.steps.map((step, stepIndex) => (
          <PreviewStepCard key={stepIndex} step={step} />
        ))}
      </div>
    </div>
  );
}

interface PreviewStepCardProps {
  step: PreviewStep;
}

function PreviewStepCard({ step }: PreviewStepCardProps) {
  const typeConfig = {
    deploy: {
      bg: 'bg-blue-500/10 border-blue-500/30',
      icon: DeployIcon,
      iconColor: 'text-blue-400',
    },
    health_check: {
      bg: 'bg-green-500/10 border-green-500/30',
      icon: HealthIcon,
      iconColor: 'text-green-400',
    },
    wait: {
      bg: 'bg-yellow-500/10 border-yellow-500/30',
      icon: WaitIcon,
      iconColor: 'text-yellow-400',
    },
  };

  const config = typeConfig[step.type];
  const Icon = config.icon;

  return (
    <div className={`border rounded-lg p-3 ${config.bg}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${config.iconColor}`} />
        <span className="text-sm font-medium text-white capitalize">
          {step.type.replace('_', ' ')}
        </span>
      </div>

      {step.type === 'deploy' && step.serviceName && (
        <div className="space-y-1">
          <p className="text-white font-medium">{step.serviceName}</p>
          {step.serverName && (
            <p className="text-xs text-slate-400">on {step.serverName}</p>
          )}
          {step.currentTag && step.targetTag && (
            <div className="flex items-center gap-2 text-xs mt-2">
              <code className="px-1.5 py-0.5 bg-slate-700 rounded text-slate-300">
                {step.currentTag}
              </code>
              <span className="text-slate-500">&rarr;</span>
              <code className="px-1.5 py-0.5 bg-primary-500/20 rounded text-primary-400">
                {step.targetTag}
              </code>
            </div>
          )}
        </div>
      )}

      {step.type === 'health_check' && step.serviceName && (
        <div className="space-y-1">
          <p className="text-white font-medium">{step.serviceName}</p>
          {step.serverName && (
            <p className="text-xs text-slate-400">on {step.serverName}</p>
          )}
          {step.healthCheckUrl ? (
            <p className="text-xs text-green-400 font-mono truncate" title={step.healthCheckUrl}>
              {step.healthCheckUrl}
            </p>
          ) : (
            <p className="text-xs text-yellow-400">No health check URL configured</p>
          )}
        </div>
      )}

      {step.type === 'wait' && (
        <div>
          <p className="text-white">Wait {formatDuration(step.waitMs || 0)}</p>
        </div>
      )}

      {step.estimatedDurationMs && step.estimatedDurationMs > 0 && (
        <p className="text-xs text-slate-500 mt-2">
          ~{formatDuration(step.estimatedDurationMs)}
        </p>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds}s`;
}

function DeployIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
    </svg>
  );
}

function HealthIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function WaitIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
