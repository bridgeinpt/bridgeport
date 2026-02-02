import { prisma } from '../lib/db.js';
import { getNotificationType } from './notifications.js';

export type ResourceType = 'server' | 'service' | 'database';
export type EventType = 'health_check' | 'offline' | 'crash' | 'backup';

interface BounceResult {
  shouldAlert: boolean;
  consecutiveFailures: number;
  wasRecovered?: boolean;
}

/**
 * Record a failure for a resource.
 * Returns whether we should send an alert (threshold reached and not in cooldown).
 */
export async function recordFailure(
  resourceType: ResourceType,
  resourceId: string,
  eventType: EventType,
  notificationTypeCode?: string
): Promise<BounceResult> {
  const now = new Date();

  // Get or create tracker
  let tracker = await prisma.bounceTracker.findUnique({
    where: {
      resourceType_resourceId_eventType: { resourceType, resourceId, eventType },
    },
  });

  if (!tracker) {
    tracker = await prisma.bounceTracker.create({
      data: {
        resourceType,
        resourceId,
        eventType,
        consecutiveFailures: 1,
        lastFailedAt: now,
      },
    });
    return { shouldAlert: false, consecutiveFailures: 1 };
  }

  // Increment failure count
  const newCount = tracker.consecutiveFailures + 1;
  await prisma.bounceTracker.update({
    where: { id: tracker.id },
    data: {
      consecutiveFailures: newCount,
      lastFailedAt: now,
    },
  });

  // Get threshold and cooldown from notification type if provided
  let threshold = 3;
  let cooldown = 900; // 15 minutes default

  if (notificationTypeCode) {
    const notifType = await getNotificationType(notificationTypeCode);
    if (notifType && notifType.bounceEnabled) {
      threshold = notifType.bounceThreshold;
      cooldown = notifType.bounceCooldown;
    }
  }

  // Check if we should alert
  const shouldAlert =
    newCount >= threshold &&
    (!tracker.alertSentAt || now.getTime() - tracker.alertSentAt.getTime() > cooldown * 1000);

  if (shouldAlert) {
    // Mark that we sent an alert
    await prisma.bounceTracker.update({
      where: { id: tracker.id },
      data: { alertSentAt: now },
    });
  }

  return { shouldAlert, consecutiveFailures: newCount };
}

/**
 * Record a success for a resource.
 * Returns whether the resource was previously in a failed state (for recovery notifications).
 */
export async function recordSuccess(
  resourceType: ResourceType,
  resourceId: string,
  eventType: EventType
): Promise<BounceResult> {
  const now = new Date();

  const tracker = await prisma.bounceTracker.findUnique({
    where: {
      resourceType_resourceId_eventType: { resourceType, resourceId, eventType },
    },
  });

  if (!tracker) {
    return { shouldAlert: false, consecutiveFailures: 0 };
  }

  const wasInFailedState = tracker.consecutiveFailures > 0 && tracker.alertSentAt !== null;

  // Reset the tracker
  await prisma.bounceTracker.update({
    where: { id: tracker.id },
    data: {
      consecutiveFailures: 0,
      lastSuccessAt: now,
      alertSentAt: null, // Reset alert state
    },
  });

  return {
    shouldAlert: false,
    consecutiveFailures: 0,
    wasRecovered: wasInFailedState,
  };
}

/**
 * Get the current failure count for a resource
 */
export async function getFailureCount(
  resourceType: ResourceType,
  resourceId: string,
  eventType: EventType
): Promise<number> {
  const tracker = await prisma.bounceTracker.findUnique({
    where: {
      resourceType_resourceId_eventType: { resourceType, resourceId, eventType },
    },
  });

  return tracker?.consecutiveFailures ?? 0;
}

/**
 * Clear all bounce tracking for a resource (e.g., when deleted)
 */
export async function clearBounceTracking(
  resourceType: ResourceType,
  resourceId: string
): Promise<void> {
  await prisma.bounceTracker.deleteMany({
    where: { resourceType, resourceId },
  });
}
