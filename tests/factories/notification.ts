/**
 * Notification factory for tests.
 */
import { PrismaClient } from '@prisma/client';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestNotificationTypeOptions {
  category?: string;
  code?: string;
  name?: string;
  template?: string;
  severity?: 'info' | 'warning' | 'critical';
  bounceEnabled?: boolean;
  bounceThreshold?: number;
}

export async function createTestNotificationType(
  prisma: PrismaClient,
  options: CreateTestNotificationTypeOptions = {}
) {
  const n = nextId();
  return prisma.notificationType.create({
    data: {
      category: options.category ?? 'system',
      code: options.code ?? `test.notification_${n}`,
      name: options.name ?? `Test Notification ${n}`,
      template: options.template ?? 'Test notification: {{message}}',
      severity: options.severity ?? 'info',
      bounceEnabled: options.bounceEnabled ?? false,
      bounceThreshold: options.bounceThreshold ?? 3,
    },
  });
}

export interface CreateTestNotificationOptions {
  typeId: string;
  userId: string;
  title?: string;
  message?: string;
  environmentId?: string;
  inAppReadAt?: Date;
}

export async function createTestNotification(
  prisma: PrismaClient,
  options: CreateTestNotificationOptions
) {
  const n = nextId();
  return prisma.notification.create({
    data: {
      typeId: options.typeId,
      userId: options.userId,
      title: options.title ?? `Test Notification ${n}`,
      message: options.message ?? `This is test notification ${n}`,
      environmentId: options.environmentId,
      inAppReadAt: options.inAppReadAt,
    },
  });
}

export function resetNotificationCounter() {
  counter = 0;
}
