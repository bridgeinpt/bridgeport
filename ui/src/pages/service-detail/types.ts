import type {
  ServiceWithServer,
  Deployment,
  EnvTemplate,
  ServiceFile,
  ConfigFile,
  SyncResult,
  RegistryConnection,
  AuditLog,
  ExposedPort,
  ServiceHistoryEntry,
} from '../../lib/api';

export interface HealthCheckResultData {
  status: string;
  containerStatus: string;
  healthStatus: string;
  container: { state: string; status: string; health?: string; running: boolean };
  url: { success: boolean; statusCode?: number; error?: string } | null;
  exposedPorts: ExposedPort[];
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  latestTag?: string;
}

export {
  ServiceWithServer,
  Deployment,
  EnvTemplate,
  ServiceFile,
  ConfigFile,
  SyncResult,
  RegistryConnection,
  AuditLog,
  ExposedPort,
  ServiceHistoryEntry,
};
