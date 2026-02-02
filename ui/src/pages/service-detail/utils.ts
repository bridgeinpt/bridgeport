import type { ExposedPort } from './types';

export function parseExposedPorts(portsJson: string | null): ExposedPort[] {
  if (!portsJson) return [];
  try {
    return JSON.parse(portsJson);
  } catch {
    return [];
  }
}

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

export function getHealthStatusColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'badge-success';
    case 'unhealthy':
      return 'badge-error';
    case 'none':
      return 'bg-slate-600 text-slate-300';
    default:
      return 'badge-warning';
  }
}

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
