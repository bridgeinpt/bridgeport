/**
 * Shared status color utilities for consistent styling across the application.
 */

/**
 * Returns the badge CSS class for a container status.
 */
export function getContainerStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'badge-success';
    case 'stopped':
    case 'exited':
    case 'dead':
      return 'badge-error';
    case 'restarting':
    case 'paused':
    case 'created':
      return 'badge-warning';
    default:
      return 'badge-warning';
  }
}

/**
 * Returns the badge CSS class for a health status.
 */
export function getHealthStatusColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'badge-success';
    case 'unhealthy':
      return 'badge-error';
    case 'none':
      return 'badge-neutral';
    default:
      return 'badge-warning';
  }
}

/**
 * Returns the background color class for an overall status dot.
 */
export function getOverallStatusDotColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'bg-green-500';
    case 'running':
      return 'bg-blue-500';
    case 'unhealthy':
      return 'bg-red-500';
    default:
      return 'bg-yellow-500';
  }
}

/**
 * Returns the text color class for container health display.
 */
export function getContainerHealthTextColor(health: string): string {
  switch (health) {
    case 'healthy':
      return 'text-green-400';
    case 'unhealthy':
      return 'text-red-400';
    default:
      return 'text-yellow-400';
  }
}

/**
 * Returns the badge CSS class for a server status.
 */
export function getServerStatusColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'badge-success';
    case 'unhealthy':
      return 'badge-error';
    default:
      return 'badge-warning';
  }
}

/**
 * Returns the dot background color class for a server status.
 */
export function getServerStatusDotColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'bg-green-500';
    case 'unhealthy':
      return 'bg-red-500';
    default:
      return 'bg-yellow-500';
  }
}

/**
 * Returns the badge CSS class for a deployment status.
 */
export function getDeploymentStatusColor(status: string): string {
  switch (status) {
    case 'success':
      return 'badge-success';
    case 'failed':
      return 'badge-error';
    case 'deploying':
      return 'badge-info';
    default:
      return 'badge-warning';
  }
}

/**
 * Returns the badge CSS class for a backup status.
 */
export function getBackupStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'badge-success';
    case 'failed':
      return 'badge-error';
    case 'running':
      return 'badge-info';
    default:
      return 'badge-warning';
  }
}

/**
 * Returns the badge CSS class for a sync status.
 */
export function getSyncStatusColor(status: 'synced' | 'pending' | 'never' | 'outdated'): string {
  switch (status) {
    case 'synced':
      return 'badge-success';
    case 'pending':
    case 'outdated':
      return 'badge-warning';
    case 'never':
      return 'badge-neutral';
    default:
      return 'badge-warning';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * shadcn migration (#244): single source of truth for status → Badge variant.
 *
 * `statusVariant(kind, value)` collapses the per-domain class-returning helpers
 * above into one mapper feeding the `success | warning | info | destructive |
 * neutral` Badge/StatusBadge variants. The legacy `get*StatusColor` helpers stay
 * until every page migrates off the `badge-*` classes (removed in Phase 7).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Badge variants used for status display. */
export type StatusVariant = 'success' | 'warning' | 'info' | 'destructive' | 'neutral';

/** Domains a status value can belong to (drives the value→variant mapping). */
export type StatusKind =
  | 'container'
  | 'health'
  | 'server'
  | 'deployment'
  | 'backup'
  | 'sync'
  | 'overall'
  | 'severity';

/**
 * Map a status value within a domain to a semantic Badge variant.
 * Matching is case-insensitive; unknown values fall back to `warning`
 * (or `neutral` for severity), preserving the legacy helpers' behavior.
 */
export function statusVariant(kind: StatusKind, value: string | null | undefined): StatusVariant {
  const v = (value ?? '').toLowerCase();
  switch (kind) {
    case 'container':
      if (v === 'running') return 'success';
      if (v === 'stopped' || v === 'exited' || v === 'dead') return 'destructive';
      return 'warning'; // restarting / paused / created / unknown
    case 'health':
      if (v === 'healthy') return 'success';
      if (v === 'unhealthy') return 'destructive';
      if (v === 'none') return 'neutral';
      return 'warning';
    case 'server':
      if (v === 'healthy') return 'success';
      if (v === 'unhealthy') return 'destructive';
      return 'warning';
    case 'deployment':
      if (v === 'success' || v === 'deployed') return 'success';
      if (v === 'failed' || v === 'error') return 'destructive';
      if (v === 'deploying' || v === 'in_progress') return 'info';
      return 'warning';
    case 'backup':
      if (v === 'completed' || v === 'success') return 'success';
      if (v === 'failed') return 'destructive';
      if (v === 'running') return 'info';
      return 'warning';
    case 'sync':
      if (v === 'synced') return 'success';
      if (v === 'pending' || v === 'outdated') return 'warning';
      if (v === 'never' || v === 'not_attached') return 'neutral';
      return 'warning';
    case 'overall':
      if (v === 'healthy') return 'success';
      if (v === 'running') return 'info';
      if (v === 'unhealthy') return 'destructive';
      return 'warning';
    case 'severity':
      if (v === 'critical' || v === 'error') return 'destructive';
      if (v === 'warning' || v === 'warn') return 'warning';
      if (v === 'info') return 'info';
      if (v === 'success') return 'success';
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** Severity of a numeric metric against warn/critical thresholds (#250). */
export type MetricSeverity = 'normal' | 'warning' | 'critical';

/**
 * Classify a metric value by threshold. `crit`/`warn` are upper bounds:
 * value ≥ crit → critical, value ≥ warn → warning, else normal. Drives the
 * danger-zone coloring on monitoring gauges.
 */
export function metricSeverity(value: number, warn: number, crit: number): MetricSeverity {
  if (value >= crit) return 'critical';
  if (value >= warn) return 'warning';
  return 'normal';
}
