/**
 * Shared status utilities.
 *
 * The per-domain legacy class-returning helpers (getContainerStatusColor,
 * getHealthStatusColor, getServerStatusColor, getDeploymentStatusColor,
 * getBackupStatusColor, getSyncStatusColor, getServerStatusDotColor) were
 * removed in Phase 7 (#253) once every page moved to `statusVariant()` +
 * `StatusBadge`. The two helpers below remain — they return raw Tailwind color
 * utilities (status dot / health text), still used by a couple of detail pages.
 */

/** Background color class for an overall status dot. */
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

/** Text color class for container health display. */
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

/* ────────────────────────────────────────────────────────────────────────────
 * Single source of truth for status → Badge variant (#244).
 *
 * `statusVariant(kind, value)` feeds the `success | warning | info |
 * destructive | neutral` Badge/StatusBadge variants.
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
 * (or `neutral` for severity).
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
