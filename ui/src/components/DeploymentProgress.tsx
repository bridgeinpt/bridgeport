import { Link } from 'react-router-dom';
import type {
  DeploymentPlan,
  DeploymentPlanStep,
  DeploymentPlanStatus,
  DeploymentStepStatus,
} from '../lib/api';

const STATUS_COLORS: Record<DeploymentPlanStatus, { bg: string; text: string }> = {
  pending: { bg: 'bg-slate-500/20', text: 'text-slate-400' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
  completed: { bg: 'bg-green-500/20', text: 'text-green-400' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400' },
  cancelled: { bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  rolled_back: { bg: 'bg-orange-500/20', text: 'text-orange-400' },
};

const STEP_STATUS_COLORS: Record<DeploymentStepStatus, { bg: string; text: string }> = {
  pending: { bg: 'bg-slate-700', text: 'text-slate-400' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
  success: { bg: 'bg-green-500/20', text: 'text-green-400' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400' },
  skipped: { bg: 'bg-slate-700', text: 'text-slate-500' },
  rolled_back: { bg: 'bg-orange-500/20', text: 'text-orange-400' },
};

interface DeploymentProgressProps {
  plan: DeploymentPlan;
  compact?: boolean;
}

export function DeploymentProgress({ plan, compact = false }: DeploymentProgressProps) {
  const statusColor = STATUS_COLORS[plan.status] || STATUS_COLORS.pending;
  const completedSteps = plan.steps.filter((s) => s.status === 'success').length;
  const progress = plan.steps.length > 0 ? (completedSteps / plan.steps.length) * 100 : 0;

  if (compact) {
    return (
      <Link
        to={`/deployment-plans/${plan.id}`}
        className="flex items-center gap-3 p-2 bg-slate-800/50 rounded hover:bg-slate-800 transition-colors"
      >
        {plan.status === 'running' && (
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-400"></div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white truncate">{plan.name}</p>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className={statusColor.text}>{plan.status}</span>
            <span>{completedSteps}/{plan.steps.length}</span>
          </div>
        </div>
        {plan.status === 'running' && (
          <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-500 transition-all"
              style={{ width: `${progress}%` }}
            ></div>
          </div>
        )}
      </Link>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {plan.status === 'running' && (
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-400"></div>
          )}
          <div>
            <h3 className="text-white font-medium">{plan.name}</h3>
            <span className={`text-xs ${statusColor.text}`}>{plan.status.replace('_', ' ')}</span>
          </div>
        </div>
        <Link
          to={`/deployment-plans/${plan.id}`}
          className="text-sm text-primary-400 hover:text-primary-300"
        >
          View Details →
        </Link>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs text-slate-500 mb-1">
          <span>Progress</span>
          <span>{completedSteps} / {plan.steps.length} steps</span>
        </div>
        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all ${
              plan.status === 'failed'
                ? 'bg-red-500'
                : plan.status === 'completed'
                ? 'bg-green-500'
                : 'bg-primary-500'
            }`}
            style={{ width: `${progress}%` }}
          ></div>
        </div>
      </div>

      {/* Steps */}
      <div className="flex flex-wrap gap-2">
        {plan.steps.slice(0, 8).map((step) => (
          <StepBadge key={step.id} step={step} />
        ))}
        {plan.steps.length > 8 && (
          <span className="text-xs text-slate-500">
            +{plan.steps.length - 8} more
          </span>
        )}
      </div>

      {/* Error */}
      {plan.error && (
        <p className="text-sm text-red-400 truncate">{plan.error}</p>
      )}
    </div>
  );
}

function StepBadge({ step }: { step: DeploymentPlanStep }) {
  const statusColor = STEP_STATUS_COLORS[step.status] || STEP_STATUS_COLORS.pending;
  const isRunning = step.status === 'running';

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${statusColor.bg} ${statusColor.text}`}
    >
      {isRunning && (
        <div className="animate-spin rounded-full h-2 w-2 border-b border-current"></div>
      )}
      <span>
        {step.action === 'deploy' ? '↑' : step.action === 'health_check' ? '♥' : '↩'}
      </span>
      <span>{step.service?.name || 'Unknown'}</span>
    </div>
  );
}

interface ActiveDeploymentsProps {
  plans: DeploymentPlan[];
}

export function ActiveDeployments({ plans }: ActiveDeploymentsProps) {
  const activePlans = plans.filter((p) => p.status === 'running' || p.status === 'pending');

  if (activePlans.length === 0) {
    return null;
  }

  return (
    <div className="card">
      <h3 className="text-white font-medium mb-4">Active Deployments</h3>
      <div className="space-y-3">
        {activePlans.map((plan) => (
          <DeploymentProgress key={plan.id} plan={plan} />
        ))}
      </div>
    </div>
  );
}
