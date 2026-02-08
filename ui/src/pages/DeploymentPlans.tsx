import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  listDeploymentPlans,
  type DeploymentPlan,
  type DeploymentPlanStatus,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';

const STATUS_COLORS: Record<DeploymentPlanStatus, { bg: string; text: string }> = {
  pending: { bg: 'bg-slate-500/20', text: 'text-slate-400' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
  completed: { bg: 'bg-green-500/20', text: 'text-green-400' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400' },
  cancelled: { bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  rolled_back: { bg: 'bg-orange-500/20', text: 'text-orange-400' },
};

export default function DeploymentPlans() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [plans, setPlans] = useState<DeploymentPlan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      listDeploymentPlans(selectedEnvironment.id)
        .then(({ plans }) => setPlans(plans))
        .catch((err) => toast.error(err.message))
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id, toast]);

  // Auto-refresh running plans
  useEffect(() => {
    const hasRunning = plans.some((p) => p.status === 'running' || p.status === 'pending');
    if (!hasRunning || !selectedEnvironment?.id) return;

    const interval = setInterval(async () => {
      try {
        const { plans: updated } = await listDeploymentPlans(selectedEnvironment.id);
        setPlans(updated);
      } catch {
        // Ignore refresh errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [plans, selectedEnvironment?.id]);

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Select an environment to view deployment plans</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <Link to="/container-images" className="btn btn-primary">
          Deploy via Container Images
        </Link>
      </div>

      {loading ? (
        <div className="panel">
          <div className="animate-pulse space-y-4">
            <div className="h-16 bg-slate-700 rounded"></div>
            <div className="h-16 bg-slate-700 rounded"></div>
          </div>
        </div>
      ) : plans.length === 0 ? (
        <div className="panel text-center py-12">
          <PlanIcon className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <p className="text-slate-400 mb-4">No deployment plans yet</p>
          <p className="text-slate-500 text-sm mb-4">
            Deployment plans are created when you deploy managed images or services with dependencies
          </p>
          <Link to="/container-images" className="btn btn-primary">
            Go to Container Images
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {plans.map((plan) => {
            const statusColor = STATUS_COLORS[plan.status] || STATUS_COLORS.pending;
            const deploySteps = plan.steps.filter((s) => s.action === 'deploy');
            const successSteps = plan.steps.filter((s) => s.status === 'success');
            const failedSteps = plan.steps.filter((s) => s.status === 'failed');

            return (
              <Link
                key={plan.id}
                to={`/deployment-plans/${plan.id}`}
                className="panel block hover:border-slate-600 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="p-3 bg-slate-800 rounded-lg">
                      <PlanIcon className="w-6 h-6 text-primary-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-semibold text-white">{plan.name}</h3>
                        <span className={`badge ${statusColor.bg} ${statusColor.text} text-xs`}>
                          {plan.status.replace('_', ' ')}
                        </span>
                        {plan.autoRollback && (
                          <span className="badge bg-slate-700 text-slate-300 text-xs">
                            Auto-rollback
                          </span>
                        )}
                      </div>

                      {plan.imageTag && (
                        <p className="text-slate-400 text-sm mt-1 font-mono">
                          Tag: {plan.imageTag}
                        </p>
                      )}

                      <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                        <span>
                          {deploySteps.length} service{deploySteps.length !== 1 ? 's' : ''}
                        </span>
                        <span>
                          {plan.triggerType} by {plan.triggeredBy || plan.user?.email}
                        </span>
                        <span>
                          Created {formatDistanceToNow(new Date(plan.createdAt), { addSuffix: true })}
                        </span>
                        {plan.completedAt && (
                          <span>
                            Completed {format(new Date(plan.completedAt), 'MMM d HH:mm')}
                          </span>
                        )}
                      </div>

                      {plan.containerImage && (
                        <p className="text-primary-400 text-xs mt-2">
                          Image: {plan.containerImage.name}
                        </p>
                      )}

                      {plan.error && (
                        <p className="text-red-400 text-sm mt-2 truncate max-w-lg">
                          Error: {plan.error}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {/* Progress indicator */}
                    {plan.status === 'running' && (
                      <div className="flex items-center gap-2">
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-400"></div>
                        <span className="text-sm text-slate-400">
                          {successSteps.length}/{plan.steps.length}
                        </span>
                      </div>
                    )}

                    {plan.status === 'completed' && (
                      <div className="flex items-center gap-2 text-green-400">
                        <CheckIcon className="w-5 h-5" />
                        <span className="text-sm">{successSteps.length} steps</span>
                      </div>
                    )}

                    {(plan.status === 'failed' || plan.status === 'rolled_back') && (
                      <div className="flex items-center gap-2 text-red-400">
                        <XIcon className="w-5 h-5" />
                        <span className="text-sm">{failedSteps.length} failed</span>
                      </div>
                    )}

                    <ChevronIcon className="w-5 h-5 text-slate-500" />
                  </div>
                </div>

                {/* Step previews for running plans */}
                {plan.status === 'running' && plan.steps.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-slate-700 flex gap-2">
                    {plan.steps.slice(0, 6).map((step) => (
                      <div
                        key={step.id}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${
                          step.status === 'success'
                            ? 'bg-green-500/20 text-green-400'
                            : step.status === 'running'
                            ? 'bg-blue-500/20 text-blue-400'
                            : step.status === 'failed'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-slate-700 text-slate-400'
                        }`}
                      >
                        {step.status === 'running' && (
                          <div className="animate-spin rounded-full h-2 w-2 border-b border-current"></div>
                        )}
                        {step.action === 'deploy' ? 'Deploy' : 'Health'}{' '}
                        {step.service?.name}
                      </div>
                    ))}
                    {plan.steps.length > 6 && (
                      <span className="text-xs text-slate-500">
                        +{plan.steps.length - 6} more
                      </span>
                    )}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlanIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
      />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
