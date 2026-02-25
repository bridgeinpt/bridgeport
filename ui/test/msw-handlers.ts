import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// Default mock data
export const mockUser = {
  id: 'user-1',
  email: 'admin@test.com',
  name: 'Test Admin',
  role: 'admin' as const,
  createdAt: '2024-01-01T00:00:00Z',
};

export const mockEnvironment = {
  id: 'env-1',
  name: 'Production',
  createdAt: '2024-01-01T00:00:00Z',
  _count: { servers: 2, secrets: 5 },
};

export const mockServer = {
  id: 'server-1',
  name: 'web-01',
  hostname: '10.0.0.1',
  publicIp: '1.2.3.4',
  tags: '[]',
  status: 'healthy',
  serverType: 'remote' as const,
  lastCheckedAt: '2024-01-01T12:00:00Z',
  environmentId: 'env-1',
};

export const mockService = {
  id: 'service-1',
  name: 'api',
  containerName: 'api-container',
  imageTag: 'v1.0.0',
  composePath: '/opt/docker/compose.yml',
  healthCheckUrl: 'http://localhost:3000/health',
  status: 'running',
  containerStatus: 'running',
  healthStatus: 'healthy',
  exposedPorts: '[{"host":3000,"container":3000,"protocol":"tcp"}]',
  discoveryStatus: 'found',
  lastCheckedAt: '2024-01-01T12:00:00Z',
  lastDiscoveredAt: '2024-01-01T12:00:00Z',
  serverId: 'server-1',
  autoUpdate: false,
  latestAvailableTag: null,
  latestAvailableDigest: null,
  lastUpdateCheckAt: null,
};

export const mockNotification = {
  id: 'notif-1',
  title: 'Deployment Successful',
  message: 'Service api deployed v1.0.0',
  inAppReadAt: null,
  createdAt: '2024-01-01T12:00:00Z',
  type: {
    id: 'type-1',
    key: 'deployment_success',
    name: 'Deployment Success',
    severity: 'info',
    category: 'deployments',
  },
};

// Default handlers for common API endpoints
export const handlers = [
  // Auth
  http.post('/api/auth/login', () => {
    return HttpResponse.json({
      token: 'test-jwt-token',
      user: mockUser,
    });
  }),

  http.get('/api/auth/me', () => {
    return HttpResponse.json({ user: mockUser });
  }),

  // Environments
  http.get('/api/environments', () => {
    return HttpResponse.json({
      environments: [mockEnvironment],
    });
  }),

  // Servers
  http.get('/api/environments/:envId/servers', () => {
    return HttpResponse.json({
      servers: [{ ...mockServer, services: [mockService] }],
      total: 1,
    });
  }),

  http.get('/api/servers/:id', () => {
    return HttpResponse.json({
      server: { ...mockServer, services: [mockService] },
    });
  }),

  // Services
  http.get('/api/environments/:envId/services', () => {
    return HttpResponse.json({
      services: [{ ...mockService, server: { id: 'server-1', name: 'web-01' } }],
      total: 1,
    });
  }),

  http.get('/api/services/:id', () => {
    return HttpResponse.json({
      service: {
        ...mockService,
        server: { ...mockServer, services: [] },
      },
    });
  }),

  // Notifications
  http.get('/api/notifications/unread-count', () => {
    return HttpResponse.json({ count: 3 });
  }),

  http.get('/api/notifications', () => {
    return HttpResponse.json({
      notifications: [mockNotification],
      total: 1,
    });
  }),

  http.post('/api/notifications/:id/read', () => {
    return HttpResponse.json({ success: true });
  }),

  http.post('/api/notifications/read-all', () => {
    return HttpResponse.json({ success: true });
  }),

  // Secrets
  http.get('/api/environments/:envId/secrets', () => {
    return HttpResponse.json({
      secrets: [
        {
          id: 'secret-1',
          key: 'DATABASE_URL',
          neverReveal: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    });
  }),

  // Container Images
  http.get('/api/environments/:envId/container-images', () => {
    return HttpResponse.json({
      images: [],
      total: 0,
    });
  }),

  // Deployment Plans
  http.get('/api/environments/:envId/deployment-plans', () => {
    return HttpResponse.json({
      plans: [],
      total: 0,
    });
  }),

  // Registries
  http.get('/api/environments/:envId/registries', () => {
    return HttpResponse.json({ registries: [] });
  }),

  // Databases
  http.get('/api/environments/:envId/databases', () => {
    return HttpResponse.json({ databases: [], total: 0 });
  }),

  // Health
  http.get('/health', () => {
    return HttpResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '20240101-abc1234',
      bundledAgentVersion: '20240101-def5678',
      cliVersion: '20240101-ghi9012',
    });
  }),

  // Topology
  http.get('/api/environments/:envId/topology/connections', () => {
    return HttpResponse.json({ connections: [] });
  }),

  http.get('/api/environments/:envId/topology/layout', () => {
    return HttpResponse.json({ layout: null });
  }),

  // Monitoring overview
  http.get('/api/monitoring/overview', () => {
    return HttpResponse.json({
      servers: { total: 2, healthy: 1, unhealthy: 1 },
      services: { total: 5, running: 4, stopped: 1 },
      databases: { total: 1, monitored: 1 },
      healthChecks: { total: 10, healthy: 8, unhealthy: 2 },
    });
  }),

  // Settings
  http.get('/api/environments/:envId/settings/:module', () => {
    return HttpResponse.json({
      settings: {},
      definitions: [],
    });
  }),

  // System Settings
  http.get('/api/system-settings', () => {
    return HttpResponse.json({
      settings: {
        sshConnectTimeoutMs: 10000,
        sshCommandTimeoutMs: 30000,
        webhookMaxRetries: 3,
        webhookRetryDelayMs: 5000,
        backupTimeoutMs: 600000,
        maxConcurrentDeploys: 5,
      },
    });
  }),

  // Service types
  http.get('/api/service-types', () => {
    return HttpResponse.json({ serviceTypes: [] });
  }),

  // Database types
  http.get('/api/database-types', () => {
    return HttpResponse.json({ databaseTypes: [] });
  }),

  // Audit
  http.get('/api/audit', () => {
    return HttpResponse.json({ logs: [], total: 0 });
  }),

  // Users
  http.get('/api/users', () => {
    return HttpResponse.json({ users: [mockUser] });
  }),

  // Config Files
  http.get('/api/environments/:envId/config-files', () => {
    return HttpResponse.json({ configFiles: [] });
  }),

  // Spaces
  http.get('/api/spaces', () => {
    return HttpResponse.json({ config: null });
  }),

  // Notification types
  http.get('/api/notification-types', () => {
    return HttpResponse.json({ types: [] });
  }),

  // SMTP config
  http.get('/api/admin/smtp', () => {
    return HttpResponse.json({ config: null });
  }),

  // Slack channels
  http.get('/api/admin/slack/channels', () => {
    return HttpResponse.json({ channels: [] });
  }),

  // Webhook configs
  http.get('/api/admin/webhooks', () => {
    return HttpResponse.json({ webhooks: [] });
  }),

  // Downloads
  http.get('/api/downloads/cli', () => {
    return HttpResponse.json({
      version: '20240101-abc1234',
      downloads: [],
    });
  }),

  // Monitoring
  http.get('/api/monitoring/health-logs', () => {
    return HttpResponse.json({ logs: [], total: 0 });
  }),

  http.get('/api/monitoring/servers/:id/metrics', () => {
    return HttpResponse.json({ metrics: [] });
  }),

  http.get('/api/monitoring/services/:id/metrics', () => {
    return HttpResponse.json({ metrics: [] });
  }),

  http.get('/api/monitoring/agents', () => {
    return HttpResponse.json({ agents: [] });
  }),
];

export const server = setupServer(...handlers);
