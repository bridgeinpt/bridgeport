/**
 * Typed status constants for all status/mode fields in the codebase.
 * Use these instead of raw string literals in comparisons and assignments.
 */

// ==================== Server ====================

export const SERVER_STATUS = {
  HEALTHY: 'healthy',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown',
} as const;
export type ServerStatus = (typeof SERVER_STATUS)[keyof typeof SERVER_STATUS];

// ==================== Container / Service ====================

export const CONTAINER_STATUS = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  EXITED: 'exited',
  CREATED: 'created',
  RESTARTING: 'restarting',
  PAUSED: 'paused',
  DEAD: 'dead',
  NOT_FOUND: 'not_found',
} as const;
export type ContainerStatus = (typeof CONTAINER_STATUS)[keyof typeof CONTAINER_STATUS];

export const HEALTH_STATUS = {
  HEALTHY: 'healthy',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown',
  NONE: 'none',
} as const;
export type HealthStatus = (typeof HEALTH_STATUS)[keyof typeof HEALTH_STATUS];

export const DISCOVERY_STATUS = {
  FOUND: 'found',
  MISSING: 'missing',
} as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUS)[keyof typeof DISCOVERY_STATUS];

// ==================== Deployment ====================

export const DEPLOYMENT_STATUS = {
  PENDING: 'pending',
  DEPLOYING: 'deploying',
  SUCCESS: 'success',
  FAILED: 'failed',
} as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUS)[keyof typeof DEPLOYMENT_STATUS];

export const PLAN_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  ROLLED_BACK: 'rolled_back',
} as const;
export type PlanStatus = (typeof PLAN_STATUS)[keyof typeof PLAN_STATUS];

export const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  ROLLED_BACK: 'rolled_back',
} as const;
export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];

export const HISTORY_STATUS = {
  SUCCESS: 'success',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
} as const;
export type HistoryStatus = (typeof HISTORY_STATUS)[keyof typeof HISTORY_STATUS];

// ==================== Agent ====================

export const AGENT_STATUS = {
  UNKNOWN: 'unknown',
  DEPLOYING: 'deploying',
  WAITING: 'waiting',
  ACTIVE: 'active',
  STALE: 'stale',
  OFFLINE: 'offline',
} as const;
export type AgentStatus = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];

// ==================== Infrastructure Modes ====================

export const DOCKER_MODE = {
  SSH: 'ssh',
  SOCKET: 'socket',
} as const;
export type DockerMode = (typeof DOCKER_MODE)[keyof typeof DOCKER_MODE];

export const METRICS_MODE = {
  SSH: 'ssh',
  AGENT: 'agent',
  DISABLED: 'disabled',
} as const;
export type MetricsMode = (typeof METRICS_MODE)[keyof typeof METRICS_MODE];

export const SERVER_TYPE = {
  REMOTE: 'remote',
  HOST: 'host',
} as const;
export type ServerType = (typeof SERVER_TYPE)[keyof typeof SERVER_TYPE];

// ==================== Health Check ====================

export const HEALTH_CHECK_STATUS = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  TIMEOUT: 'timeout',
} as const;
export type HealthCheckStatus = (typeof HEALTH_CHECK_STATUS)[keyof typeof HEALTH_CHECK_STATUS];
