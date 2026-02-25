/**
 * RBAC Matrix Test
 *
 * Tests every route category x every role (admin, operator, viewer)
 * to verify authorization is enforced correctly.
 *
 * Route categories:
 * - viewer: Only requires authentication (any role can access)
 * - operator: Requires admin or operator role
 * - admin: Requires admin role only
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { generateTestToken } from '../helpers/auth.js';
import { createTestUser, createTestEnvironment } from '../factories/index.js';

let app: TestApp;

// User IDs for each role
let adminId: string;
let operatorId: string;
let viewerId: string;

// Tokens for each role
let adminToken: string;
let operatorToken: string;
let viewerToken: string;

// Test environment for routes that require :envId
let envId: string;

beforeAll(async () => {
  app = await buildTestApp();

  // Create users for each role
  const admin = await createTestUser(app.prisma, { role: 'admin', email: 'admin@rbac.test' });
  const operator = await createTestUser(app.prisma, { role: 'operator', email: 'operator@rbac.test' });
  const viewer = await createTestUser(app.prisma, { role: 'viewer', email: 'viewer@rbac.test' });

  adminId = admin.id;
  operatorId = operator.id;
  viewerId = viewer.id;

  adminToken = await generateTestToken({ id: adminId, email: admin.email });
  operatorToken = await generateTestToken({ id: operatorId, email: operator.email });
  viewerToken = await generateTestToken({ id: viewerId, email: viewer.email });

  // Create a test environment
  const env = await createTestEnvironment(app.prisma);
  envId = env.id;
});

afterAll(async () => {
  await app.close();
});

// Route definitions with minimum required role
interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  minRole: 'admin' | 'operator' | 'viewer';
  body?: Record<string, unknown>;
  description?: string;
}

// Admin-only routes
const adminRoutes: RouteSpec[] = [
  // Users management
  { method: 'GET', url: '/api/users', minRole: 'admin', description: 'list users' },
  { method: 'POST', url: '/api/users', minRole: 'admin', body: { email: 'new@test.com', password: 'password123', role: 'viewer' }, description: 'create user' },

  // Environment management (create/delete/update)
  { method: 'POST', url: '/api/environments', minRole: 'admin', body: { name: 'rbac-test-env' }, description: 'create environment' },

  // Server deletion
  { method: 'DELETE', url: '/api/servers/__PLACEHOLDER__', minRole: 'admin', description: 'delete server' },

  // Environment settings
  { method: 'PATCH', url: `/api/environments/__ENV__/settings/general`, minRole: 'admin', body: { sshUser: 'deploy' }, description: 'update env settings' },
  { method: 'POST', url: `/api/environments/__ENV__/settings/general/reset`, minRole: 'admin', description: 'reset env settings' },

  // Admin SMTP config
  { method: 'GET', url: '/api/admin/smtp', minRole: 'admin', description: 'get SMTP config' },
  { method: 'PUT', url: '/api/admin/smtp', minRole: 'admin', body: { host: 'smtp.test.com', port: 587, username: 'test', password: 'test', from: 'test@test.com' }, description: 'update SMTP config' },

  // Admin webhooks
  { method: 'GET', url: '/api/admin/webhooks', minRole: 'admin', description: 'list admin webhooks' },
  { method: 'POST', url: '/api/admin/webhooks', minRole: 'admin', body: { url: 'https://hook.test.com', name: 'test' }, description: 'create admin webhook' },

  // Admin Slack
  { method: 'GET', url: '/api/admin/slack/channels', minRole: 'admin', description: 'list Slack channels' },
  { method: 'POST', url: '/api/admin/slack/channels', minRole: 'admin', body: { name: 'test', webhookUrl: 'https://hooks.slack.com/test' }, description: 'create Slack channel' },

  // System settings
  { method: 'PUT', url: '/api/settings/system', minRole: 'admin', body: { sshCommandTimeoutMs: 30000 }, description: 'update system settings' },
  { method: 'POST', url: '/api/settings/system/reset', minRole: 'admin', description: 'reset system settings' },

  // Notification types management
  { method: 'GET', url: '/api/admin/notification-types', minRole: 'admin', description: 'list notification types' },

  // Service types (settings)
  { method: 'POST', url: '/api/settings/service-types', minRole: 'admin', body: { name: 'rbac-test-type', displayName: 'RBAC Test Type' }, description: 'create service type' },

  // Spaces config
  { method: 'PUT', url: '/api/settings/spaces', minRole: 'admin', body: { accessKey: 'test', secretKey: 'test', region: 'us-east-1', bucket: 'test', endpoint: 'https://test.com' }, description: 'update spaces config' },
  { method: 'DELETE', url: '/api/settings/spaces', minRole: 'admin', description: 'delete spaces config' },
];

// Operator-only routes (admin + operator allowed, viewer denied)
const operatorRoutes: RouteSpec[] = [
  // Database mutations
  { method: 'POST', url: `/api/environments/__ENV__/databases`, minRole: 'operator', body: { name: 'test-db', type: 'postgresql', host: 'localhost', port: 5432 }, description: 'create database' },

  // Config file mutations
  { method: 'POST', url: `/api/environments/__ENV__/config-files`, minRole: 'operator', body: { name: 'test.conf', filename: 'test.conf', content: 'test=1' }, description: 'create config file' },

  // Topology mutations
  { method: 'POST', url: `/api/connections`, minRole: 'operator', body: { environmentId: '__ENV__', sourceType: 'service', sourceId: 'test', targetType: 'service', targetId: 'test2' }, description: 'create topology connection' },
];

// Viewer routes (any authenticated user can access)
const viewerRoutes: RouteSpec[] = [
  // Auth routes
  { method: 'GET', url: '/api/auth/me', minRole: 'viewer', description: 'get current user' },
  { method: 'GET', url: '/api/auth/tokens', minRole: 'viewer', description: 'list API tokens' },

  // Environment listing
  { method: 'GET', url: '/api/environments', minRole: 'viewer', description: 'list environments' },

  // Server listing
  { method: 'GET', url: '/api/environments/__ENV__/servers', minRole: 'viewer', description: 'list servers' },

  // Audit logs
  { method: 'GET', url: '/api/audit-logs', minRole: 'viewer', description: 'list audit logs' },

  // System settings (read)
  { method: 'GET', url: '/api/settings/system', minRole: 'viewer', description: 'get system settings' },

  // Notifications
  { method: 'GET', url: '/api/notifications', minRole: 'viewer', description: 'list notifications' },
  { method: 'GET', url: '/api/notifications/preferences', minRole: 'viewer', description: 'get notification preferences' },

  // Monitoring overview (requires envId)
  { method: 'GET', url: '/api/environments/__ENV__/monitoring/overview', minRole: 'viewer', description: 'monitoring overview' },
];

const roleHierarchy: Record<string, number> = {
  admin: 3,
  operator: 2,
  viewer: 1,
};

function getTokenForRole(role: string): string {
  switch (role) {
    case 'admin': return adminToken;
    case 'operator': return operatorToken;
    case 'viewer': return viewerToken;
    default: throw new Error(`Unknown role: ${role}`);
  }
}

function resolveUrl(url: string): string {
  return url
    .replace('__ENV__', envId)
    .replace('__PLACEHOLDER__', 'nonexistent-id');
}

function resolveBody(body?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!body) return body;
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    resolved[key] = typeof value === 'string' ? value.replace('__ENV__', envId) : value;
  }
  return resolved;
}

describe('RBAC enforcement', () => {
  describe('admin-only routes should deny operator and viewer', () => {
    for (const route of adminRoutes) {
      const label = route.description || `${route.method} ${route.url}`;

      it(`${label} — viewer should get 403`, async () => {
        const res = await app.inject({
          method: route.method,
          url: resolveUrl(route.url),
          headers: { authorization: `Bearer ${viewerToken}` },
          ...(route.body ? { payload: resolveBody(route.body) } : {}),
        });

        expect(res.statusCode).toBe(403);
      });

      it(`${label} — operator should get 403`, async () => {
        const res = await app.inject({
          method: route.method,
          url: resolveUrl(route.url),
          headers: { authorization: `Bearer ${operatorToken}` },
          ...(route.body ? { payload: resolveBody(route.body) } : {}),
        });

        expect(res.statusCode).toBe(403);
      });

      it(`${label} — admin should not get 403`, async () => {
        const res = await app.inject({
          method: route.method,
          url: resolveUrl(route.url),
          headers: { authorization: `Bearer ${adminToken}` },
          ...(route.body ? { payload: resolveBody(route.body) } : {}),
        });

        // Admin should succeed (not 401 or 403). May get 404 for placeholder IDs, or
        // other codes like 400/409 for validation — that's fine, the point is no 403.
        expect(res.statusCode).not.toBe(403);
        expect(res.statusCode).not.toBe(401);
      });
    }
  });

  describe('operator routes should deny viewer but allow operator and admin', () => {
    for (const route of operatorRoutes) {
      const label = route.description || `${route.method} ${route.url}`;

      it(`${label} — viewer should get 403`, async () => {
        const res = await app.inject({
          method: route.method,
          url: resolveUrl(route.url),
          headers: { authorization: `Bearer ${viewerToken}` },
          ...(route.body ? { payload: resolveBody(route.body) } : {}),
        });

        expect(res.statusCode).toBe(403);
      });

      it(`${label} — operator should not get 403`, async () => {
        const res = await app.inject({
          method: route.method,
          url: resolveUrl(route.url),
          headers: { authorization: `Bearer ${operatorToken}` },
          ...(route.body ? { payload: resolveBody(route.body) } : {}),
        });

        expect(res.statusCode).not.toBe(403);
        expect(res.statusCode).not.toBe(401);
      });

      it(`${label} — admin should not get 403`, async () => {
        const res = await app.inject({
          method: route.method,
          url: resolveUrl(route.url),
          headers: { authorization: `Bearer ${adminToken}` },
          ...(route.body ? { payload: resolveBody(route.body) } : {}),
        });

        expect(res.statusCode).not.toBe(403);
        expect(res.statusCode).not.toBe(401);
      });
    }
  });

  describe('viewer routes should allow all authenticated roles', () => {
    const roles = ['admin', 'operator', 'viewer'] as const;

    for (const route of viewerRoutes) {
      const label = route.description || `${route.method} ${route.url}`;

      for (const role of roles) {
        it(`${label} — ${role} should not get 401 or 403`, async () => {
          const token = getTokenForRole(role);
          const res = await app.inject({
            method: route.method,
            url: resolveUrl(route.url),
            headers: { authorization: `Bearer ${token}` },
            ...(route.body ? { payload: resolveBody(route.body) } : {}),
          });

          expect(res.statusCode).not.toBe(401);
          expect(res.statusCode).not.toBe(403);
        });
      }
    }
  });

  describe('all protected routes should require authentication', () => {
    const allRoutes = [...adminRoutes, ...operatorRoutes, ...viewerRoutes];

    for (const route of allRoutes) {
      const label = route.description || `${route.method} ${route.url}`;

      it(`${label} — no auth header should get 401`, async () => {
        const res = await app.inject({
          method: route.method,
          url: resolveUrl(route.url),
          ...(route.body ? { payload: resolveBody(route.body) } : {}),
        });

        expect(res.statusCode).toBe(401);
      });
    }
  });
});
