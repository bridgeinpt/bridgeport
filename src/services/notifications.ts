import { prisma } from '../lib/db.js';
import type { Notification, NotificationType, NotificationPreference } from '@prisma/client';
import { sendEmail, generateNotificationEmail } from './email.js';
import { dispatchWebhook } from './outgoing-webhooks.js';
import { dispatchSlackNotification } from './slack-notifications.js';
import { eventBus } from '../lib/event-bus.js';
import { safeJsonParse } from '../lib/helpers.js';

// Predefined notification types
export const NOTIFICATION_TYPES = {
  // User notifications
  USER_ACCOUNT_CREATED: 'user.account_created',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_API_TOKEN_CREATED: 'user.api_token_created',
  USER_FAILED_LOGIN: 'user.failed_login',

  // System notifications
  SYSTEM_BACKUP_FAILED: 'system.backup_failed',
  SYSTEM_BACKUP_SUCCESS: 'system.backup_success',
  SYSTEM_HEALTH_CHECK_FAILED: 'system.health_check_failed',
  SYSTEM_HEALTH_CHECK_RECOVERED: 'system.health_check_recovered',
  SYSTEM_DEPLOYMENT_SUCCESS: 'system.deployment_success',
  SYSTEM_DEPLOYMENT_FAILED: 'system.deployment_failed',
  SYSTEM_SERVER_OFFLINE: 'system.server_offline',
  SYSTEM_SERVER_ONLINE: 'system.server_online',
  SYSTEM_CONTAINER_CRASH: 'system.container_crash',
  SYSTEM_CONTAINER_RECOVERED: 'system.container_recovered',
  SYSTEM_DATABASE_UNREACHABLE: 'system.database_unreachable',
} as const;

export type NotificationTypeCode = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

// Default notification type definitions
const DEFAULT_TYPES: Array<{
  code: string;
  category: string;
  name: string;
  description: string;
  template: string;
  defaultChannels: string[];
  severity: string;
  bounceEnabled: boolean;
  bounceThreshold: number;
  bounceCooldown: number;
}> = [
  // User notifications
  {
    code: NOTIFICATION_TYPES.USER_ACCOUNT_CREATED,
    category: 'user',
    name: 'Account Created',
    description: 'Your account has been created',
    template: 'Welcome to BridgePort! Your account has been created.',
    defaultChannels: ['in_app', 'email'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.USER_PASSWORD_CHANGED,
    category: 'user',
    name: 'Password Changed',
    description: 'Your password has been changed',
    template: 'Your password was changed{{changedBy}}.',
    defaultChannels: ['in_app', 'email'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.USER_ROLE_CHANGED,
    category: 'user',
    name: 'Role Changed',
    description: 'Your role has been updated',
    template: 'Your role has been changed from {{oldRole}} to {{newRole}}.',
    defaultChannels: ['in_app', 'email'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.USER_API_TOKEN_CREATED,
    category: 'user',
    name: 'API Token Created',
    description: 'A new API token was created',
    template: 'A new API token "{{tokenName}}" was created for your account.',
    defaultChannels: ['in_app'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.USER_FAILED_LOGIN,
    category: 'user',
    name: 'Failed Login Attempt',
    description: 'Multiple failed login attempts detected',
    template: 'There have been {{count}} failed login attempts to your account.',
    defaultChannels: ['in_app', 'email'],
    severity: 'warning',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  // System notifications
  {
    code: NOTIFICATION_TYPES.SYSTEM_BACKUP_FAILED,
    category: 'system',
    name: 'Backup Failed',
    description: 'A database backup has failed',
    template: 'Backup failed for database "{{databaseName}}": {{error}}',
    defaultChannels: ['in_app', 'email', 'webhook'],
    severity: 'critical',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_BACKUP_SUCCESS,
    category: 'system',
    name: 'Backup Succeeded',
    description: 'A database backup completed successfully',
    template: 'Backup completed for database "{{databaseName}}".',
    defaultChannels: ['in_app'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_HEALTH_CHECK_FAILED,
    category: 'system',
    name: 'Health Check Failed',
    description: 'A service health check has failed',
    template: '{{resourceType}} "{{resourceName}}" is unhealthy: {{error}}',
    defaultChannels: ['in_app', 'email', 'webhook'],
    severity: 'warning',
    bounceEnabled: true,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_HEALTH_CHECK_RECOVERED,
    category: 'system',
    name: 'Health Check Recovered',
    description: 'A service has recovered from health check failures',
    template: '{{resourceType}} "{{resourceName}}" is healthy again.',
    defaultChannels: ['in_app', 'email', 'webhook'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS,
    category: 'system',
    name: 'Deployment Succeeded',
    description: 'A deployment completed successfully',
    template: 'Deployment of "{{serviceName}}" to {{imageTag}} succeeded.',
    defaultChannels: ['in_app'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED,
    category: 'system',
    name: 'Deployment Failed',
    description: 'A deployment has failed',
    template: 'Deployment of "{{serviceName}}" failed: {{error}}',
    defaultChannels: ['in_app', 'email', 'webhook'],
    severity: 'critical',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE,
    category: 'system',
    name: 'Server Offline',
    description: 'A server is no longer reachable',
    template: 'Server "{{serverName}}" is offline.',
    defaultChannels: ['in_app', 'email', 'webhook'],
    severity: 'critical',
    bounceEnabled: true,
    bounceThreshold: 2,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_SERVER_ONLINE,
    category: 'system',
    name: 'Server Back Online',
    description: 'A server is back online',
    template: 'Server "{{serverName}}" is back online.',
    defaultChannels: ['in_app', 'email', 'webhook'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_CONTAINER_CRASH,
    category: 'system',
    name: 'Container Crashed',
    description: 'A container has crashed or exited unexpectedly',
    template: 'Container "{{containerName}}" on "{{serverName}}" has crashed.',
    defaultChannels: ['in_app', 'email', 'webhook'],
    severity: 'warning',
    bounceEnabled: true,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_CONTAINER_RECOVERED,
    category: 'system',
    name: 'Container Recovered',
    description: 'A container has recovered from a crash',
    template: 'Container "{{containerName}}" on "{{serverName}}" is running again.',
    defaultChannels: ['in_app'],
    severity: 'info',
    bounceEnabled: false,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
  {
    code: NOTIFICATION_TYPES.SYSTEM_DATABASE_UNREACHABLE,
    category: 'system',
    name: 'Database Unreachable',
    description: 'A monitored database cannot be reached',
    template: 'Database "{{databaseName}}" is unreachable: {{error}}',
    defaultChannels: ['in_app', 'email', 'webhook'],
    severity: 'critical',
    bounceEnabled: true,
    bounceThreshold: 3,
    bounceCooldown: 900,
  },
];

/**
 * Initialize default notification types if they don't exist
 */
export async function initializeNotificationTypes(): Promise<void> {
  for (const type of DEFAULT_TYPES) {
    await prisma.notificationType.upsert({
      where: { code: type.code },
      create: {
        code: type.code,
        category: type.category,
        name: type.name,
        description: type.description,
        template: type.template,
        defaultChannels: JSON.stringify(type.defaultChannels),
        severity: type.severity,
        bounceEnabled: type.bounceEnabled,
        bounceThreshold: type.bounceThreshold,
        bounceCooldown: type.bounceCooldown,
      },
      update: {},
    });
  }
  console.log(`[Notifications] Initialized ${DEFAULT_TYPES.length} notification types`);
}

/**
 * Get notification type by code
 */
export async function getNotificationType(code: string): Promise<NotificationType | null> {
  return prisma.notificationType.findUnique({ where: { code } });
}

/**
 * List all notification types
 */
export async function listNotificationTypes(): Promise<NotificationType[]> {
  return prisma.notificationType.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] });
}

/**
 * Update notification type settings (admin only)
 */
export async function updateNotificationType(
  id: string,
  data: {
    defaultChannels?: string[];
    enabled?: boolean;
    bounceEnabled?: boolean;
    bounceThreshold?: number;
    bounceCooldown?: number;
  }
): Promise<NotificationType> {
  const updateData: Record<string, unknown> = {};
  if (data.defaultChannels !== undefined) {
    updateData.defaultChannels = JSON.stringify(data.defaultChannels);
  }
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  if (data.bounceEnabled !== undefined) updateData.bounceEnabled = data.bounceEnabled;
  if (data.bounceThreshold !== undefined) updateData.bounceThreshold = data.bounceThreshold;
  if (data.bounceCooldown !== undefined) updateData.bounceCooldown = data.bounceCooldown;

  return prisma.notificationType.update({ where: { id }, data: updateData });
}

/**
 * Render a notification template with data
 */
function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key];
    return value !== undefined ? String(value) : '';
  });
}

/**
 * Send a notification to a specific user
 */
export async function send(
  typeCode: NotificationTypeCode,
  userId: string,
  data: Record<string, unknown> = {},
  environmentId?: string
): Promise<Notification | null> {
  const notificationType = await getNotificationType(typeCode);
  if (!notificationType) {
    console.error(`[Notifications] Unknown notification type: ${typeCode}`);
    return null;
  }

  // Check user preferences
  const preference = await prisma.notificationPreference.findUnique({
    where: { userId_typeId: { userId, typeId: notificationType.id } },
  });

  // If user has disabled in-app for this type, skip
  const inAppEnabled = preference?.inAppEnabled ?? true;
  if (!inAppEnabled) {
    return null;
  }

  // Check environment filter if preference specifies certain environments
  if (environmentId && preference?.environmentIds) {
    const allowedEnvs = safeJsonParse(preference.environmentIds, [] as string[]);
    if (!allowedEnvs.includes(environmentId)) {
      return null;
    }
  }

  // Create title from notification type name
  const title = notificationType.name;
  const message = renderTemplate(notificationType.template, data);

  const notification = await prisma.notification.create({
    data: {
      typeId: notificationType.id,
      userId,
      title,
      message,
      data: JSON.stringify(data),
      environmentId,
    },
  });

  // Emit SSE event for real-time notification
  eventBus.emitEvent({ type: 'notification', data: { userId, count: 1 } });

  // Send email if enabled
  const emailEnabled = preference?.emailEnabled ?? safeJsonParse(notificationType.defaultChannels, [] as string[]).includes('email');
  if (emailEnabled) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (user?.email) {
      let envName: string | undefined;
      if (environmentId) {
        const env = await prisma.environment.findUnique({ where: { id: environmentId }, select: { name: true } });
        envName = env?.name;
      }
      const { html, text } = generateNotificationEmail(title, message, notificationType.severity, envName);
      const emailResult = await sendEmail({
        to: user.email,
        subject: `[BridgePort] ${title}`,
        html,
        text,
      });
      if (emailResult.success) {
        await prisma.notification.update({
          where: { id: notification.id },
          data: { emailSentAt: new Date() },
        });
      }
    }
  }

  return notification;
}

/**
 * Send a system notification to all subscribed users
 */
export async function sendSystemNotification(
  typeCode: NotificationTypeCode,
  environmentId: string | null,
  data: Record<string, unknown> = {}
): Promise<Notification[]> {
  const notificationType = await getNotificationType(typeCode);
  if (!notificationType) {
    console.error(`[Notifications] Unknown notification type: ${typeCode}`);
    return [];
  }

  // Check if this notification type is enabled (only for system notifications)
  if (notificationType.category === 'system' && !notificationType.enabled) {
    return [];
  }

  // Get all users
  const users = await prisma.user.findMany({ select: { id: true } });

  const notifications: Notification[] = [];
  for (const user of users) {
    const notification = await send(typeCode, user.id, data, environmentId ?? undefined);
    if (notification) {
      notifications.push(notification);
    }
  }

  // Send webhooks for system notifications
  const defaultChannels = safeJsonParse(notificationType.defaultChannels, [] as string[]);
  let envName: string | undefined;
  if (environmentId) {
    const env = await prisma.environment.findUnique({ where: { id: environmentId }, select: { name: true } });
    envName = env?.name;
  }

  if (defaultChannels.includes('webhook')) {
    await dispatchWebhook(typeCode, environmentId, data, envName);
  }

  // Send Slack notifications (routing is configured separately in Slack settings)
  const title = notificationType.name;
  const message = renderTemplate(notificationType.template, data);
  await dispatchSlackNotification(notificationType, title, message, data, environmentId, envName);

  return notifications;
}

/**
 * Mark a notification as read
 */
export async function markAsRead(notificationId: string, userId: string): Promise<Notification | null> {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });

  if (!notification) {
    return null;
  }

  return prisma.notification.update({
    where: { id: notificationId },
    data: { inAppReadAt: new Date() },
  });
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllAsRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, inAppReadAt: null },
    data: { inAppReadAt: new Date() },
  });
  return result.count;
}

/**
 * Get unread notification count for a user
 */
export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { userId, inAppReadAt: null },
  });
}

export interface NotificationWithType extends Notification {
  type: NotificationType;
}

export interface ListNotificationsOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  environmentId?: string;
  category?: 'user' | 'system';
}

/**
 * List notifications for a user
 */
export async function list(
  userId: string,
  options: ListNotificationsOptions = {}
): Promise<{ notifications: NotificationWithType[]; total: number }> {
  const { limit = 50, offset = 0, unreadOnly = false, environmentId, category } = options;

  const where: {
    userId: string;
    inAppReadAt?: null;
    environmentId?: string;
    type?: { category: string };
  } = { userId };

  if (unreadOnly) {
    where.inAppReadAt = null;
  }
  if (environmentId) {
    where.environmentId = environmentId;
  }
  if (category) {
    where.type = { category };
  }

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      include: { type: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.notification.count({ where }),
  ]);

  return { notifications, total };
}

/**
 * Get user notification preferences
 */
export async function getPreferences(userId: string): Promise<Array<NotificationPreference & { type: NotificationType }>> {
  // Get all notification types
  const types = await listNotificationTypes();

  // Get user's existing preferences
  const existingPrefs = await prisma.notificationPreference.findMany({
    where: { userId },
    include: { type: true },
  });

  const existingPrefMap = new Map(existingPrefs.map((p) => [p.typeId, p]));

  // Return preferences for all types, creating defaults for missing ones
  const results: Array<NotificationPreference & { type: NotificationType }> = [];

  for (const notifType of types) {
    const existing = existingPrefMap.get(notifType.id);
    if (existing) {
      results.push(existing);
    } else {
      // Return a virtual preference with defaults
      const defaultChannels = safeJsonParse(notifType.defaultChannels, ['in_app'] as string[]);
      results.push({
        id: `virtual-${notifType.id}`,
        userId,
        typeId: notifType.id,
        type: notifType,
        inAppEnabled: defaultChannels.includes('in_app'),
        emailEnabled: defaultChannels.includes('email'),
        webhookEnabled: defaultChannels.includes('webhook'),
        environmentIds: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  return results;
}

/**
 * Update user notification preference for a specific type
 */
export async function updatePreference(
  userId: string,
  typeId: string,
  data: {
    inAppEnabled?: boolean;
    emailEnabled?: boolean;
    webhookEnabled?: boolean;
    environmentIds?: string[] | null;
  }
): Promise<NotificationPreference> {
  const updateData: Record<string, unknown> = {};
  if (data.inAppEnabled !== undefined) updateData.inAppEnabled = data.inAppEnabled;
  if (data.emailEnabled !== undefined) updateData.emailEnabled = data.emailEnabled;
  if (data.webhookEnabled !== undefined) updateData.webhookEnabled = data.webhookEnabled;
  if (data.environmentIds !== undefined) {
    updateData.environmentIds = data.environmentIds ? JSON.stringify(data.environmentIds) : null;
  }

  return prisma.notificationPreference.upsert({
    where: { userId_typeId: { userId, typeId } },
    create: {
      userId,
      typeId,
      ...updateData,
    },
    update: updateData,
  });
}

/**
 * Delete old notifications (older than retentionDays)
 */
export async function cleanupOldNotifications(retentionDays: number = 30): Promise<number> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await prisma.notification.deleteMany({
    where: { createdAt: { lt: cutoffDate } },
  });

  return result.count;
}
