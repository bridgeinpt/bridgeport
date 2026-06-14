import { useEffect, useState, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useAppStore } from '../lib/store';
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
import { safeJsonParse } from '../lib/helpers';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
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

export default function DeploymentPlanDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const setBreadcrumbName = useAppStore((s) => s.setBreadcrumbName);
  const toast = useToast();
  const confirm = useConfirm();
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
        if (id) setBreadcrumbName(id, plan.name);
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
    if (!plan) return;
    const confirmed = await confirm({
      title: 'Cancel this deployment plan?',
      confirmText: 'Cancel deployment',
      cancelText: 'Keep running',
      destructive: true,
    });
    if (!confirmed) return;
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
    if (!plan) return;
    const confirmed = await confirm({
      title: 'Rollback all deployed services to their previous versions?',
      confirmText: 'Rollback',
      destructive: true,
    });
    if (!confirmed) return;
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
        <Card>
          <CardContent className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const canExecute = plan.status === 'pending';
  const canCancel = plan.status === 'pending' || plan.status === 'running';
  const canRollback = plan.status === 'completed' || plan.status === 'failed';
  const successCount = plan.steps.filter((s) => s.status === 'success').length;

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <div className="mb-2 flex items-center gap-4">
            <Link
              to="/deployment-plans"
              className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" /> Deployment Plans
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-bold text-foreground">{plan.name}</span>
            <StatusBadge
              kind="deployment"
              value={plan.status}
              variant={planStatusVariant(plan.status)}
              label={plan.status.replace('_', ' ')}
            />
          </div>
          <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
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
              className="mt-1 inline-block text-sm text-primary hover:underline"
            >
              Image: {plan.containerImage.name}
            </Link>
          )}
        </div>

        <div className="flex gap-2">
          {canExecute && (
            <Button onClick={handleExecute} disabled={executing}>
              {executing ? 'Starting...' : 'Execute'}
            </Button>
          )}
          {canCancel && (
            <Button
              variant="ghost"
              onClick={handleCancel}
              disabled={cancelling}
              className="text-warning hover:text-warning"
            >
              {cancelling ? 'Cancelling...' : 'Cancel'}
            </Button>
          )}
          {canRollback && (
            <Button
              variant="ghost"
              onClick={handleRollback}
              disabled={rollingBack}
              className="text-warning hover:text-warning"
            >
              {rollingBack ? 'Rolling back...' : 'Rollback'}
            </Button>
          )}
        </div>
      </div>

      {/* Error message */}
      {plan.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{plan.error}</AlertDescription>
        </Alert>
      )}

      {/* Progress bar */}
      {plan.status === 'running' && (
        <Card className="mb-6">
          <CardContent>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Progress</span>
              <span className="text-sm text-muted-foreground">
                {successCount} / {plan.steps.length} steps
              </span>
            </div>
            <Progress
              value={plan.steps.length ? (successCount / plan.steps.length) * 100 : 0}
            />
          </CardContent>
        </Card>
      )}

      {/* Steps */}
      <Card>
        <CardHeader>
          <CardTitle>Deployment Steps</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {plan.steps.map((step, index) => (
            <StepCard
              key={step.id}
              step={step}
              index={index}
              expanded={expandedStep === step.id}
              onToggle={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
            />
          ))}
        </CardContent>
      </Card>

      {/* Logs */}
      {plan.logs && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Plan Logs</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-x-auto overflow-y-auto rounded bg-background p-4 font-mono text-sm text-foreground">
              {plan.logs}
            </pre>
          </CardContent>
        </Card>
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
  const isRunning = step.status === 'running';

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between p-4 text-left"
      >
        <div className="flex items-center gap-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground">
            {index + 1}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">
                {step.action === 'deploy'
                  ? 'Deploy'
                  : step.action === 'health_check'
                  ? 'Health Check'
                  : 'Rollback'}
              </span>
              {step.service && (
                <Link
                  to={`/services/${step.service.id}`}
                  className="text-foreground hover:text-primary"
                  onClick={(e) => e.stopPropagation()}
                >
                  {step.service.name}
                </Link>
              )}
              {step.service?.server?.name && (
                <span className="text-sm text-muted-foreground">
                  on {step.service.server.name}
                </span>
              )}
            </div>
            {step.targetTag && (
              <span className="font-mono text-sm text-muted-foreground">
                {step.previousTag && `${step.previousTag} → `}
                {step.targetTag}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {isRunning && <Loader2 className="h-4 w-4 animate-spin text-info" />}
          <StatusBadge
            kind="deployment"
            value={step.status}
            variant={stepStatusVariant(step.status)}
            label={step.status.replace('_', ' ')}
          />
          {step.completedAt && (
            <span className="text-xs text-muted-foreground">
              {format(new Date(step.completedAt), 'HH:mm:ss')}
            </span>
          )}
          <ChevronRight
            className={`h-5 w-5 text-muted-foreground transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-4">
          {step.error && (
            <div className="mb-4 rounded bg-destructive/10 p-3">
              <p className="text-sm text-destructive">{step.error}</p>
            </div>
          )}

          {step.action === 'health_check' && step.healthDetails && (
            <div className="mb-4">
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                Health Check Details
              </h4>
              <pre className="overflow-x-auto rounded bg-background p-3 text-xs text-foreground">
                {JSON.stringify(safeJsonParse(step.healthDetails, {}), null, 2)}
              </pre>
            </div>
          )}

          {step.logs && (
            <div>
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">Logs</h4>
              <pre className="max-h-48 overflow-x-auto overflow-y-auto rounded bg-background p-3 font-mono text-xs text-foreground">
                {step.logs}
              </pre>
            </div>
          )}

          {!step.error && !step.logs && !step.healthDetails && (
            <p className="text-sm text-muted-foreground">No additional details available</p>
          )}

          <div className="mt-4 flex gap-4 text-xs text-muted-foreground">
            {step.startedAt && (
              <span>Started: {format(new Date(step.startedAt), 'HH:mm:ss')}</span>
            )}
            {step.completedAt && (
              <span>Completed: {format(new Date(step.completedAt), 'HH:mm:ss')}</span>
            )}
            {step.startedAt && step.completedAt && (
              <span>
                Duration:{' '}
                {Math.round(
                  (new Date(step.completedAt).getTime() -
                    new Date(step.startedAt).getTime()) /
                    1000
                )}
                s
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
