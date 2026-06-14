import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Check, X, ChevronRight, Loader2 } from 'lucide-react';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  listDeploymentPlans,
  type DeploymentPlan,
  type DeploymentPlanStatus,
  type DeploymentStepStatus,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { type StatusVariant } from '@/lib/status';

/**
 * Plan/step status → Badge variant. `statusVariant('deployment', …)` only
 * covers success/failed/deploying, so the remaining plan & step states map
 * explicitly here to preserve their original colors (orange has no semantic
 * token, so rolled_back falls back to warning).
 */
function planStatusVariant(status: DeploymentPlanStatus): StatusVariant {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'running':
      return 'info';
    case 'cancelled':
    case 'rolled_back':
      return 'warning';
    case 'pending':
    default:
      return 'neutral';
  }
}

function stepStatusVariant(status: DeploymentStepStatus): StatusVariant {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'running':
      return 'info';
    case 'rolled_back':
      return 'warning';
    case 'pending':
    case 'skipped':
    default:
      return 'neutral';
  }
}

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
        <EmptyState message="Select an environment to view deployment plans" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {loading ? (
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : plans.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          message="No deployment plans yet"
          description="Deployment plans are created when you deploy managed images or services with dependencies"
        >
          <Link to="/container-images" className="mt-4 inline-block">
            <Badge variant="default" className="cursor-pointer px-3 py-1.5 text-sm">
              Go to Container Images
            </Badge>
          </Link>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {plans.map((plan) => {
            const deploySteps = plan.steps.filter((s) => s.action === 'deploy');
            const successSteps = plan.steps.filter((s) => s.status === 'success');
            const failedSteps = plan.steps.filter((s) => s.status === 'failed');

            return (
              <Link
                key={plan.id}
                to={`/deployment-plans/${plan.id}`}
                className="block rounded-lg border bg-card p-4 transition-colors hover:border-ring"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="rounded-lg bg-muted p-3">
                      <ClipboardList className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
                        <StatusBadge
                          kind="deployment"
                          value={plan.status}
                          variant={planStatusVariant(plan.status)}
                          label={plan.status.replace('_', ' ')}
                        />
                        {plan.autoRollback && (
                          <Badge variant="neutral">Auto-rollback</Badge>
                        )}
                      </div>

                      {plan.imageTag && (
                        <p className="mt-1 font-mono text-sm text-muted-foreground">
                          Tag: {plan.imageTag}
                        </p>
                      )}

                      <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
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
                        <p className="mt-2 text-xs text-primary">
                          Image: {plan.containerImage.name}
                        </p>
                      )}

                      {plan.error && (
                        <p className="mt-2 max-w-lg truncate text-sm text-destructive">
                          Error: {plan.error}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {/* Progress indicator */}
                    {plan.status === 'running' && (
                      <div className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        <span className="text-sm text-muted-foreground">
                          {successSteps.length}/{plan.steps.length}
                        </span>
                      </div>
                    )}

                    {plan.status === 'completed' && (
                      <div className="flex items-center gap-2 text-success">
                        <Check className="h-5 w-5" />
                        <span className="text-sm">{successSteps.length} steps</span>
                      </div>
                    )}

                    {(plan.status === 'failed' || plan.status === 'rolled_back') && (
                      <div className="flex items-center gap-2 text-destructive">
                        <X className="h-5 w-5" />
                        <span className="text-sm">{failedSteps.length} failed</span>
                      </div>
                    )}

                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                </div>

                {/* Step previews for running plans */}
                {plan.status === 'running' && plan.steps.length > 0 && (
                  <div className="mt-4 flex gap-2 border-t pt-4">
                    {plan.steps.slice(0, 6).map((step) => (
                      <StatusBadge
                        key={step.id}
                        kind="deployment"
                        value={step.status}
                        variant={stepStatusVariant(step.status)}
                        label={
                          <>
                            {step.status === 'running' && (
                              <Loader2 className="h-2 w-2 animate-spin" />
                            )}
                            {step.action === 'deploy' ? 'Deploy' : 'Health'} {step.service?.name}
                          </>
                        }
                      />
                    ))}
                    {plan.steps.length > 6 && (
                      <span className="text-xs text-muted-foreground">
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
