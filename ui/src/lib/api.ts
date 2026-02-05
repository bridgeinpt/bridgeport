const API_BASE = '/api';

interface ApiError {
  error: string;
  details?: unknown;
}

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

class ApiClient {
  private token: string | null = null;
  // Request deduplication: tracks in-flight requests to prevent duplicate calls
  private pendingRequests = new Map<string, Promise<unknown>>();
  // Simple TTL cache for frequently accessed static data
  private cache = new Map<string, CacheEntry<unknown>>();

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

  // Clear cache (useful when data changes)
  clearCache(keyPattern?: string) {
    if (keyPattern) {
      for (const key of this.cache.keys()) {
        if (key.includes(keyPattern)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  // Deduplicated GET request - prevents duplicate in-flight requests
  private async dedupedGet<T>(path: string): Promise<T> {
    const key = `GET:${path}`;

    // If request is already in-flight, return the existing promise
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key) as Promise<T>;
    }

    // Create new request and track it
    const promise = this.request<T>('GET', path).finally(() => {
      this.pendingRequests.delete(key);
    });

    this.pendingRequests.set(key, promise);
    return promise;
  }

  // Cached GET request with TTL
  async getCached<T>(path: string, ttlMs: number = 60000): Promise<T> {
    const cacheKey = `GET:${path}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<T> | undefined;

    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }

    const data = await this.dedupedGet<T>(path);
    this.cache.set(cacheKey, { data, expiry: Date.now() + ttlMs });
    return data;
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
    return this.dedupedGet<T>(path);
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

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const headers: Record<string, string> = {};
    // Don't set Content-Type - browser will set it with boundary for multipart

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (response.status === 401) {
      this.setToken(null);
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error((data as ApiError).error || 'Upload failed');
    }

    return data as T;
  }
}

export const api = new ApiClient();

// Health check (public endpoint, no auth needed)
export const getHealth = () =>
  fetch('/health').then(res => res.json() as Promise<{ status: string; timestamp: string; version: string; bundledAgentVersion: string; cliVersion: string }>);

// CLI Downloads
export interface CliDownload {
  os: string;
  arch: string;
  label: string;
  filename: string;
  available: boolean;
  size: number;
}

export const getCliDownloads = () =>
  api.get<{ version: string; downloads: CliDownload[] }>('/downloads/cli');

export const getCliDownloadUrl = (os: string, arch: string) =>
  `/api/downloads/cli/${os}/${arch}`;

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

export const getActiveUsers = () =>
  api.get<{ activeUsers: User[] }>('/users/active');

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
  allowBackupDownload: boolean;
}

export const getEnvironmentSettings = (id: string) =>
  api.get<{ settings: EnvironmentSettings }>(`/environments/${id}/settings`);

export const updateEnvironmentSettings = (id: string, settings: Partial<EnvironmentSettings>) =>
  api.patch<{ settings: EnvironmentSettings }>(`/environments/${id}/settings`, settings);

// Spaces buckets (uses global Spaces config)
export const listSpacesBuckets = (id: string) =>
  api.get<{ buckets: string[] }>(`/environments/${id}/spaces/buckets`);

// SSH Configuration
export interface SshStatus {
  configured: boolean;
  sshUser: string;
}

export interface SshSettingsInput {
  sshPrivateKey: string;
  sshUser?: string;
}

export const getSshStatus = (envId: string) =>
  api.get<SshStatus>(`/environments/${envId}/ssh`);

export const updateSshSettings = (envId: string, data: SshSettingsInput) =>
  api.put<{ success: boolean; message: string }>(`/environments/${envId}/ssh`, data);

export const deleteSshKey = (envId: string) =>
  api.delete<{ success: boolean; message: string }>(`/environments/${envId}/ssh`);

// Host Detection (for managing Docker host from container)
export interface HostInfo {
  detected: boolean;
  gatewayIp: string | null;
  sshReachable: boolean;
  sshError?: string;
  registered: boolean;
  registeredGlobally: boolean; // true if host is registered in ANY environment
  registeredEnvironment?: string; // name of environment where host is registered
  serverId?: string;
  serverName?: string;
}

export const getHostInfo = (envId: string) =>
  api.get<HostInfo>(`/environments/${envId}/host-info`);

export interface RegisterHostInput {
  name?: string;
}

export const registerHost = (envId: string, data: RegisterHostInput = {}) =>
  api.post<{ server: Server; success: boolean }>(`/environments/${envId}/servers/register-host`, data);

// Servers
export const listServers = (envId: string) =>
  api.get<{ servers: Server[] }>(`/environments/${envId}/servers`);

export interface CreateServerInput {
  name: string;
  hostname: string;
  publicIp?: string;
  tags?: string[];
}

export const createServer = (envId: string, data: CreateServerInput) =>
  api.post<{ server: Server }>(`/environments/${envId}/servers`, data);

export const getServer = (id: string) =>
  api.get<{ server: ServerWithServices }>(`/servers/${id}`);

export interface UpdateServerInput {
  name?: string;
  hostname?: string;
  publicIp?: string | null;
  tags?: string[];
}

export const updateServer = (id: string, data: UpdateServerInput) =>
  api.patch<{ server: Server }>(`/servers/${id}`, data);

export const deleteServer = (id: string) =>
  api.delete<{ success: boolean }>(`/servers/${id}`);

export const checkServerHealth = (id: string) =>
  api.post<{ status: string; error?: string }>(`/servers/${id}/health`);

export const discoverContainers = (id: string) =>
  api.post<{ services: Service[] }>(`/servers/${id}/discover`);

export interface CreateServiceInput {
  name: string;
  containerName: string;
  containerImageId: string;  // Required - links to ContainerImage
  imageTag?: string;
  composePath?: string;
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
  api.get<{
    metricsMode: string;
    hasToken: boolean;
    agentStatus: AgentStatus;
    agentVersion: string | null;
    lastAgentPushAt: string | null;
    bundledAgentVersion: string;
    installed: boolean;
    running: boolean;
    error?: string;
  }>(`/servers/${id}/agent/status`);

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
    containerStatus: string;
    healthStatus: string;
    container: { state: string; status: string; health?: string; running: boolean };
    url: { success: boolean; statusCode?: number; error?: string } | null;
    exposedPorts: ExposedPort[];
    imageTag: string;
    lastCheckedAt: string;
  }>(`/services/${id}/health`);

export interface ServiceHistoryEntry {
  id: string;
  action: string;
  details: string | null;
  success: boolean;
  error: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string | null } | null;
}

export interface ServiceDeploymentSummary {
  id: string;
  imageTag: string;
  status: string;
  triggeredBy: string;
  startedAt: string;
  completedAt: string | null;
}

export const getServiceHistory = (id: string, limit?: number) =>
  api.get<{ logs: ServiceHistoryEntry[]; deployments: ServiceDeploymentSummary[] }>(
    `/services/${id}/history${limit ? `?limit=${limit}` : ''}`
  );

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
  lastActiveAt?: string | null;
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
  serverType: 'remote' | 'host';
  lastCheckedAt: string | null;
  environmentId: string;
}

export interface ServerWithServices extends Server {
  services: Service[];
}

export interface ExposedPort {
  host: number | null;
  container: number;
  protocol: 'tcp' | 'udp';
}

// Agent health check types
export interface TCPCheckConfig {
  host: string;
  port: number;
  name?: string;
}

export interface TCPCheckResult {
  host: string;
  port: number;
  name?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface CertCheckConfig {
  host: string;
  port: number;
  name?: string;
}

export interface CertCheckResult {
  host: string;
  port: number;
  name?: string;
  success: boolean;
  durationMs: number;
  expiresAt?: string;
  daysUntilExpiry?: number;
  issuer?: string;
  subject?: string;
  error?: string;
}

export interface Service {
  id: string;
  name: string;
  containerName: string;
  imageTag: string;
  composePath: string | null;
  healthCheckUrl: string | null;
  status: string;
  containerStatus: string; // running, stopped, exited, created, restarting, paused, dead, not_found
  healthStatus: string; // healthy, unhealthy, unknown, none
  exposedPorts: string | null; // JSON array of ExposedPort
  discoveryStatus: string; // 'found' | 'missing'
  lastCheckedAt: string | null;
  lastDiscoveredAt: string | null;
  serverId: string;
  // Auto-update fields
  autoUpdate: boolean;
  latestAvailableTag: string | null;
  latestAvailableDigest: string | null;
  lastUpdateCheckAt: string | null;
  // Container image (central entity for image management)
  containerImageId: string;
  containerImage?: ContainerImage | null;
  // Orchestration fields
  healthWaitMs: number;
  healthRetries: number;
  healthIntervalMs: number;
  // Service type for predefined commands
  serviceTypeId: string | null;
  serviceType?: {
    id: string;
    name: string;
    displayName: string;
    commands: Array<{
      id: string;
      name: string;
      displayName: string;
      command: string;
      description: string | null;
    }>;
  } | null;
  // Agent-performed health checks
  tcpChecks: string | null; // JSON array of TCPCheckConfig
  agentTcpCheckResults: string | null; // JSON array of TCPCheckResult
  agentTcpCheckedAt: string | null;
  certChecks: string | null; // JSON array of CertCheckConfig
  agentCertCheckResults: string | null; // JSON array of CertCheckResult
  agentCertCheckedAt: string | null;
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

export interface SecretUsageService {
  id: string;
  name: string;
  serverName: string;
}

export interface SecretUsageConfigFile {
  id: string;
  name: string;
  filename: string;
  services: SecretUsageService[];
}

export interface Secret {
  id: string;
  key: string;
  description: string | null;
  neverReveal: boolean;
  createdAt: string;
  updatedAt: string;
  // Usage information
  usedByConfigFiles?: SecretUsageConfigFile[];
  usedByServices?: SecretUsageService[];
  usageCount?: number;
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

// Service updates
export const updateService = (id: string, data: Partial<ServiceUpdate>) =>
  api.patch<{ service: Service }>(`/services/${id}`, data);

export interface ServiceUpdate {
  name?: string;
  containerName?: string;
  imageTag?: string;
  composePath?: string | null;
  healthCheckUrl?: string | null;
  autoUpdate?: boolean;
  containerImageId?: string;
  serviceTypeId?: string | null;
  tcpChecks?: string | null;
  certChecks?: string | null;
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
export interface ConfigFileServiceAttachment {
  id: string;
  targetPath: string;
  lastSyncedAt: string | null;
  syncStatus?: 'synced' | 'pending' | 'never';
  service: {
    id: string;
    name: string;
    server: { id: string; name: string };
  };
}

export interface ConfigFileSyncCounts {
  synced: number;
  pending: number;
  never: number;
  total: number;
}

export interface ConfigFile {
  id: string;
  name: string;
  filename: string;
  content: string;
  description: string | null;
  isBinary: boolean;
  mimeType: string | null;
  fileSize: number | null;
  createdAt: string;
  updatedAt: string;
  environmentId: string;
  _count?: { services: number };
  services?: ConfigFileServiceAttachment[];
  syncStatus?: 'synced' | 'pending' | 'never' | 'not_attached';
  syncCounts?: ConfigFileSyncCounts;
}

export interface ConfigFileInput {
  name: string;
  filename: string;
  content: string;
  description?: string;
  isBinary?: boolean;
  mimeType?: string;
  fileSize?: number;
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
    isBinary?: boolean;
    mimeType?: string | null;
    fileSize?: number | null;
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

export const updateServiceFile = (serviceId: string, configFileId: string, targetPath: string) =>
  api.patch<{ serviceFile: ServiceFile }>(`/services/${serviceId}/files/${configFileId}`, { targetPath });

export const syncServiceFiles = (serviceId: string) =>
  api.post<{ results: SyncResult[]; success: boolean }>(`/services/${serviceId}/sync-files`);

export interface ConfigFileSyncResult {
  serviceId: string;
  serviceName: string;
  serverName: string;
  targetPath: string;
  success: boolean;
  error?: string;
}

export const syncConfigFileToAll = (configFileId: string) =>
  api.post<{ results: ConfigFileSyncResult[]; success: boolean }>(`/config-files/${configFileId}/sync-all`);

// Server Config Files Sync Status
export interface ServerConfigFileAttachment {
  serviceFileId: string;
  serviceId: string;
  serviceName: string;
  targetPath: string;
  lastSyncedAt: string | null;
  syncStatus: 'synced' | 'pending' | 'never';
}

export interface ServerConfigFileStatus {
  id: string;
  name: string;
  filename: string;
  updatedAt: string;
  overallSyncStatus: 'synced' | 'pending' | 'never';
  attachments: ServerConfigFileAttachment[];
}

export interface ServerConfigFilesSyncTotals {
  synced: number;
  pending: number;
  never: number;
  total: number;
}

export const getServerConfigFilesStatus = (serverId: string) =>
  api.get<{ configFiles: ServerConfigFileStatus[]; totals: ServerConfigFilesSyncTotals }>(`/servers/${serverId}/config-files-status`);

export interface ServerSyncAllResult {
  configFileName: string;
  serviceName: string;
  targetPath: string;
  success: boolean;
  error?: string;
}

export const syncAllServerFiles = (serverId: string) =>
  api.post<{ results: ServerSyncAllResult[]; success: boolean }>(`/servers/${serverId}/sync-all-files`);

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

export const uploadAssetFile = (
  envId: string,
  file: File,
  name: string,
  filename?: string,
  description?: string
) => {
  const formData = new FormData();
  // Fields must come BEFORE file for @fastify/multipart request.file() to see them
  formData.append('name', name);
  if (filename) formData.append('filename', filename);
  if (description) formData.append('description', description);
  formData.append('file', file);
  return api.upload<{ configFile: ConfigFile }>(
    `/environments/${envId}/asset-files/upload`,
    formData
  );
};

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
  imageTag: string;
  autoUpdate: boolean;
  latestAvailableTag: string | null;
  latestAvailableDigest: string | null;
  lastUpdateCheckAt: string | null;
  server: { id: string; name: string };
  containerImage?: { id: string; name: string; imageName: string } | null;
}

export const getRegistryServices = (id: string) =>
  api.get<{ services: RegistryService[] }>(`/registries/${id}/services`);

export interface CheckUpdatesResult {
  results: Array<{
    serviceId: string;
    name: string;
    hasUpdate: boolean;
    latestTag?: string;
    error?: string;
  }>;
  summary: {
    checked: number;
    withUpdates: number;
    errors: number;
  };
}

export const checkRegistryUpdates = (id: string) =>
  api.post<CheckUpdatesResult>(`/registries/${id}/check-updates`);

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
  swapUsedMb: number | null;
  swapTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  loadAvg1: number | null;
  loadAvg5: number | null;
  loadAvg15: number | null;
  uptime: number | null;
  openFds: number | null;
  maxFds: number | null;
  tcpEstablished: number | null;
  tcpListen: number | null;
  tcpTimeWait: number | null;
  tcpCloseWait: number | null;
  tcpTotal: number | null;
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
  tags: string;
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

// Process snapshot types
export interface ProcessInfo {
  pid: number;
  name: string;
  state: string;
  cpuPercent: number;
  memoryMb: number;
  threads: number;
}

export interface ProcessStats {
  total: number;
  running: number;
  sleeping: number;
  stopped: number;
  zombie: number;
}

export interface ProcessSnapshot {
  byCpu: ProcessInfo[];
  byMemory: ProcessInfo[];
  stats: ProcessStats;
}

export interface ServerProcessesResponse {
  hasData: boolean;
  processes: ProcessSnapshot | null;
  updatedAt: string | null;
}

export const getServerProcesses = (id: string) =>
  api.get<ServerProcessesResponse>(`/servers/${id}/processes`);

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
export type BackupFormat = 'plain' | 'custom' | 'tar';
export type BackupCompression = 'none' | 'gzip';

export interface PgDumpOptions {
  noOwner?: boolean;
  clean?: boolean;
  ifExists?: boolean;
  schemaOnly?: boolean;
  dataOnly?: boolean;
}

export interface LastBackupInfo {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  type: 'manual' | 'scheduled';
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface ScheduleInfo {
  enabled: boolean;
  cronExpression: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

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
  backupFormat: BackupFormat;
  backupCompression: BackupCompression;
  backupCompressionLevel: number;
  pgDumpOptions: PgDumpOptions | null;
  pgDumpTimeoutMs: number;
  createdAt: string;
  updatedAt: string;
  environmentId: string;
  _count?: { backups: number; services: number };
  lastBackup?: LastBackupInfo | null;
  schedule?: ScheduleInfo | null;
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
  backupFormat?: BackupFormat;
  backupCompression?: BackupCompression;
  backupCompressionLevel?: number;
  pgDumpOptions?: PgDumpOptions;
  pgDumpTimeoutMs?: number;
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
  progress: number;
  duration: number | null;
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

export const listDatabaseBackups = (id: string, limit?: number, offset?: number) => {
  const params = new URLSearchParams();
  if (limit) params.append('limit', limit.toString());
  if (offset) params.append('offset', offset.toString());
  const query = params.toString();
  return api.get<{ backups: DatabaseBackup[]; total: number; allowDownload: boolean }>(
    `/databases/${id}/backups${query ? `?${query}` : ''}`
  );
};

export const getDatabaseBackup = (id: string) =>
  api.get<{ backup: DatabaseBackup; allowDownload: boolean }>(`/backups/${id}`);

export const deleteDatabaseBackup = (id: string) =>
  api.delete<{ success: boolean }>(`/backups/${id}`);

export const getBackupDownloadUrl = (id: string) =>
  api.get<{ downloadUrl: string }>(`/backups/${id}/download`);

export const getBackupSchedule = (databaseId: string) =>
  api.get<{ schedule: BackupSchedule | null }>(`/databases/${databaseId}/schedule`);

export const setBackupSchedule = (
  databaseId: string,
  data: { cronExpression: string; retentionDays?: number; enabled?: boolean }
) => api.put<{ schedule: BackupSchedule }>(`/databases/${databaseId}/schedule`, data);

export const deleteBackupSchedule = (databaseId: string) =>
  api.delete<{ success: boolean }>(`/databases/${databaseId}/schedule`);

// Notifications
export interface NotificationType {
  id: string;
  category: 'user' | 'system';
  code: string;
  name: string;
  description: string | null;
  template: string;
  defaultChannels: string;
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
  bounceEnabled: boolean;
  bounceThreshold: number;
  bounceCooldown: number;
  createdAt: string;
}

export interface NotificationWithType {
  id: string;
  typeId: string;
  userId: string;
  title: string;
  message: string;
  data: string | null;
  environmentId: string | null;
  inAppReadAt: string | null;
  emailSentAt: string | null;
  webhookSentAt: string | null;
  createdAt: string;
  type: NotificationType;
}

export interface NotificationPreference {
  id: string;
  userId: string;
  typeId: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  webhookEnabled: boolean;
  environmentIds: string | null;
  createdAt: string;
  updatedAt: string;
  type: NotificationType;
}

export interface ListNotificationsOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  environmentId?: string;
  category?: 'user' | 'system';
}

export const listNotifications = (options: ListNotificationsOptions = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.append('limit', options.limit.toString());
  if (options.offset) params.append('offset', options.offset.toString());
  if (options.unreadOnly) params.append('unreadOnly', 'true');
  if (options.environmentId) params.append('environmentId', options.environmentId);
  if (options.category) params.append('category', options.category);
  const query = params.toString();
  return api.get<{ notifications: NotificationWithType[]; total: number }>(
    `/notifications${query ? `?${query}` : ''}`
  );
};

export const getNotificationsUnreadCount = () =>
  api.get<{ count: number }>('/notifications/unread-count');

export const markNotificationAsRead = (id: string) =>
  api.post<{ notification: NotificationWithType }>(`/notifications/${id}/read`);

export const markAllNotificationsAsRead = () =>
  api.post<{ count: number }>('/notifications/read-all');

export const getNotificationPreferences = () =>
  api.get<{ preferences: NotificationPreference[] }>('/notifications/preferences');

export const updateNotificationPreference = (
  typeId: string,
  data: {
    inAppEnabled?: boolean;
    emailEnabled?: boolean;
    webhookEnabled?: boolean;
    environmentIds?: string[] | null;
  }
) => api.put<{ preference: NotificationPreference }>(`/notifications/preferences/${typeId}`, data);

// Admin notification routes
export const getAdminNotificationTypes = () =>
  api.get<{ types: NotificationType[] }>('/admin/notification-types');

export const updateAdminNotificationType = (
  id: string,
  data: {
    defaultChannels?: string[];
    enabled?: boolean;
    bounceEnabled?: boolean;
    bounceThreshold?: number;
    bounceCooldown?: number;
  }
) => api.put<{ type: NotificationType }>(`/admin/notification-types/${id}`, data);

// SMTP Configuration
export interface SmtpConfig {
  id: string;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SmtpConfigInput {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  fromAddress: string;
  fromName?: string;
  enabled?: boolean;
}

export const getSmtpConfig = () =>
  api.get<{ config: SmtpConfig | null }>('/admin/smtp');

export const saveSmtpConfig = (data: SmtpConfigInput) =>
  api.put<{ config: SmtpConfig }>('/admin/smtp', data);

export const testSmtpConnection = (to?: string) =>
  api.post<{ success: boolean; message: string }>('/admin/smtp/test', to ? { to } : {});

// Outgoing Webhooks
export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  hasSecret: boolean;
  headers: string | null;
  enabled: boolean;
  typeFilter: string | null;
  environmentIds: string | null;
  lastTriggeredAt: string | null;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookConfigInput {
  name: string;
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  typeFilter?: string[];
  environmentIds?: string[];
}

export const listWebhooks = () =>
  api.get<{ webhooks: WebhookConfig[] }>('/admin/webhooks');

export const getWebhook = (id: string) =>
  api.get<{ webhook: WebhookConfig }>(`/admin/webhooks/${id}`);

export const createWebhook = (data: WebhookConfigInput) =>
  api.post<{ webhook: WebhookConfig }>('/admin/webhooks', data);

export const updateWebhook = (id: string, data: Partial<WebhookConfigInput>) =>
  api.put<{ webhook: WebhookConfig }>(`/admin/webhooks/${id}`, data);

export const deleteWebhook = (id: string) =>
  api.delete<{ success: boolean }>(`/admin/webhooks/${id}`);

export const testWebhook = (id: string) =>
  api.post<{ success: boolean; message: string }>(`/admin/webhooks/${id}/test`);

// ==================== Deployment Orchestration ====================

// Container Images (central entity for image management)
export interface ContainerImage {
  id: string;
  name: string;
  imageName: string;
  currentTag: string;
  latestTag: string | null;
  latestDigest: string | null;
  lastCheckedAt: string | null;
  autoUpdate: boolean;
  createdAt: string;
  updatedAt: string;
  environmentId: string;
  registryConnectionId: string | null;
  registryConnection?: RegistryConnection | null;
  services: Service[];
}

export interface ContainerImageInput {
  name: string;
  imageName: string;
  currentTag: string;
  registryConnectionId?: string | null;
}

export interface ContainerImageHistory {
  id: string;
  tag: string;
  digest: string | null;
  status: string;  // 'success' | 'failed' | 'rolled_back'
  deployedAt: string;
  deployedBy: string | null;
  containerImageId: string;
  deployments?: Deployment[];
  // Enhanced fields from new API
  services?: Array<{ id: string; name: string; serverName: string }>;
  totalDurationMs?: number;
  deploymentCount?: number;
}

export const listContainerImages = (envId: string) =>
  api.get<{ images: ContainerImage[] }>(`/environments/${envId}/container-images`);

export const createContainerImage = (envId: string, data: ContainerImageInput) =>
  api.post<{ image: ContainerImage }>(`/environments/${envId}/container-images`, data);

export const getContainerImage = (id: string) =>
  api.get<{ image: ContainerImage }>(`/container-images/${id}`);

export const updateContainerImage = (id: string, data: Partial<ContainerImageInput>) =>
  api.patch<{ image: ContainerImage }>(`/container-images/${id}`, data);

export const deleteContainerImage = (id: string) =>
  api.delete<{ success: boolean }>(`/container-images/${id}`);

export const deployContainerImage = (id: string, imageTag: string, autoRollback = true) =>
  api.post<{ plan: DeploymentPlan }>(`/container-images/${id}/deploy`, { imageTag, autoRollback });

export const getContainerImageHistory = (id: string, limit?: number) =>
  api.get<{ history: ContainerImageHistory[] }>(`/container-images/${id}/history${limit ? `?limit=${limit}` : ''}`);

export const linkServiceToContainerImage = (imageId: string, serviceId: string) =>
  api.post<{ service: Service }>(`/container-images/${imageId}/link/${serviceId}`);

export const getLinkableServices = (imageId: string) =>
  api.get<{ services: Service[] }>(`/container-images/${imageId}/linkable-services`);

// Service Dependencies
export type DependencyType = 'health_before' | 'deploy_after';

export interface ServiceDependency {
  id: string;
  type: DependencyType;
  dependentId: string;
  dependsOnId: string;
  dependsOn: Service & { server?: { name: string } };
}

export interface ServiceDependent {
  id: string;
  type: DependencyType;
  dependentId: string;
  dependsOnId: string;
  dependent: Service & { server?: { name: string } };
}

export const getServiceDependencies = (serviceId: string) =>
  api.get<{ dependencies: ServiceDependency[]; dependents: ServiceDependent[] }>(
    `/services/${serviceId}/dependencies`
  );

export const addServiceDependency = (serviceId: string, dependsOnId: string, type: DependencyType) =>
  api.post<{ dependency: ServiceDependency }>(`/services/${serviceId}/dependencies`, {
    dependsOnId,
    type,
  });

export const removeServiceDependency = (dependencyId: string) =>
  api.delete<{ success: boolean }>(`/dependencies/${dependencyId}`);

export const getAvailableDependencies = (serviceId: string) =>
  api.get<{ services: (Service & { server: { name: string } })[] }>(
    `/services/${serviceId}/available-dependencies`
  );

export interface DependencyGraphNode {
  id: string;
  name: string;
  server: string;
  containerImage: { id: string; name: string } | null;
  status: string;
  healthStatus: string;
  dependencyCount: number;
  dependentCount: number;
}

export interface DependencyGraphEdge {
  id: string;
  from: string;
  to: string;
  type: DependencyType;
}

export const getDependencyGraph = (envId: string) =>
  api.get<{ nodes: DependencyGraphNode[]; edges: DependencyGraphEdge[]; deploymentOrder: string[][] }>(
    `/environments/${envId}/dependency-graph`
  );

// Deployment Plans
export type DeploymentPlanStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rolled_back';
export type DeploymentStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'rolled_back';
export type DeploymentStepAction = 'deploy' | 'health_check' | 'rollback';

export interface DeploymentPlanStep {
  id: string;
  order: number;
  status: DeploymentStepStatus;
  action: DeploymentStepAction;
  targetTag: string | null;
  previousTag: string | null;
  healthPassed: boolean | null;
  healthDetails: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  logs: string | null;
  deploymentPlanId: string;
  serviceId: string | null;
  deploymentId: string | null;
  service?: (Service & { server?: { name: string } }) | null;
  deployment?: Deployment | null;
}

export interface DeploymentPlan {
  id: string;
  name: string;
  status: DeploymentPlanStatus;
  imageTag: string | null;
  triggerType: 'manual' | 'webhook' | 'auto_update';
  triggeredBy: string | null;
  autoRollback: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  logs: string | null;
  createdAt: string;
  environmentId: string;
  containerImageId: string | null;
  userId: string | null;
  steps: DeploymentPlanStep[];
  containerImage?: { id: string; name: string } | null;
  user?: { id: string; email: string; name: string | null } | null;
  environment?: { id: string; name: string } | null;
}

export interface CreateDeploymentPlanInput {
  serviceIds: string[];
  imageTag: string;
  autoRollback?: boolean;
}

export const listDeploymentPlans = (envId: string, limit?: number) =>
  api.get<{ plans: DeploymentPlan[] }>(`/environments/${envId}/deployment-plans${limit ? `?limit=${limit}` : ''}`);

export const createDeploymentPlan = (envId: string, data: CreateDeploymentPlanInput, execute = false) =>
  api.post<{ plan: DeploymentPlan }>(`/environments/${envId}/deployment-plans?execute=${execute}`, data);

export const getDeploymentPlan = (id: string) =>
  api.get<{ plan: DeploymentPlan }>(`/deployment-plans/${id}`);

export const executeDeploymentPlan = (id: string) =>
  api.post<{ success: boolean; message: string }>(`/deployment-plans/${id}/execute`);

export const cancelDeploymentPlan = (id: string) =>
  api.post<{ success: boolean }>(`/deployment-plans/${id}/cancel`);

export const rollbackDeploymentPlan = (id: string) =>
  api.post<{ success: boolean; message: string }>(`/deployment-plans/${id}/rollback`);

// Service health configuration (for update)
export interface ServiceHealthConfig {
  healthWaitMs?: number;
  healthRetries?: number;
  healthIntervalMs?: number;
}

export const updateServiceHealthConfig = (serviceId: string, config: ServiceHealthConfig) =>
  api.patch<{ service: Service }>(`/services/${serviceId}`, config);

// ==================== Global Settings ====================

// Service Types
export interface ServiceTypeCommand {
  id: string;
  name: string;
  displayName: string;
  command: string;
  description: string | null;
  sortOrder: number;
  serviceTypeId: string;
}

export interface ServiceType {
  id: string;
  name: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  commands: ServiceTypeCommand[];
  _count?: { services: number };
}

export interface ServiceTypeInput {
  name: string;
  displayName: string;
}

export interface ServiceTypeCommandInput {
  name: string;
  displayName: string;
  command: string;
  description?: string;
  sortOrder?: number;
}

// Cached for 5 minutes - service types rarely change
export const listServiceTypes = () =>
  api.getCached<{ serviceTypes: ServiceType[] }>('/settings/service-types', 300000);

export const getServiceType = (id: string) =>
  api.get<{ serviceType: ServiceType }>(`/settings/service-types/${id}`);

export const createServiceType = (data: ServiceTypeInput) =>
  api.post<{ serviceType: ServiceType }>('/settings/service-types', data);

export const updateServiceType = (id: string, data: Partial<ServiceTypeInput>) =>
  api.patch<{ serviceType: ServiceType }>(`/settings/service-types/${id}`, data);

export const deleteServiceType = (id: string) =>
  api.delete<{ success: boolean }>(`/settings/service-types/${id}`);

export const addServiceTypeCommand = (typeId: string, data: ServiceTypeCommandInput) =>
  api.post<{ command: ServiceTypeCommand }>(`/settings/service-types/${typeId}/commands`, data);

export const updateServiceTypeCommand = (typeId: string, commandId: string, data: Partial<ServiceTypeCommandInput>) =>
  api.patch<{ command: ServiceTypeCommand }>(`/settings/service-types/${typeId}/commands/${commandId}`, data);

export const deleteServiceTypeCommand = (typeId: string, commandId: string) =>
  api.delete<{ success: boolean }>(`/settings/service-types/${typeId}/commands/${commandId}`);

export const reorderServiceTypeCommands = (typeId: string, commandIds: string[]) =>
  api.put<{ commands: ServiceTypeCommand[] }>(`/settings/service-types/${typeId}/commands/reorder`, commandIds);

// Global Spaces Configuration
export interface GlobalSpacesConfig {
  id: string;
  accessKey: string;
  region: string;
  endpoint: string;
  buckets?: string[];
  createdAt: string;
  updatedAt: string;
  enabledEnvironments: { id: string; environmentId: string; enabled: boolean }[];
}

export interface GlobalSpacesConfigInput {
  accessKey: string;
  secretKey?: string; // Optional for updates - will keep existing if not provided
  region: string;
  endpoint?: string;
  buckets?: string[];
}

export interface SpacesEnvironmentStatus {
  id: string;
  name: string;
  spacesEnabled: boolean;
}

export const getGlobalSpacesConfig = () =>
  api.get<{ configured: boolean; config: GlobalSpacesConfig | null }>('/settings/spaces');

export const updateGlobalSpacesConfig = (data: GlobalSpacesConfigInput) =>
  api.put<{ config: GlobalSpacesConfig }>('/settings/spaces', data);

export const deleteGlobalSpacesConfig = () =>
  api.delete<{ success: boolean }>('/settings/spaces');

export const testGlobalSpacesConfig = () =>
  api.post<{
    success: boolean;
    message: string;
    buckets?: string[];
    failedBuckets?: string[];
    scopedKey?: boolean;
  }>('/settings/spaces/test');

export const listGlobalSpacesBuckets = () =>
  api.get<{ buckets: string[] }>('/settings/spaces/buckets');

export const getSpacesEnvironments = () =>
  api.get<{ environments: SpacesEnvironmentStatus[] }>('/settings/spaces/environments');

export const setSpacesEnvironmentEnabled = (environmentId: string, enabled: boolean) =>
  api.put<{ success: boolean; enabled: boolean }>(`/settings/spaces/environments/${environmentId}`, { enabled });

// System Settings
export interface SystemSettings {
  id: string;
  sshCommandTimeoutMs: number;
  sshReadyTimeoutMs: number;
  webhookMaxRetries: number;
  webhookTimeoutMs: number;
  webhookRetryDelaysMs: string;
  pgDumpTimeoutMs: number;
  maxUploadSizeMb: number;
  activeUserWindowMin: number;
  registryMaxTags: number;
  defaultLogLines: number;
  publicUrl: string | null;
  agentCallbackUrl: string | null;
  agentStaleThresholdMs: number;
  agentOfflineThresholdMs: number;
  doRegistryToken: string | null; // Masked value (last 4 chars) or null
  doRegistryTokenSet: boolean;
  auditLogRetentionDays: number;
  updatedAt: string;
}

export interface SystemSettingsDefaults {
  sshCommandTimeoutMs: number;
  sshReadyTimeoutMs: number;
  webhookMaxRetries: number;
  webhookTimeoutMs: number;
  webhookRetryDelaysMs: string;
  pgDumpTimeoutMs: number;
  maxUploadSizeMb: number;
  activeUserWindowMin: number;
  registryMaxTags: number;
  defaultLogLines: number;
  agentStaleThresholdMs: number;
  agentOfflineThresholdMs: number;
  auditLogRetentionDays: number;
}

export interface SystemSettingsInput {
  sshCommandTimeoutMs?: number;
  sshReadyTimeoutMs?: number;
  webhookMaxRetries?: number;
  webhookTimeoutMs?: number;
  webhookRetryDelaysMs?: string;
  pgDumpTimeoutMs?: number;
  maxUploadSizeMb?: number;
  activeUserWindowMin?: number;
  registryMaxTags?: number;
  defaultLogLines?: number;
  publicUrl?: string | null;
  agentCallbackUrl?: string | null;
  agentStaleThresholdMs?: number;
  agentOfflineThresholdMs?: number;
  doRegistryToken?: string | null;
  auditLogRetentionDays?: number;
}

// Cached for 5 minutes - system settings rarely change
export const getSystemSettings = () =>
  api.getCached<{ settings: SystemSettings; defaults: SystemSettingsDefaults }>('/settings/system', 300000);

export const updateSystemSettings = (data: SystemSettingsInput) =>
  api.put<{ settings: SystemSettings }>('/settings/system', data);

export const resetSystemSettings = () =>
  api.post<{ settings: SystemSettings; message: string }>('/settings/system/reset');

// Run predefined command (for CLI integration)
export const getRunCommand = (serviceId: string, commandName: string) =>
  api.post<{ command: string }>(`/services/${serviceId}/run-command`, { commandName });

// ==================== Monitoring ====================

// Health Check Logs
export interface HealthCheckLog {
  id: string;
  environmentId: string;
  resourceType: 'server' | 'service' | 'container';
  resourceId: string;
  resourceName: string;
  checkType: 'ssh' | 'url' | 'container_health' | 'discovery';
  status: 'success' | 'failure' | 'timeout';
  durationMs: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface HealthLogSummary {
  success: number;
  failure: number;
  timeout: number;
}

export interface HealthLogsResponse {
  logs: HealthCheckLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  summary: {
    server: HealthLogSummary;
    service: HealthLogSummary;
    container: HealthLogSummary;
  };
}

export interface HealthLogFilters {
  type?: 'server' | 'service' | 'container';
  checkType?: 'ssh' | 'url' | 'container_health' | 'discovery';
  status?: 'success' | 'failure' | 'timeout';
  resourceId?: string;
  hours?: number;
  page?: number;
  limit?: number;
}

export const getHealthLogs = (envId: string, filters: HealthLogFilters = {}) => {
  const params = new URLSearchParams();
  if (filters.type) params.append('type', filters.type);
  if (filters.checkType) params.append('checkType', filters.checkType);
  if (filters.status) params.append('status', filters.status);
  if (filters.resourceId) params.append('resourceId', filters.resourceId);
  if (filters.hours) params.append('hours', filters.hours.toString());
  if (filters.page) params.append('page', filters.page.toString());
  if (filters.limit) params.append('limit', filters.limit.toString());
  const query = params.toString();
  return api.get<HealthLogsResponse>(`/environments/${envId}/health-logs${query ? `?${query}` : ''}`);
};

export interface HealthCheckRunResult {
  servers: Array<{ id: string; name: string; status: string; durationMs: number; error?: string }>;
  services: Array<{ id: string; name: string; status: string; durationMs: number; error?: string }>;
}

export const runHealthChecks = (envId: string, type?: 'all' | 'servers' | 'services') =>
  api.post<{ results: HealthCheckRunResult }>(`/environments/${envId}/health-checks/run`, { type });

// Metrics History
export interface MetricsHistoryDataPoint {
  time: string;
  cpu?: number | null;
  memory?: number | null;
  memoryUsedMb?: number | null;
  swap?: number | null;
  swapUsedMb?: number | null;
  disk?: number | null;
  diskUsedGb?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  openFds?: number | null;
  maxFds?: number | null;
  tcpEstablished?: number | null;
  tcpListen?: number | null;
  tcpTimeWait?: number | null;
  tcpCloseWait?: number | null;
  tcpTotal?: number | null;
}

export interface MetricsHistoryServer {
  id: string;
  name: string;
  tags: string;
  data: MetricsHistoryDataPoint[];
}

export const getMetricsHistory = (envId: string, hours: number = 24, metric?: 'cpu' | 'memory' | 'disk' | 'load') => {
  const params = new URLSearchParams();
  params.append('hours', hours.toString());
  if (metric) params.append('metric', metric);
  return api.get<{ servers: MetricsHistoryServer[] }>(`/environments/${envId}/metrics/history?${params.toString()}`);
};

// Service Metrics History
export interface ServiceMetricsHistoryDataPoint {
  time: string;
  cpu?: number | null;
  memory?: number | null;
  memoryLimit?: number | null;
  networkRx?: number | null;
  networkTx?: number | null;
  restartCount?: number | null;
}

export interface ServiceMetricsHistoryItem {
  id: string;
  name: string;
  serverName: string;
  serverId: string;
  data: ServiceMetricsHistoryDataPoint[];
}

export const getServiceMetricsHistory = (envId: string, hours: number = 24) => {
  const params = new URLSearchParams();
  params.append('hours', hours.toString());
  return api.get<{ services: ServiceMetricsHistoryItem[] }>(`/environments/${envId}/services/metrics/history?${params.toString()}`);
};

// SSH Testing
export interface SSHTestResult {
  success: boolean;
  durationMs: number;
  error?: string;
}

export const testServerSSH = (serverId: string) =>
  api.post<SSHTestResult>(`/servers/${serverId}/test-ssh`);

export interface SSHTestAllResult {
  serverId: string;
  serverName: string;
  hostname: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export const testAllSSH = (envId: string) =>
  api.post<{ results: SSHTestAllResult[] }>(`/environments/${envId}/test-all-ssh`);

// Scheduler Config
export interface SchedulerConfig {
  serverHealthIntervalMs: number;
  serviceHealthIntervalMs: number;
  discoveryIntervalMs: number;
  metricsIntervalMs: number;
  updateCheckIntervalMs: number;
  backupCheckIntervalMs: number;
  metricsRetentionDays: number;
  healthLogRetentionDays: number;
  bounceThreshold: number;
  bounceCooldownMs: number;
  // Metrics collection toggles
  collectCpu: boolean;
  collectMemory: boolean;
  collectSwap: boolean;
  collectDisk: boolean;
  collectLoad: boolean;
  collectFds: boolean;
  collectTcp: boolean;
  collectProcesses: boolean;
  collectTcpChecks: boolean;
  collectCertChecks: boolean;
}

export const getSchedulerConfig = (envId: string) =>
  api.get<{ config: SchedulerConfig }>(`/environments/${envId}/scheduler-config`);

export const updateSchedulerConfig = (envId: string, config: Partial<SchedulerConfig>) =>
  api.patch<{ config: SchedulerConfig }>(`/environments/${envId}/scheduler-config`, config);

// Monitoring Overview
export interface MonitoringOverviewStats {
  servers: { total: number; healthy: number; unhealthy: number };
  services: { total: number; healthy: number; unhealthy: number };
  alerts: number;
}

export const getMonitoringOverview = (envId: string) =>
  api.get<{ stats: MonitoringOverviewStats }>(`/environments/${envId}/monitoring/overview`);

// Agent status type
export type AgentStatus = 'unknown' | 'deploying' | 'waiting' | 'active' | 'stale' | 'offline';

// Agents Info
export interface AgentInfo {
  id: string;
  name: string;
  hostname: string;
  sshStatus: string;
  metricsMode: MetricsMode;
  hasAgentToken: boolean;
  agentStatus: AgentStatus;
  agentVersion: string | null;
  agentStatusChangedAt: string | null;
  lastCheckedAt: string | null;
  lastAgentPushAt: string | null;
  lastMetricsPush: string | null;
  metricsSource: string | null;
}

export const getAgents = (envId: string) =>
  api.get<{ sshUser: string; agents: AgentInfo[]; bundledAgentVersion: string }>(`/environments/${envId}/agents`);

// Agent Events
export type AgentEventType = 'deploy_started' | 'deploy_success' | 'deploy_failed' | 'token_regenerated' | 'status_change';

export interface AgentEvent {
  id: string;
  eventType: AgentEventType;
  status: string | null;
  message: string | null;
  details: string | null;
  createdAt: string;
}

export const getAgentEvents = (serverId: string, limit?: number) =>
  api.get<{ events: AgentEvent[] }>(`/servers/${serverId}/agent-events${limit ? `?limit=${limit}` : ''}`);

// ==================== Container Image Updates ====================

export interface ContainerImageUpdateInput {
  name?: string;
  currentTag?: string;
  registryConnectionId?: string | null;
  autoUpdate?: boolean;
}

export interface ImageUpdateCheckResult {
  hasUpdate: boolean;
  currentTag: string;
  latestTag: string | null;
  latestDigest: string | null;
  lastCheckedAt: string;
}

export interface EnhancedContainerImageHistory extends ContainerImageHistory {
  services: Array<{ id: string; name: string; serverName: string }>;
  totalDurationMs: number;
  deploymentCount: number;
}

export const updateContainerImageSettings = (id: string, data: ContainerImageUpdateInput) =>
  api.patch<{ image: ContainerImage }>(`/container-images/${id}`, data);

export const checkContainerImageUpdates = (id: string) =>
  api.post<ImageUpdateCheckResult>(`/container-images/${id}/check-updates`);

export const getEnhancedContainerImageHistory = (id: string, limit?: number) =>
  api.get<{ history: EnhancedContainerImageHistory[] }>(`/container-images/${id}/history${limit ? `?limit=${limit}` : ''}`);

// ==================== Slack Integration ====================

export interface SlackChannel {
  id: string;
  name: string;
  slackChannelName: string | null;
  hasWebhookUrl: boolean;
  isDefault: boolean;
  enabled: boolean;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackChannelInput {
  name: string;
  slackChannelName?: string;
  webhookUrl: string;
  isDefault?: boolean;
  enabled?: boolean;
}

export interface SlackRouting {
  id: string;
  typeId: string;
  channelId: string;
  environmentIds: string | null;
  type: {
    id: string;
    code: string;
    name: string;
    severity: string;
  };
  channel: {
    id: string;
    name: string;
  };
}

// Slack Channels
export const listSlackChannels = () =>
  api.get<{ channels: SlackChannel[] }>('/admin/slack/channels');

export const getSlackChannel = (id: string) =>
  api.get<{ channel: SlackChannel }>(`/admin/slack/channels/${id}`);

export const createSlackChannel = (data: SlackChannelInput) =>
  api.post<{ channel: SlackChannel }>('/admin/slack/channels', data);

export const updateSlackChannel = (id: string, data: Partial<SlackChannelInput>) =>
  api.put<{ channel: SlackChannel }>(`/admin/slack/channels/${id}`, data);

export const deleteSlackChannel = (id: string) =>
  api.delete<{ success: boolean }>(`/admin/slack/channels/${id}`);

export const testSlackChannel = (id: string) =>
  api.post<{ success: boolean; message: string }>(`/admin/slack/channels/${id}/test`);

// Slack Routing
export const listSlackRoutings = () =>
  api.get<{ routings: SlackRouting[] }>('/admin/slack/routing');

export const updateSlackRoutings = (
  typeId: string,
  routings: Array<{ channelId: string; environmentIds?: string[] | null }>
) => api.put<{ routings: SlackRouting[] }>('/admin/slack/routing', { typeId, routings });

export const deleteSlackRouting = (typeId: string, channelId: string) =>
  api.delete<{ success: boolean }>(`/admin/slack/routing/${typeId}/${channelId}`);

// ==================== Data Store Monitoring ====================

export type DataStoreType = 'redis' | 'postgres' | 'sqlite';
export type DataStoreStatus = 'connected' | 'error' | 'unknown';

export interface DataStore {
  id: string;
  name: string;
  type: DataStoreType;
  environmentId: string;
  databaseId: string | null;
  host: string | null;
  port: number | null;
  hasCredentials: boolean;
  databaseName: string | null;
  redisDb: number | null;
  serverId: string | null;
  filePath: string | null;
  enabled: boolean;
  collectionIntervalSec: number;
  status: DataStoreStatus;
  lastCollectedAt: string | null;
  lastError: string | null;
  isCluster: boolean;
  clusterNodes: string | null;
  createdAt: string;
  updatedAt: string;
  server?: { id: string; name: string; hostname: string } | null;
  database?: { id: string; name: string } | null;
  latestMetrics?: {
    collectedAt: string;
    metrics: RedisMetrics | PostgresMetrics | SqliteMetrics;
  } | null;
}

export interface DataStoreInput {
  name: string;
  type: DataStoreType;
  host?: string;
  port?: number;
  password?: string;
  username?: string;
  databaseName?: string;
  redisDb?: number;
  serverId?: string;
  filePath?: string;
  databaseId?: string;
  enabled?: boolean;
  collectionIntervalSec?: number;
  isCluster?: boolean;
  clusterNodes?: string[];
}

// Redis Metrics
export interface RedisMetrics {
  hitRate: number | null;
  keyspaceHits: number;
  keyspaceMisses: number;
  usedMemoryBytes: number;
  maxMemoryBytes: number | null;
  memoryUsagePercent: number | null;
  evictedKeys: number;
  connectedClients: number;
  blockedClients: number;
  opsPerSec: number;
  memFragmentationRatio: number | null;
  totalKeys: number;
  keysWithExpiry: number;
  avgTtlMs: number | null;
  usedCpuSys: number;
  usedCpuUser: number;
  rejectedConnections: number;
  rdbLastSaveTime: string | null;
  rdbChangesPending: number;
  aofEnabled: boolean;
  aofCurrentSize: number | null;
  role: string;
  connectedSlaves: number;
  masterLinkStatus: string | null;
  replicationOffset: number | null;
  cluster?: {
    state: string;
    slotsAssigned: number;
    slotsOk: number;
    slotsPfail: number;
    slotsFail: number;
    knownNodes: number;
    clusterSize: number;
  };
  redisVersion: string;
  uptimeSeconds: number;
}

// PostgreSQL Metrics
export interface PostgresMetrics {
  activeConnections: number;
  idleConnections: number;
  maxConnections: number;
  connectionUsagePercent: number;
  databaseSizeBytes: number;
  cacheHitRatio: number | null;
  transactionsCommitted: number;
  transactionsRolledBack: number;
  tuplesReturned: number;
  tuplesFetched: number;
  tuplesInserted: number;
  tuplesUpdated: number;
  tuplesDeleted: number;
  deadlocks: number;
  tempFilesBytes: number;
  tempFilesCount: number;
  checkpointsWritten: number;
  checkpointsRequested: number;
  replication?: {
    isReplica: boolean;
    replayLagBytes: number | null;
    replayLagSeconds: number | null;
    state: string | null;
  };
  tableHealth?: {
    totalTables: number;
    totalDeadTuples: number;
    tablesNeedingVacuum: number;
  };
  longRunningQueries: Array<{
    pid: number;
    duration: string;
    state: string;
    query: string;
  }>;
  postgresVersion: string;
  uptimeSeconds: number | null;
}

// SQLite Metrics
export interface SqliteMetrics {
  fileSizeBytes: number;
  pageCount: number;
  pageSize: number;
  freePages: number;
  usedPages: number;
  fragmentationPercent: number;
  walEnabled: boolean;
  walSizeBytes: number | null;
  journalMode: string;
  autoVacuum: string;
  cacheSize: number;
  busyTimeout: number;
  integrityOk: boolean | null;
  integrityMessage: string | null;
  tableCount: number;
  indexCount: number;
  tables: Array<{
    name: string;
    rowCount: number | null;
    sizeEstimate: number | null;
  }>;
}

export interface DataStoreTestResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface DataStoreMetricsEntry {
  id: string;
  collectedAt: string;
  metrics: RedisMetrics | PostgresMetrics | SqliteMetrics;
}

export interface ClusterDiscoveryResult {
  isCluster: boolean;
  nodes?: string[];
  message: string;
}

// Data Store API methods
export const listDataStores = (envId: string) =>
  api.get<{ dataStores: DataStore[] }>(`/environments/${envId}/data-stores`);

export const createDataStore = (envId: string, data: DataStoreInput) =>
  api.post<{ dataStore: DataStore }>(`/environments/${envId}/data-stores`, data);

export const getDataStore = (id: string) =>
  api.get<{ dataStore: DataStore }>(`/data-stores/${id}`);

export const updateDataStore = (id: string, data: Partial<DataStoreInput>) =>
  api.patch<{ dataStore: DataStore }>(`/data-stores/${id}`, data);

export const deleteDataStore = (id: string) =>
  api.delete<{ success: boolean }>(`/data-stores/${id}`);

export const testDataStoreConnection = (id: string) =>
  api.post<DataStoreTestResult>(`/data-stores/${id}/test-connection`);

export const getDataStoreMetrics = (id: string, from?: string, to?: string, limit?: number) => {
  const params = new URLSearchParams();
  if (from) params.append('from', from);
  if (to) params.append('to', to);
  if (limit) params.append('limit', limit.toString());
  const query = params.toString();
  return api.get<{ metrics: DataStoreMetricsEntry[] }>(`/data-stores/${id}/metrics${query ? `?${query}` : ''}`);
};

export const collectDataStoreMetricsNow = (id: string) =>
  api.post<{ success: boolean; metrics: DataStoreMetricsEntry }>(`/data-stores/${id}/collect`);

export const discoverRedisCluster = (id: string) =>
  api.post<ClusterDiscoveryResult>(`/data-stores/${id}/discover-cluster`);

