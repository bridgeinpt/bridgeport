import { Link } from 'react-router-dom';
import { ArrowUp, HeartPulse, Loader2, Undo2 } from 'lucide-react';
import type {
  DeploymentPlan,
  DeploymentPlanStep,
  DeploymentStepStatus,
} from '../lib/api';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { StatusBadge } from '@/components/ui/status-badge';
import type { StatusVariant } from '@/lib/status';
import { cn } from '@/lib/utils';

/** Map a step status to a semantic Badge variant (mirrors statusVariant's domains). */
function stepVariant(status: DeploymentStepStatus): StatusVariant {
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

interface DeploymentProgressProps {
  plan: DeploymentPlan;
  compact?: boolean;
}

export function DeploymentProgress({ plan, compact = false }: DeploymentProgressProps) {
  const completedSteps = plan.steps.filter((s) => s.status === 'success').length;
  const progress = plan.steps.length > 0 ? (completedSteps / plan.steps.length) * 100 : 0;

  if (compact) {
    return (
      <Link
        to={`/deployment-plans/${plan.id}`}
        className="flex items-center gap-3 rounded p-2 bg-muted/50 transition-colors hover:bg-muted"
      >
        {plan.status === 'running' && (
          <Loader2 className="size-4 animate-spin text-primary" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{plan.name}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge
              kind="deployment"
              value={plan.status}
              label={plan.status}
              className="px-1.5 py-0"
            />
            <span>
              {completedSteps}/{plan.steps.length}
            </span>
          </div>
        </div>
        {plan.status === 'running' && (
          <Progress value={progress} className="h-1.5 w-16 bg-muted" />
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
            <Loader2 className="size-5 animate-spin text-primary" />
          )}
          <div className="space-y-1">
            <h3 className="font-medium text-foreground">{plan.name}</h3>
            <StatusBadge
              kind="deployment"
              value={plan.status}
              label={plan.status.replace('_', ' ')}
            />
          </div>
        </div>
        <Link
          to={`/deployment-plans/${plan.id}`}
          className="text-sm text-primary hover:text-primary/80"
        >
          View Details →
        </Link>
      </div>

      {/* Progress bar */}
      <div>
        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
          <span>Progress</span>
          <span>
            {completedSteps} / {plan.steps.length} steps
          </span>
        </div>
        <Progress
          value={progress}
          className={cn(
            plan.status === 'failed'
              ? '[&_[data-slot=progress-indicator]]:bg-destructive'
              : plan.status === 'completed'
                ? '[&_[data-slot=progress-indicator]]:bg-success'
                : '[&_[data-slot=progress-indicator]]:bg-primary'
          )}
        />
      </div>

      {/* Steps */}
      <div className="flex flex-wrap gap-2">
        {plan.steps.slice(0, 8).map((step) => (
          <StepBadge key={step.id} step={step} />
        ))}
        {plan.steps.length > 8 && (
          <span className="text-xs text-muted-foreground">+{plan.steps.length - 8} more</span>
        )}
      </div>

      {/* Error */}
      {plan.error && <p className="truncate text-sm text-destructive">{plan.error}</p>}
    </div>
  );
}

function StepBadge({ step }: { step: DeploymentPlanStep }) {
  const isRunning = step.status === 'running';
  const ActionIcon =
    step.action === 'deploy' ? ArrowUp : step.action === 'health_check' ? HeartPulse : Undo2;

  return (
    <Badge variant={stepVariant(step.status)} className="gap-1.5">
      {isRunning ? (
        <Loader2 className="size-2.5 animate-spin" />
      ) : (
        <ActionIcon className="size-3" />
      )}
      <span>{step.service?.name || 'Unknown'}</span>
    </Badge>
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
    <Card className="gap-4 p-6">
      <h3 className="font-medium text-foreground">Active Deployments</h3>
      <div className="space-y-3">
        {activePlans.map((plan) => (
          <DeploymentProgress key={plan.id} plan={plan} />
        ))}
      </div>
    </Card>
  );
}
