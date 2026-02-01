const API_BASE = '/api';

interface ApiError {
  error: string;
  details?: unknown;
}

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('auth_token');
    }
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      this.setToken(null);
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error((data as ApiError).error || 'Request failed');
    }

    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

export const api = new ApiClient();

// Auth
export const login = (email: string, password: string) =>
  api.post<{ token: string; user: User }>('/auth/login', { email, password });

export const register = (email: string, password: string, name?: string) =>
  api.post<{ token: string; user: User }>('/auth/register', { email, password, name });

export const getMe = () => api.get<{ user: User }>('/auth/me');

// Users
export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  name?: string;
  role?: UserRole;
}

export interface ChangePasswordInput {
  currentPassword?: string;
  newPassword: string;
}

export const listUsers = () =>
  api.get<{ users: User[] }>('/users');

export const getUser = (id: string) =>
  api.get<{ user: User }>(`/users/${id}`);

export const createUser = (data: CreateUserInput) =>
  api.post<{ user: User }>('/users', data);

export const updateUser = (id: string, data: UpdateUserInput) =>
  api.patch<{ user: User }>(`/users/${id}`, data);

export const deleteUser = (id: string) =>
  api.delete<{ success: boolean }>(`/users/${id}`);

export const changeUserPassword = (id: string, data: ChangePasswordInput) =>
  api.post<{ success: boolean; message: string }>(`/users/${id}/change-password`, data);

// Environments
export const listEnvironments = () =>
  api.get<{ environments: Environment[] }>('/environments');

export const getEnvironment = (id: string) =>
  api.get<{ environment: EnvironmentWithServers }>(`/environments/${id}`);

export const createEnvironment = (name: string) =>
  api.post<{ environment: Environment }>('/environments', { name });

// Environment settings
export interface EnvironmentSettings {
  allowSecretReveal: boolean;
}

export const getEnvironmentSettings = (id: string) =>
  api.get<{ settings: EnvironmentSettings }>(`/environments/${id}/settings`);

export const updateEnvironmentSettings = (id: string, settings: Partial<EnvironmentSettings>) =>
  api.patch<{ settings: EnvironmentSettings }>(`/environments/${id}/settings`, settings);

// Servers
export const listServers = (envId: string) =>
  api.get<{ servers: Server[] }>(`/environments/${envId}/servers`);

export const getServer = (id: string) =>
  api.get<{ server: ServerWithServices }>(`/servers/${id}`);

export const checkServerHealth = (id: string) =>
  api.post<{ status: string; error?: string }>(`/servers/${id}/health`);

export const discoverContainers = (id: string) =>
  api.post<{ services: Service[] }>(`/servers/${id}/discover`);

export interface CreateServiceInput {
  name: string;
  containerName: string;
  imageName: string;
  imageTag?: string;
  composePath?: string;
  envTemplateName?: string;
  healthCheckUrl?: string;
}

export const createService = (serverId: string, data: CreateServiceInput) =>
  api.post<{ service: Service }>(`/servers/${serverId}/services`, data);

// Agent deployment
export const deployAgent = (id: string, bridgeportUrl?: string) =>
  api.post<{ success: boolean; message?: string }>(`/servers/${id}/agent/deploy`, bridgeportUrl ? { bridgeportUrl } : {});

export const removeAgent = (id: string) =>
  api.post<{ success: boolean; message?: string }>(`/servers/${id}/agent/remove`);

export const getAgentStatus = (id: string) =>
  api.get<{ metricsMode: string; hasToken: boolean; installed: boolean; running: boolean; error?: string }>(`/servers/${id}/agent/status`);

export const setMetricsMode = (id: string, mode: 'ssh' | 'agent' | 'disabled') =>
  api.patch<{ metricsMode: string }>(`/servers/${id}/metrics-mode`, { mode });

// Services
export const getService = (id: string) =>
  api.get<{ service: ServiceWithServer }>(`/services/${id}`);

export const deployService = (id: string, options: DeployOptions) =>
  api.post<{ deployment: Deployment; logs: string }>(`/services/${id}/deploy`, options);

export const restartService = (id: string) =>
  api.post<{ success: boolean }>(`/services/${id}/restart`);

export const deleteService = (id: string) =>
  api.delete<{ success: boolean }>(`/services/${id}`);

export const checkServiceHealth = (id: string) =>
  api.post<{
    status: string;
    container: { state: string; status: string; health?: string; running: boolean };
    url: { success: boolean; statusCode?: number; error?: string } | null;
    lastCheckedAt: string;
  }>(`/services/${id}/health`);

export const getServiceLogs = (id: string, tail?: number) =>
  api.get<{ logs: string }>(`/services/${id}/logs${tail ? `?tail=${tail}` : ''}`);

export const getDeploymentHistory = (id: string) =>
  api.get<{ deployments: Deployment[] }>(`/services/${id}/deployments`);

// Secrets
export const listSecrets = (envId: string) =>
  api.get<{ secrets: Secret[] }>(`/environments/${envId}/secrets`);

export const createSecret = (envId: string, data: SecretInput) =>
  api.post<{ secret: Secret }>(`/environments/${envId}/secrets`, data);

export const getSecretValue = (id: string) =>
  api.get<{ value: string }>(`/secrets/${id}/value`);

export const updateSecret = (id: string, data: Partial<SecretInput>) =>
  api.patch<{ secret: Secret }>(`/secrets/${id}`, data);

export const deleteSecret = (id: string) =>
  api.delete<{ success: boolean }>(`/secrets/${id}`);

// Types
export type UserRole = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  createdAt?: string;
  updatedAt?: string;
}

export interface Environment {
  id: string;
  name: string;
  createdAt: string;
  _count: { servers: number; secrets: number };
}

export interface EnvironmentWithServers extends Environment {
  servers: ServerWithServices[];
}

export interface Server {
  id: string;
  name: string;
  hostname: string;
  publicIp: string | null;
  tags: string;
  status: string;
  lastCheckedAt: string | null;
  environmentId: string;
}

export interface ServerWithServices extends Server {
  services: Service[];
}

export interface Service {
  id: string;
  name: string;
  containerName: string;
  imageName: string;
  imageTag: string;
  composePath: string | null;
  envTemplateName: string | null;
  healthCheckUrl: string | null;
  status: string;
  discoveryStatus: string; // 'found' | 'missing'
  lastCheckedAt: string | null;
  lastDiscoveredAt: string | null;
  serverId: string;
  // Auto-update fields
  autoUpdate: boolean;
  latestAvailableTag: string | null;
  latestAvailableDigest: string | null;
  lastUpdateCheckAt: string | null;
  registryConnectionId: string | null;
}

export interface ServiceWithServer extends Service {
  server: Server & { environment: Environment };
}

export interface Deployment {
  id: string;
  imageTag: string;
  status: string;
  logs: string | null;
  triggeredBy: string;
  startedAt: string;
  completedAt: string | null;
  serviceId: string;
}

export interface Secret {
  id: string;
  key: string;
  description: string | null;
  neverReveal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SecretInput {
  key: string;
  value: string;
  description?: string;
  neverReveal?: boolean;
}

export interface DeployOptions {
  imageTag?: string;
  generateEnv?: boolean;
  pullImage?: boolean;
}

// Env Templates
export interface EnvTemplate {
  id: string;
  name: string;
  template: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvTemplateInput {
  name: string;
  template: string;
}

export const listEnvTemplates = () =>
  api.get<{ templates: EnvTemplate[] }>('/env-templates');

export const getEnvTemplate = (name: string) =>
  api.get<{ template: EnvTemplate }>(`/env-templates/${name}`);

export const createEnvTemplate = (data: EnvTemplateInput) =>
  api.post<{ template: EnvTemplate }>('/env-templates', data);

export const updateEnvTemplate = (name: string, template: string) =>
  api.put<{ template: EnvTemplate }>(`/env-templates/${name}`, { template });

export const deleteEnvTemplate = (name: string) =>
  api.delete<{ success: boolean }>(`/env-templates/${name}`);

export const generateEnvPreview = (envId: string, templateName: string) =>
  api.post<{ content: string }>(`/environments/${envId}/generate-env`, { templateName });

// Service updates
export const updateService = (id: string, data: Partial<ServiceUpdate>) =>
  api.patch<{ service: Service }>(`/services/${id}`, data);

export interface ServiceUpdate {
  name?: string;
  containerName?: string;
  imageName?: string;
  imageTag?: string;
  composePath?: string | null;
  envTemplateName?: string | null;
  healthCheckUrl?: string | null;
  autoUpdate?: boolean;
  registryConnectionId?: string | null;
}

// Audit Logs
export interface AuditLog {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceName: string | null;
  details: string | null;
  success: boolean;
  error: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string | null } | null;
  environment: { id: string; name: string } | null;
}

export interface AuditLogFilters {
  environmentId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

export const getAuditLogs = (filters: AuditLogFilters = {}) => {
  const params = new URLSearchParams();
  if (filters.environmentId) params.append('environmentId', filters.environmentId);
  if (filters.resourceType) params.append('resourceType', filters.resourceType);
  if (filters.resourceId) params.append('resourceId', filters.resourceId);
  if (filters.action) params.append('action', filters.action);
  if (filters.limit) params.append('limit', filters.limit.toString());
  if (filters.offset) params.append('offset', filters.offset.toString());
  const query = params.toString();
  return api.get<{ logs: AuditLog[]; total: number }>(`/audit-logs${query ? `?${query}` : ''}`);
};

// Config Files
export interface ConfigFile {
  id: string;
  name: string;
  filename: string;
  content: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  environmentId: string;
  _count?: { services: number };
}

export interface ConfigFileInput {
  name: string;
  filename: string;
  content: string;
  description?: string;
}

export interface ServiceFile {
  id: string;
  targetPath: string;
  configFileId: string;
  configFile: {
    id: string;
    name: string;
    filename: string;
    description: string | null;
  };
}

export interface ServiceFileInput {
  configFileId: string;
  targetPath: string;
}

export interface SyncResult {
  file: string;
  targetPath: string;
  success: boolean;
  error?: string;
}

export const listConfigFiles = (envId: string) =>
  api.get<{ configFiles: ConfigFile[] }>(`/environments/${envId}/config-files`);

export const getConfigFile = (id: string) =>
  api.get<{ configFile: ConfigFile & { services: Array<{ targetPath: string; service: { id: string; name: string; server: { id: string; name: string } } }> } }>(`/config-files/${id}`);

export const createConfigFile = (envId: string, data: ConfigFileInput) =>
  api.post<{ configFile: ConfigFile }>(`/environments/${envId}/config-files`, data);

export const updateConfigFile = (id: string, data: Partial<ConfigFileInput>) =>
  api.patch<{ configFile: ConfigFile }>(`/config-files/${id}`, data);

export const deleteConfigFile = (id: string) =>
  api.delete<{ success: boolean }>(`/config-files/${id}`);

export const listServiceFiles = (serviceId: string) =>
  api.get<{ files: ServiceFile[] }>(`/services/${serviceId}/files`);

export const attachServiceFile = (serviceId: string, data: ServiceFileInput) =>
  api.post<{ serviceFile: ServiceFile }>(`/services/${serviceId}/files`, data);

export const detachServiceFile = (serviceId: string, configFileId: string) =>
  api.delete<{ success: boolean }>(`/services/${serviceId}/files/${configFileId}`);

export const syncServiceFiles = (serviceId: string) =>
  api.post<{ results: SyncResult[]; success: boolean }>(`/services/${serviceId}/sync-files`);

// File History
export interface FileHistoryEntry {
  id: string;
  content: string;
  editedAt: string;
  editedBy: { id: string; email: string; name: string | null } | null;
}

export const getConfigFileHistory = (id: string) =>
  api.get<{ history: FileHistoryEntry[] }>(`/config-files/${id}/history`);

export const restoreConfigFile = (id: string, historyId: string) =>
  api.post<{ configFile: ConfigFile }>(`/config-files/${id}/restore/${historyId}`);

export const getEnvTemplateHistory = (name: string) =>
  api.get<{ history: FileHistoryEntry[] }>(`/env-templates/${name}/history`);

export const restoreEnvTemplate = (name: string, historyId: string) =>
  api.post<{ template: EnvTemplate }>(`/env-templates/${name}/restore/${historyId}`);

// Registry Connections
export interface RegistryConnection {
  id: string;
  name: string;
  type: 'digitalocean' | 'dockerhub' | 'generic';
  registryUrl: string;
  repositoryPrefix: string | null;
  hasToken: boolean;
  hasPassword: boolean;
  username: string | null;
  isDefault: boolean;
  refreshIntervalMinutes: number;
  autoLinkPattern: string | null;
  lastRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
  environmentId: string;
  _count?: { services: number };
}

export interface RegistryConnectionInput {
  name: string;
  type: 'digitalocean' | 'dockerhub' | 'generic';
  registryUrl: string;
  repositoryPrefix?: string;
  token?: string;
  username?: string;
  password?: string;
  isDefault?: boolean;
  refreshIntervalMinutes?: number;
  autoLinkPattern?: string;
}

export interface RegistryRepository {
  name: string;
  tagCount: number;
}

export interface RegistryTag {
  tag: string;
  digest: string;
  size: number;
  updatedAt: string;
}

export const listRegistryConnections = (envId: string) =>
  api.get<{ registries: RegistryConnection[] }>(`/environments/${envId}/registries`);

export const createRegistryConnection = (envId: string, data: RegistryConnectionInput) =>
  api.post<{ registry: RegistryConnection }>(`/environments/${envId}/registries`, data);

export const getRegistryConnection = (id: string) =>
  api.get<{ registry: RegistryConnection }>(`/registries/${id}`);

export const updateRegistryConnection = (id: string, data: Partial<RegistryConnectionInput>) =>
  api.patch<{ registry: RegistryConnection }>(`/registries/${id}`, data);

export const deleteRegistryConnection = (id: string) =>
  api.delete<{ success: boolean }>(`/registries/${id}`);

export const testRegistryConnection = (id: string) =>
  api.post<{ success: boolean; message?: string; error?: string }>(`/registries/${id}/test`);

export interface RegistryService {
  id: string;
  name: string;
  imageName: string;
  imageTag: string;
  server: { id: string; name: string };
}

export const getRegistryServices = (id: string) =>
  api.get<{ services: RegistryService[] }>(`/registries/${id}/services`);

export const listRegistryRepositories = (id: string) =>
  api.get<{ repositories: RegistryRepository[] }>(`/registries/${id}/repositories`);

export const listRegistryTags = (id: string, repo: string) =>
  api.get<{ tags: RegistryTag[] }>(`/registries/${id}/repositories/${encodeURIComponent(repo)}/tags`);

// Service update checks
export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentTag: string;
  latestTag?: string;
  latestDigest?: string;
  lastUpdateCheckAt?: string;
  error?: string;
}

export const checkServiceUpdates = (serviceId: string) =>
  api.post<UpdateCheckResult>(`/services/${serviceId}/check-updates`);

// Metrics
export type MetricsMode = 'ssh' | 'agent' | 'disabled';

export interface ServerMetrics {
  id: string;
  cpuPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  loadAvg1: number | null;
  loadAvg5: number | null;
  loadAvg15: number | null;
  uptime: number | null;
  source: string;
  collectedAt: string;
}

export interface ServiceMetrics {
  id: string;
  cpuPercent: number | null;
  memoryUsedMb: number | null;
  memoryLimitMb: number | null;
  networkRxMb: number | null;
  networkTxMb: number | null;
  blockReadMb: number | null;
  blockWriteMb: number | null;
  restartCount: number | null;
  collectedAt: string;
}

export interface MetricsSummaryServer {
  id: string;
  name: string;
  hostname: string;
  metricsMode: MetricsMode;
  latestMetrics: ServerMetrics | null;
  services: Array<{
    id: string;
    name: string;
    containerName: string;
    latestMetrics: ServiceMetrics | null;
  }>;
}

export const getServerMetrics = (id: string, from?: string, to?: string, limit?: number) => {
  const params = new URLSearchParams();
  if (from) params.append('from', from);
  if (to) params.append('to', to);
  if (limit) params.append('limit', limit.toString());
  const query = params.toString();
  return api.get<{ metrics: ServerMetrics[] }>(`/servers/${id}/metrics${query ? `?${query}` : ''}`);
};

export const getServiceMetrics = (id: string, from?: string, to?: string, limit?: number) => {
  const params = new URLSearchParams();
  if (from) params.append('from', from);
  if (to) params.append('to', to);
  if (limit) params.append('limit', limit.toString());
  const query = params.toString();
  return api.get<{ metrics: ServiceMetrics[] }>(`/services/${id}/metrics${query ? `?${query}` : ''}`);
};

export const getEnvironmentMetricsSummary = (envId: string) =>
  api.get<{ servers: MetricsSummaryServer[] }>(`/environments/${envId}/metrics/summary`);

export const collectServerMetrics = (id: string) =>
  api.post<{ serverMetrics: string; services: Array<{ service: string; success: boolean }> }>(
    `/servers/${id}/collect-metrics`
  );

export const updateServerMetricsMode = (id: string, metricsMode: MetricsMode) =>
  api.patch<{ server: { id: string; name: string; metricsMode: MetricsMode; agentToken?: string } }>(
    `/servers/${id}/metrics-mode`,
    { mode: metricsMode }
  );

export const regenerateAgentToken = (id: string) =>
  api.post<{ agentToken: string }>(`/servers/${id}/regenerate-agent-token`);

// Databases
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite';
export type BackupStorageType = 'local' | 'spaces';

export interface Database {
  id: string;
  name: string;
  type: DatabaseType;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  hasCredentials: boolean;
  filePath: string | null;
  serverId: string | null;
  backupStorageType: BackupStorageType;
  backupLocalPath: string | null;
  backupSpacesBucket: string | null;
  backupSpacesPrefix: string | null;
  createdAt: string;
  updatedAt: string;
  environmentId: string;
  _count?: { backups: number; services: number };
}

export interface DatabaseInput {
  name: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  databaseName?: string;
  username?: string;
  password?: string;
  filePath?: string;
  serverId?: string;
  backupStorageType?: BackupStorageType;
  backupLocalPath?: string;
  backupSpacesBucket?: string;
  backupSpacesPrefix?: string;
}

export interface DatabaseBackup {
  id: string;
  filename: string;
  size: number;
  type: 'manual' | 'scheduled';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error: string | null;
  storageType: BackupStorageType;
  storagePath: string;
  createdAt: string;
  completedAt: string | null;
  triggeredBy: { id: string; email: string; name: string | null } | null;
}

export interface BackupSchedule {
  id: string;
  cronExpression: string;
  retentionDays: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export const listDatabases = (envId: string) =>
  api.get<{ databases: Database[] }>(`/environments/${envId}/databases`);

export const createDatabase = (envId: string, data: DatabaseInput) =>
  api.post<{ database: Database }>(`/environments/${envId}/databases`, data);

export const getDatabase = (id: string) =>
  api.get<{ database: Database }>(`/databases/${id}`);

export const updateDatabase = (id: string, data: Partial<DatabaseInput>) =>
  api.patch<{ database: Database }>(`/databases/${id}`, data);

export const deleteDatabase = (id: string) =>
  api.delete<{ success: boolean }>(`/databases/${id}`);

export const createDatabaseBackup = (id: string) =>
  api.post<{ backupId: string; message: string }>(`/databases/${id}/backups`);

export const listDatabaseBackups = (id: string) =>
  api.get<{ backups: DatabaseBackup[] }>(`/databases/${id}/backups`);

export const getDatabaseBackup = (id: string) =>
  api.get<{ backup: DatabaseBackup }>(`/backups/${id}`);

export const deleteDatabaseBackup = (id: string) =>
  api.delete<{ success: boolean }>(`/backups/${id}`);

export const getBackupSchedule = (databaseId: string) =>
  api.get<{ schedule: BackupSchedule | null }>(`/databases/${databaseId}/schedule`);

export const setBackupSchedule = (
  databaseId: string,
  data: { cronExpression: string; retentionDays?: number; enabled?: boolean }
) => api.put<{ schedule: BackupSchedule }>(`/databases/${databaseId}/schedule`, data);

export const deleteBackupSchedule = (databaseId: string) =>
  api.delete<{ success: boolean }>(`/databases/${databaseId}/schedule`);
