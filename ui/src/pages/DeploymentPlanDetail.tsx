import { useEffect, useState, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useToast } from '../components/Toast';
import {
  getDeploymentPlan,
  executeDeploymentPlan,
  cancelDeploymentPlan,
  rollbackDeploymentPlan,
  type DeploymentPlan,
  type DeploymentPlanStep,
  type DeploymentPlanStatus,
  type DeploymentStepStatus,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';

const STATUS_COLORS: Record<DeploymentPlanStatus, { bg: string; text: string; border: string }> = {
  pending: { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500' },
  completed: { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500' },
  cancelled: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500' },
  rolled_back: { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500' },
};

const STEP_STATUS_COLORS: Record<DeploymentStepStatus, { bg: string; text: string }> = {
  pending: { bg: 'bg-slate-700', text: 'text-slate-400' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
  success: { bg: 'bg-green-500/20', text: 'text-green-400' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400' },
  skipped: { bg: 'bg-slate-700', text: 'text-slate-500' },
  rolled_back: { bg: 'bg-orange-500/20', text: 'text-orange-400' },
};

export default function DeploymentPlanDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!id) return;

    setLoading(true);
    getDeploymentPlan(id)
      .then(({ plan }) => {
        setPlan(plan);
        // Start SSE if plan is running
        if (plan.status === 'running') {
          startEventStream(id);
        }
      })
      .catch((err) => {
        toast.error(err.message);
        navigate('/deployment-plans');
      })
      .finally(() => setLoading(false));

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [id, navigate, toast]);

  const startEventStream = (planId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // SSE doesn't support custom headers, so we use polling instead
    const pollInterval = setInterval(async () => {
      try {
        const { plan: updated } = await getDeploymentPlan(planId);
        setPlan(updated);

        if (!['pending', 'running'].includes(updated.status)) {
          clearInterval(pollInterval);
        }
      } catch {
        // Ignore errors
      }
    }, 2000);

    // Store interval ID for cleanup
    eventSourceRef.current = { close: () => clearInterval(pollInterval) } as EventSource;
  };

  const handleExecute = async () => {
    if (!plan) return;
    setExecuting(true);
    try {
      await executeDeploymentPlan(plan.id);
      toast.success('Deployment started');
      // Start polling
      startEventStream(plan.id);
      // Refresh
      const { plan: updated } = await getDeploymentPlan(plan.id);
      setPlan(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to execute');
    } finally {
      setExecuting(false);
    }
  };

  const handleCancel = async () => {
    if (!plan || !confirm('Cancel this deployment plan?')) return;
    setCancelling(true);
    try {
      await cancelDeploymentPlan(plan.id);
      toast.success('Deployment cancelled');
      const { plan: updated } = await getDeploymentPlan(plan.id);
      setPlan(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  };

  const handleRollback = async () => {
    if (!plan || !confirm('Rollback all deployed services to their previous versions?')) return;
    setRollingBack(true);
    try {
      await rollbackDeploymentPlan(plan.id);
      toast.success('Rollback started');
      startEventStream(plan.id);
      const { plan: updated } = await getDeploymentPlan(plan.id);
      setPlan(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to rollback');
    } finally {
      setRollingBack(false);
    }
  };

  if (loading || !plan) {
    return (
      <div className="p-8">
        <div className="card">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-slate-700 rounded w-1/3"></div>
            <div className="h-4 bg-slate-700 rounded w-1/2"></div>
            <div className="h-32 bg-slate-700 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  const statusColor = STATUS_COLORS[plan.status] || STATUS_COLORS.pending;
  const canExecute = plan.status === 'pending';
  const canCancel = plan.status === 'pending' || plan.status === 'running';
  const canRollback = plan.status === 'completed' || plan.status === 'failed';

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-4 mb-2">
            <Link
              to="/deployment-plans"
              className="text-slate-400 hover:text-white transition-colors"
            >
              &larr; Deployment Plans
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-bold text-white">{plan.name}</span>
            <span className={`badge ${statusColor.bg} ${statusColor.text}`}>
              {plan.status.replace('_', ' ')}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-slate-400">
            {plan.imageTag && <span className="font-mono">Tag: {plan.imageTag}</span>}
            <span>
              {plan.triggerType} by {plan.triggeredBy || plan.user?.email}
            </span>
            <span>
              Created {formatDistanceToNow(new Date(plan.createdAt), { addSuffix: true })}
            </span>
          </div>
          {plan.containerImage && (
            <Link
              to="/container-images"
              className="text-primary-400 text-sm mt-1 inline-block hover:underline"
            >
              Image: {plan.containerImage.name}
            </Link>
          )}
        </div>

        <div className="flex gap-2">
          {canExecute && (
            <button
              onClick={handleExecute}
              disabled={executing}
              className="btn btn-primary"
            >
              {executing ? 'Starting...' : 'Execute'}
            </button>
          )}
          {canCancel && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="btn btn-ghost text-yellow-400 hover:text-yellow-300"
            >
              {cancelling ? 'Cancelling...' : 'Cancel'}
            </button>
          )}
          {canRollback && (
            <button
              onClick={handleRollback}
              disabled={rollingBack}
              className="btn btn-ghost text-orange-400 hover:text-orange-300"
            >
              {rollingBack ? 'Rolling back...' : 'Rollback'}
            </button>
          )}
        </div>
      </div>

      {/* Error message */}
      {plan.error && (
        <div className="card bg-red-500/10 border-red-500/30 mb-6">
          <h3 className="text-red-400 font-medium mb-2">Error</h3>
          <p className="text-red-300 text-sm">{plan.error}</p>
        </div>
      )}

      {/* Progress bar */}
      {plan.status === 'running' && (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-400">Progress</span>
            <span className="text-sm text-slate-400">
              {plan.steps.filter((s) => s.status === 'success').length} / {plan.steps.length} steps
            </span>
          </div>
          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-500 transition-all duration-500"
              style={{
                width: `${(plan.steps.filter((s) => s.status === 'success').length / plan.steps.length) * 100}%`,
              }}
            ></div>
          </div>
        </div>
      )}

      {/* Steps */}
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4">Deployment Steps</h2>
        <div className="space-y-3">
          {plan.steps.map((step, index) => (
            <StepCard
              key={step.id}
              step={step}
              index={index}
              expanded={expandedStep === step.id}
              onToggle={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
            />
          ))}
        </div>
      </div>

      {/* Logs */}
      {plan.logs && (
        <div className="card mt-6">
          <h2 className="text-lg font-semibold text-white mb-4">Plan Logs</h2>
          <pre className="bg-slate-950 rounded p-4 text-sm text-slate-300 overflow-x-auto max-h-96 overflow-y-auto font-mono">
            {plan.logs}
          </pre>
        </div>
      )}
    </div>
  );
}

function StepCard({
  step,
  index,
  expanded,
  onToggle,
}: {
  step: DeploymentPlanStep;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const statusColor = STEP_STATUS_COLORS[step.status] || STEP_STATUS_COLORS.pending;
  const isRunning = step.status === 'running';

  return (
    <div className={`border rounded-lg ${statusColor.bg} border-slate-700 overflow-hidden`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-800 text-slate-400 text-sm font-medium">
            {index + 1}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className={`font-medium ${statusColor.text}`}>
                {step.action === 'deploy' ? 'Deploy' : step.action === 'health_check' ? 'Health Check' : 'Rollback'}
              </span>
              {step.service && (
                <Link
                  to={`/services/${step.service.id}`}
                  className="text-white hover:text-primary-400"
                  onClick={(e) => e.stopPropagation()}
                >
                  {step.service.name}
                </Link>
              )}
              {step.service?.server?.name && (
                <span className="text-slate-500 text-sm">
                  on {step.service.server.name}
                </span>
              )}
            </div>
            {step.targetTag && (
              <span className="text-slate-400 text-sm font-mono">
                {step.previousTag && `${step.previousTag} → `}{step.targetTag}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {isRunning && (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-400"></div>
          )}
          <span className={`badge ${statusColor.bg} ${statusColor.text} text-xs`}>
            {step.status.replace('_', ' ')}
          </span>
          {step.completedAt && (
            <span className="text-slate-500 text-xs">
              {format(new Date(step.completedAt), 'HH:mm:ss')}
            </span>
          )}
          <ChevronIcon
            className={`w-5 h-5 text-slate-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-700/50 pt-4">
          {step.error && (
            <div className="mb-4 p-3 bg-red-500/10 rounded">
              <p className="text-red-400 text-sm">{step.error}</p>
            </div>
          )}

          {step.action === 'health_check' && step.healthDetails && (
            <div className="mb-4">
              <h4 className="text-sm font-medium text-slate-400 mb-2">Health Check Details</h4>
              <pre className="bg-slate-950 rounded p-3 text-xs text-slate-300 overflow-x-auto">
                {JSON.stringify(JSON.parse(step.healthDetails), null, 2)}
              </pre>
            </div>
          )}

          {step.logs && (
            <div>
              <h4 className="text-sm font-medium text-slate-400 mb-2">Logs</h4>
              <pre className="bg-slate-950 rounded p-3 text-xs text-slate-300 overflow-x-auto max-h-48 overflow-y-auto font-mono">
                {step.logs}
              </pre>
            </div>
          )}

          {!step.error && !step.logs && !step.healthDetails && (
            <p className="text-slate-500 text-sm">No additional details available</p>
          )}

          <div className="mt-4 flex gap-4 text-xs text-slate-500">
            {step.startedAt && (
              <span>Started: {format(new Date(step.startedAt), 'HH:mm:ss')}</span>
            )}
            {step.completedAt && (
              <span>Completed: {format(new Date(step.completedAt), 'HH:mm:ss')}</span>
            )}
            {step.startedAt && step.completedAt && (
              <span>
                Duration: {Math.round((new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000)}s
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
