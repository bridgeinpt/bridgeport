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
