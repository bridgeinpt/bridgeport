import { prisma } from '../lib/db.js';
import { DOCKER_MODE, METRICS_MODE } from '../lib/constants.js';

// ==================== Types ====================

export interface SettingDefinition {
  key: string;
  type: 'boolean' | 'integer' | 'string';
  default: boolean | number | string;
  label: string;
  description: string;
  group: string;
  widget: 'toggle' | 'number' | 'text' | 'select';
  options?: string[];
  min?: number;
  max?: number;
}

export type SettingsModule = 'general' | 'monitoring' | 'operations' | 'data' | 'configuration';

// ==================== Setting Definitions ====================

export const GENERAL_SETTINGS: SettingDefinition[] = [
  {
    key: 'sshUser',
    type: 'string',
    default: 'root',
    label: 'SSH User',
    description: 'Default SSH username for connecting to servers in this environment',
    group: 'SSH Configuration',
    widget: 'text',
  },
];

export const MONITORING_SETTINGS: SettingDefinition[] = [
  {
    key: 'enabled',
    type: 'boolean',
    default: false,
    label: 'Enable Monitoring',
    description: 'Master toggle for all monitoring in this environment',
    group: 'General',
    widget: 'toggle',
  },
  {
    key: 'serverHealthIntervalMs',
    type: 'integer',
    default: 60000,
    label: 'Server Health Interval',
    description: 'How often to check server health (milliseconds)',
    group: 'Health Check Intervals',
    widget: 'number',
    min: 10000,
    max: 86400000,
  },
  {
    key: 'serviceHealthIntervalMs',
    type: 'integer',
    default: 60000,
    label: 'Service Health Interval',
    description: 'How often to check service health (milliseconds)',
    group: 'Health Check Intervals',
    widget: 'number',
    min: 10000,
    max: 86400000,
  },
  {
    key: 'discoveryIntervalMs',
    type: 'integer',
    default: 300000,
    label: 'Discovery Interval',
    description: 'How often to discover new containers (milliseconds)',
    group: 'Other Schedules',
    widget: 'number',
    min: 10000,
    max: 86400000,
  },
  {
    key: 'metricsIntervalMs',
    type: 'integer',
    default: 300000,
    label: 'Metrics Collection Interval',
    description: 'How often to collect server and service metrics (milliseconds)',
    group: 'Metrics Collection',
    widget: 'number',
    min: 10000,
    max: 86400000,
  },
  {
    key: 'updateCheckIntervalMs',
    type: 'integer',
    default: 1800000,
    label: 'Update Check Interval',
    description: 'How often to check for container image updates (milliseconds)',
    group: 'Other Schedules',
    widget: 'number',
    min: 10000,
    max: 86400000,
  },
  {
    key: 'backupCheckIntervalMs',
    type: 'integer',
    default: 60000,
    label: 'Backup Check Interval',
    description: 'How often to check for scheduled backups (milliseconds)',
    group: 'Other Schedules',
    widget: 'number',
    min: 10000,
    max: 86400000,
  },
  {
    key: 'metricsRetentionDays',
    type: 'integer',
    default: 7,
    label: 'Metrics Retention',
    description: 'Number of days to retain metrics data',
    group: 'Retention',
    widget: 'number',
    min: 1,
    max: 365,
  },
  {
    key: 'healthLogRetentionDays',
    type: 'integer',
    default: 30,
    label: 'Health Log Retention',
    description: 'Number of days to retain health check logs',
    group: 'Retention',
    widget: 'number',
    min: 1,
    max: 365,
  },
  {
    key: 'bounceThreshold',
    type: 'integer',
    default: 3,
    label: 'Bounce Threshold',
    description: 'Number of consecutive failures before triggering an alert',
    group: 'Alert Configuration',
    widget: 'number',
    min: 1,
    max: 10,
  },
  {
    key: 'bounceCooldownMs',
    type: 'integer',
    default: 900000,
    label: 'Bounce Cooldown',
    description: 'Cooldown period after an alert before re-alerting (milliseconds)',
    group: 'Alert Configuration',
    widget: 'number',
    min: 10000,
    max: 86400000,
  },
  {
    key: 'collectCpu',
    type: 'boolean',
    default: true,
    label: 'Collect CPU Metrics',
    description: 'Collect CPU usage metrics from servers',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectMemory',
    type: 'boolean',
    default: true,
    label: 'Collect Memory Metrics',
    description: 'Collect memory usage metrics from servers',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectSwap',
    type: 'boolean',
    default: true,
    label: 'Collect Swap Metrics',
    description: 'Collect swap usage metrics from servers',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectDisk',
    type: 'boolean',
    default: true,
    label: 'Collect Disk Metrics',
    description: 'Collect disk usage metrics from servers',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectLoad',
    type: 'boolean',
    default: true,
    label: 'Collect Load Average',
    description: 'Collect system load average from servers',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectFds',
    type: 'boolean',
    default: true,
    label: 'Collect File Descriptors',
    description: 'Collect file descriptor counts from servers',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectTcp',
    type: 'boolean',
    default: true,
    label: 'Collect TCP Metrics',
    description: 'Collect TCP connection metrics from servers',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectProcesses',
    type: 'boolean',
    default: true,
    label: 'Collect Process Count',
    description: 'Collect running process count from servers',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectTcpChecks',
    type: 'boolean',
    default: true,
    label: 'Collect TCP Checks',
    description: 'Run TCP connectivity checks on services',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
  {
    key: 'collectCertChecks',
    type: 'boolean',
    default: true,
    label: 'Collect Certificate Checks',
    description: 'Check TLS certificate expiry on services',
    group: 'Metrics Collection',
    widget: 'toggle',
  },
];

export const OPERATIONS_SETTINGS: SettingDefinition[] = [
  {
    key: 'defaultDockerMode',
    type: 'string',
    default: DOCKER_MODE.SSH,
    label: 'Default Docker Mode',
    description: 'Default method for connecting to Docker daemon on new servers',
    group: 'Server Defaults',
    widget: 'select',
    options: [DOCKER_MODE.SSH, DOCKER_MODE.SOCKET],
  },
  {
    key: 'defaultMetricsMode',
    type: 'string',
    default: METRICS_MODE.DISABLED,
    label: 'Default Metrics Mode',
    description: 'Default metrics collection mode for new servers',
    group: 'Server Defaults',
    widget: 'select',
    options: [METRICS_MODE.DISABLED, METRICS_MODE.SSH, METRICS_MODE.AGENT],
  },
];

export const DATA_SETTINGS: SettingDefinition[] = [
  {
    key: 'allowBackupDownload',
    type: 'boolean',
    default: false,
    label: 'Allow Backup Download',
    description: 'Allow users to download database backups from the UI',
    group: 'Backup Settings',
    widget: 'toggle',
  },
  {
    key: 'defaultMonitoringEnabled',
    type: 'boolean',
    default: false,
    label: 'Default Monitoring Enabled',
    description: 'Enable monitoring by default when adding new databases',
    group: 'Database Monitoring Defaults',
    widget: 'toggle',
  },
  {
    key: 'defaultCollectionIntervalSec',
    type: 'integer',
    default: 300,
    label: 'Default Collection Interval',
    description: 'Default metrics collection interval for new databases (seconds)',
    group: 'Database Monitoring Defaults',
    widget: 'number',
    min: 60,
    max: 3600,
  },
];

export const CONFIGURATION_SETTINGS: SettingDefinition[] = [
  {
    key: 'allowSecretReveal',
    type: 'boolean',
    default: true,
    label: 'Allow Secret Reveal',
    description: 'Allow users to reveal secret values in the UI',
    group: 'Security',
    widget: 'toggle',
  },
];

// ==================== Registry ====================

export const SETTINGS_REGISTRY: Record<SettingsModule, SettingDefinition[]> = {
  general: GENERAL_SETTINGS,
  monitoring: MONITORING_SETTINGS,
  operations: OPERATIONS_SETTINGS,
  data: DATA_SETTINGS,
  configuration: CONFIGURATION_SETTINGS,
};

// ==================== Prisma Model Mapping ====================

type PrismaDelegate = {
  findUnique: (args: { where: { environmentId: string } }) => Promise<Record<string, unknown> | null>;
  upsert: (args: { where: { environmentId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
};

function getPrismaDelegate(module: SettingsModule): PrismaDelegate {
  const delegates: Record<SettingsModule, PrismaDelegate> = {
    general: prisma.generalSettings as unknown as PrismaDelegate,
    monitoring: prisma.monitoringSettings as unknown as PrismaDelegate,
    operations: prisma.operationsSettings as unknown as PrismaDelegate,
    data: prisma.dataSettings as unknown as PrismaDelegate,
    configuration: prisma.configurationSettings as unknown as PrismaDelegate,
  };
  return delegates[module];
}

function getDefaults(module: SettingsModule): Record<string, unknown> {
  const defs = SETTINGS_REGISTRY[module];
  const defaults: Record<string, unknown> = {};
  for (const def of defs) {
    defaults[def.key] = def.default;
  }
  return defaults;
}

function stripMeta(record: Record<string, unknown>): Record<string, unknown> {
  const { id, environmentId, ...rest } = record;
  return rest;
}

// ==================== Validation ====================

function validateValue(def: SettingDefinition, value: unknown): string | null {
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') return `${def.key} must be a boolean`;
  } else if (def.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return `${def.key} must be an integer`;
    if (def.min !== undefined && value < def.min) return `${def.key} must be at least ${def.min}`;
    if (def.max !== undefined && value > def.max) return `${def.key} must be at most ${def.max}`;
  } else if (def.type === 'string') {
    if (typeof value !== 'string') return `${def.key} must be a string`;
    if (def.options && !def.options.includes(value)) return `${def.key} must be one of: ${def.options.join(', ')}`;
  }
  return null;
}

// ==================== Service Functions ====================

export async function getModuleSettings(environmentId: string, module: SettingsModule): Promise<Record<string, unknown>> {
  const delegate = getPrismaDelegate(module);
  const record = await delegate.findUnique({ where: { environmentId } });
  if (!record) {
    return getDefaults(module);
  }
  return stripMeta(record);
}

export async function updateModuleSettings(
  environmentId: string,
  module: SettingsModule,
  data: Record<string, unknown>,
): Promise<{ updated: Record<string, unknown>; changes: Array<{ key: string; from: unknown; to: unknown }> }> {
  const definitions = SETTINGS_REGISTRY[module];
  const defMap = new Map(definitions.map(d => [d.key, d]));

  // Validate all keys and values
  const errors: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    const def = defMap.get(key);
    if (!def) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    const error = validateValue(def, value);
    if (error) errors.push(error);
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  // Get current values
  const current = await getModuleSettings(environmentId, module);

  // Compute changes
  const changes: Array<{ key: string; from: unknown; to: unknown }> = [];
  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (current[key] !== value) {
      changes.push({ key, from: current[key], to: value });
      updateData[key] = value;
    }
  }

  if (changes.length > 0) {
    const delegate = getPrismaDelegate(module);
    await delegate.upsert({
      where: { environmentId },
      create: { environmentId, ...getDefaults(module), ...updateData },
      update: updateData,
    });
  }

  const updated = await getModuleSettings(environmentId, module);
  return { updated, changes };
}

export async function resetModuleSettings(environmentId: string, module: SettingsModule): Promise<Record<string, unknown>> {
  const defaults = getDefaults(module);
  const delegate = getPrismaDelegate(module);
  await delegate.upsert({
    where: { environmentId },
    create: { environmentId, ...defaults },
    update: defaults,
  });
  return defaults;
}

export async function createDefaultSettings(environmentId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Use upsert to be idempotent (safe to call multiple times)
    await tx.generalSettings.upsert({
      where: { environmentId },
      create: { environmentId },
      update: {},
    });
    await tx.monitoringSettings.upsert({
      where: { environmentId },
      create: { environmentId },
      update: {},
    });
    await tx.operationsSettings.upsert({
      where: { environmentId },
      create: { environmentId },
      update: {},
    });
    await tx.dataSettings.upsert({
      where: { environmentId },
      create: { environmentId },
      update: {},
    });
    await tx.configurationSettings.upsert({
      where: { environmentId },
      create: { environmentId },
      update: {},
    });
  });
}
