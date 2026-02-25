import { describe, it, expect } from 'vitest';
import {
  getContainerStatusColor,
  getHealthStatusColor,
  getOverallStatusDotColor,
  getContainerHealthTextColor,
  getServerStatusColor,
  getServerStatusDotColor,
  getDeploymentStatusColor,
  getBackupStatusColor,
  getSyncStatusColor,
} from './status';

describe('getContainerStatusColor', () => {
  it('should return badge-success for running', () => {
    expect(getContainerStatusColor('running')).toBe('badge-success');
  });

  it('should return badge-error for stopped/exited/dead', () => {
    expect(getContainerStatusColor('stopped')).toBe('badge-error');
    expect(getContainerStatusColor('exited')).toBe('badge-error');
    expect(getContainerStatusColor('dead')).toBe('badge-error');
  });

  it('should return badge-warning for restarting/paused/created', () => {
    expect(getContainerStatusColor('restarting')).toBe('badge-warning');
    expect(getContainerStatusColor('paused')).toBe('badge-warning');
    expect(getContainerStatusColor('created')).toBe('badge-warning');
  });

  it('should return badge-warning for unknown status', () => {
    expect(getContainerStatusColor('unknown')).toBe('badge-warning');
    expect(getContainerStatusColor('')).toBe('badge-warning');
  });
});

describe('getHealthStatusColor', () => {
  it('should return badge-success for healthy', () => {
    expect(getHealthStatusColor('healthy')).toBe('badge-success');
  });

  it('should return badge-error for unhealthy', () => {
    expect(getHealthStatusColor('unhealthy')).toBe('badge-error');
  });

  it('should return badge-neutral for none', () => {
    expect(getHealthStatusColor('none')).toBe('badge-neutral');
  });

  it('should return badge-warning for unknown status', () => {
    expect(getHealthStatusColor('unknown')).toBe('badge-warning');
  });
});

describe('getOverallStatusDotColor', () => {
  it('should return bg-green-500 for healthy', () => {
    expect(getOverallStatusDotColor('healthy')).toBe('bg-green-500');
  });

  it('should return bg-blue-500 for running', () => {
    expect(getOverallStatusDotColor('running')).toBe('bg-blue-500');
  });

  it('should return bg-red-500 for unhealthy', () => {
    expect(getOverallStatusDotColor('unhealthy')).toBe('bg-red-500');
  });

  it('should return bg-yellow-500 for unknown status', () => {
    expect(getOverallStatusDotColor('something')).toBe('bg-yellow-500');
  });
});

describe('getContainerHealthTextColor', () => {
  it('should return text-green-400 for healthy', () => {
    expect(getContainerHealthTextColor('healthy')).toBe('text-green-400');
  });

  it('should return text-red-400 for unhealthy', () => {
    expect(getContainerHealthTextColor('unhealthy')).toBe('text-red-400');
  });

  it('should return text-yellow-400 for unknown', () => {
    expect(getContainerHealthTextColor('unknown')).toBe('text-yellow-400');
  });
});

describe('getServerStatusColor', () => {
  it('should return badge-success for healthy', () => {
    expect(getServerStatusColor('healthy')).toBe('badge-success');
  });

  it('should return badge-error for unhealthy', () => {
    expect(getServerStatusColor('unhealthy')).toBe('badge-error');
  });

  it('should return badge-warning for unknown', () => {
    expect(getServerStatusColor('pending')).toBe('badge-warning');
  });
});

describe('getServerStatusDotColor', () => {
  it('should return bg-green-500 for healthy', () => {
    expect(getServerStatusDotColor('healthy')).toBe('bg-green-500');
  });

  it('should return bg-red-500 for unhealthy', () => {
    expect(getServerStatusDotColor('unhealthy')).toBe('bg-red-500');
  });

  it('should return bg-yellow-500 for unknown', () => {
    expect(getServerStatusDotColor('pending')).toBe('bg-yellow-500');
  });
});

describe('getDeploymentStatusColor', () => {
  it('should return badge-success for success', () => {
    expect(getDeploymentStatusColor('success')).toBe('badge-success');
  });

  it('should return badge-error for failed', () => {
    expect(getDeploymentStatusColor('failed')).toBe('badge-error');
  });

  it('should return badge-info for deploying', () => {
    expect(getDeploymentStatusColor('deploying')).toBe('badge-info');
  });

  it('should return badge-warning for unknown', () => {
    expect(getDeploymentStatusColor('pending')).toBe('badge-warning');
  });
});

describe('getBackupStatusColor', () => {
  it('should return badge-success for completed', () => {
    expect(getBackupStatusColor('completed')).toBe('badge-success');
  });

  it('should return badge-error for failed', () => {
    expect(getBackupStatusColor('failed')).toBe('badge-error');
  });

  it('should return badge-info for running', () => {
    expect(getBackupStatusColor('running')).toBe('badge-info');
  });

  it('should return badge-warning for unknown', () => {
    expect(getBackupStatusColor('pending')).toBe('badge-warning');
  });
});

describe('getSyncStatusColor', () => {
  it('should return badge-success for synced', () => {
    expect(getSyncStatusColor('synced')).toBe('badge-success');
  });

  it('should return badge-warning for pending', () => {
    expect(getSyncStatusColor('pending')).toBe('badge-warning');
  });

  it('should return badge-warning for outdated', () => {
    expect(getSyncStatusColor('outdated')).toBe('badge-warning');
  });

  it('should return badge-neutral for never', () => {
    expect(getSyncStatusColor('never')).toBe('badge-neutral');
  });
});
