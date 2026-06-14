import { describe, it, expect } from 'vitest';
import {
  getOverallStatusDotColor,
  getContainerHealthTextColor,
  statusVariant,
  metricSeverity,
} from './status';

describe('getOverallStatusDotColor', () => {
  it('maps known statuses', () => {
    expect(getOverallStatusDotColor('healthy')).toBe('bg-green-500');
    expect(getOverallStatusDotColor('running')).toBe('bg-blue-500');
    expect(getOverallStatusDotColor('unhealthy')).toBe('bg-red-500');
  });
  it('falls back for unknown', () => {
    expect(getOverallStatusDotColor('something')).toBe('bg-yellow-500');
  });
});

describe('getContainerHealthTextColor', () => {
  it('maps known health values', () => {
    expect(getContainerHealthTextColor('healthy')).toBe('text-green-400');
    expect(getContainerHealthTextColor('unhealthy')).toBe('text-red-400');
  });
  it('falls back for unknown', () => {
    expect(getContainerHealthTextColor('unknown')).toBe('text-yellow-400');
  });
});

describe('statusVariant', () => {
  it('maps container statuses', () => {
    expect(statusVariant('container', 'running')).toBe('success');
    expect(statusVariant('container', 'exited')).toBe('destructive');
    expect(statusVariant('container', 'paused')).toBe('warning');
  });
  it('maps health statuses', () => {
    expect(statusVariant('health', 'healthy')).toBe('success');
    expect(statusVariant('health', 'unhealthy')).toBe('destructive');
    expect(statusVariant('health', 'none')).toBe('neutral');
  });
  it('maps deployment statuses', () => {
    expect(statusVariant('deployment', 'success')).toBe('success');
    expect(statusVariant('deployment', 'failed')).toBe('destructive');
    expect(statusVariant('deployment', 'deploying')).toBe('info');
  });
  it('maps sync statuses including not_attached', () => {
    expect(statusVariant('sync', 'synced')).toBe('success');
    expect(statusVariant('sync', 'outdated')).toBe('warning');
    expect(statusVariant('sync', 'not_attached')).toBe('neutral');
    expect(statusVariant('sync', 'never')).toBe('neutral');
  });
  it('maps severities and is case-insensitive', () => {
    expect(statusVariant('severity', 'CRITICAL')).toBe('destructive');
    expect(statusVariant('severity', 'Warning')).toBe('warning');
    expect(statusVariant('severity', 'info')).toBe('info');
  });
  it('falls back gracefully for nullish values', () => {
    expect(statusVariant('container', undefined)).toBe('warning');
    expect(statusVariant('severity', null)).toBe('neutral');
  });
});

describe('metricSeverity', () => {
  it('classifies by threshold (crit/warn are upper bounds)', () => {
    expect(metricSeverity(95, 70, 90)).toBe('critical');
    expect(metricSeverity(90, 70, 90)).toBe('critical');
    expect(metricSeverity(75, 70, 90)).toBe('warning');
    expect(metricSeverity(70, 70, 90)).toBe('warning');
    expect(metricSeverity(20, 70, 90)).toBe('normal');
  });
});
