import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import type { SlackChannel, NotificationType } from '@prisma/client';
import { getSystemSettings } from './system-settings.js';
import { safeJsonParse } from '../lib/helpers.js';

// ==================== Types ====================

interface SlackChannelInput {
  name: string;
  slackChannelName?: string;
  webhookUrl: string;
  isDefault?: boolean;
  enabled?: boolean;
}

interface SlackChannelOutput {
  id: string;
  name: string;
  slackChannelName: string | null;
  hasWebhookUrl: boolean;
  isDefault: boolean;
  enabled: boolean;
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SlackRoutingOutput {
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

interface SlackTextElement {
  type: string;
  text: string;
}

interface SlackButtonElement {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  url?: string;
  style?: string;
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<SlackTextElement | SlackButtonElement>;
  block_id?: string;
}

interface SlackMessage {
  attachments: Array<{
    color: string;
    blocks: SlackBlock[];
  }>;
}

// ==================== Channel Management ====================

function toChannelOutput(channel: SlackChannel): SlackChannelOutput {
  return {
    id: channel.id,
    name: channel.name,
    slackChannelName: channel.slackChannelName,
    hasWebhookUrl: !!channel.webhookUrl,
    isDefault: channel.isDefault,
    enabled: channel.enabled,
    lastTestedAt: channel.lastTestedAt,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

export async function listSlackChannels(): Promise<SlackChannelOutput[]> {
  const channels = await prisma.slackChannel.findMany({
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });
  return channels.map(toChannelOutput);
}

export async function getSlackChannel(id: string): Promise<SlackChannelOutput | null> {
  const channel = await prisma.slackChannel.findUnique({ where: { id } });
  return channel ? toChannelOutput(channel) : null;
}

export async function createSlackChannel(input: SlackChannelInput): Promise<SlackChannelOutput> {
  // If setting as default, unset other defaults
  if (input.isDefault) {
    await prisma.slackChannel.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
  }

  const { ciphertext, nonce } = encrypt(input.webhookUrl);

  const channel = await prisma.slackChannel.create({
    data: {
      name: input.name,
      slackChannelName: input.slackChannelName,
      webhookUrl: ciphertext,
      webhookUrlNonce: nonce,
      isDefault: input.isDefault ?? false,
      enabled: input.enabled ?? true,
    },
  });

  return toChannelOutput(channel);
}

export async function updateSlackChannel(
  id: string,
  input: Partial<SlackChannelInput>
): Promise<SlackChannelOutput> {
  // If setting as default, unset other defaults
  if (input.isDefault) {
    await prisma.slackChannel.updateMany({
      where: { isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
  }

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.slackChannelName !== undefined) data.slackChannelName = input.slackChannelName;
  if (input.isDefault !== undefined) data.isDefault = input.isDefault;
  if (input.enabled !== undefined) data.enabled = input.enabled;

  if (input.webhookUrl !== undefined) {
    const { ciphertext, nonce } = encrypt(input.webhookUrl);
    data.webhookUrl = ciphertext;
    data.webhookUrlNonce = nonce;
  }

  const channel = await prisma.slackChannel.update({ where: { id }, data });
  return toChannelOutput(channel);
}

export async function deleteSlackChannel(id: string): Promise<void> {
  await prisma.slackChannel.delete({ where: { id } });
}

// ==================== Routing Management ====================

export async function listSlackRoutings(): Promise<SlackRoutingOutput[]> {
  const routings = await prisma.slackTypeRouting.findMany({
    include: {
      type: { select: { id: true, code: true, name: true, severity: true } },
      channel: { select: { id: true, name: true } },
    },
    orderBy: [{ type: { name: 'asc' } }],
  });
  return routings;
}

export async function getSlackRoutingsForType(typeId: string): Promise<SlackRoutingOutput[]> {
  const routings = await prisma.slackTypeRouting.findMany({
    where: { typeId },
    include: {
      type: { select: { id: true, code: true, name: true, severity: true } },
      channel: { select: { id: true, name: true } },
    },
  });
  return routings;
}

export async function setSlackRouting(
  typeId: string,
  channelId: string,
  environmentIds?: string[] | null
): Promise<SlackRoutingOutput> {
  const routing = await prisma.slackTypeRouting.upsert({
    where: { typeId_channelId: { typeId, channelId } },
    create: {
      typeId,
      channelId,
      environmentIds: environmentIds ? JSON.stringify(environmentIds) : null,
    },
    update: {
      environmentIds: environmentIds ? JSON.stringify(environmentIds) : null,
    },
    include: {
      type: { select: { id: true, code: true, name: true, severity: true } },
      channel: { select: { id: true, name: true } },
    },
  });
  return routing;
}

export async function deleteSlackRouting(typeId: string, channelId: string): Promise<void> {
  await prisma.slackTypeRouting.delete({
    where: { typeId_channelId: { typeId, channelId } },
  });
}

export async function updateRoutingsForType(
  typeId: string,
  routings: Array<{ channelId: string; environmentIds?: string[] | null }>
): Promise<SlackRoutingOutput[]> {
  // Delete existing routings for this type
  await prisma.slackTypeRouting.deleteMany({ where: { typeId } });

  // Create new routings
  const results: SlackRoutingOutput[] = [];
  for (const routing of routings) {
    const result = await setSlackRouting(typeId, routing.channelId, routing.environmentIds);
    results.push(result);
  }

  return results;
}

// ==================== Block Kit Message Building ====================

function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return '#dc2626'; // red-600
    case 'warning':
      return '#f59e0b'; // amber-500
    case 'info':
    default:
      return '#22c55e'; // green-500
  }
}

function getSeverityEmoji(severity: string): string {
  switch (severity) {
    case 'critical':
      return ':rotating_light:';
    case 'warning':
      return ':warning:';
    case 'info':
    default:
      return ':white_check_mark:';
  }
}

interface NotificationData {
  title: string;
  message: string;
  data: Record<string, unknown>;
  environmentName?: string;
  notificationType: NotificationType;
}

export function buildSlackMessage(
  notification: NotificationData,
  bridgeportUrl?: string
): SlackMessage {
  const { title, message, data, environmentName, notificationType } = notification;
  const color = getSeverityColor(notificationType.severity);
  const emoji = getSeverityEmoji(notificationType.severity);

  const blocks: SlackBlock[] = [];

  // Header
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${emoji} ${title}`,
      emoji: true,
    },
  });

  // Fields section with environment and other context
  const fields: Array<{ type: string; text: string }> = [];

  if (environmentName) {
    fields.push({
      type: 'mrkdwn',
      text: `*Environment:*\n${environmentName}`,
    });
  }

  // Add relevant fields from data
  if (data.serviceName) {
    fields.push({
      type: 'mrkdwn',
      text: `*Service:*\n${data.serviceName}`,
    });
  }

  if (data.serverName) {
    fields.push({
      type: 'mrkdwn',
      text: `*Server:*\n${data.serverName}`,
    });
  }

  if (data.databaseName) {
    fields.push({
      type: 'mrkdwn',
      text: `*Database:*\n${data.databaseName}`,
    });
  }

  if (data.imageTags && Array.isArray(data.imageTags) && (data.imageTags as string[]).length > 0) {
    fields.push({
      type: 'mrkdwn',
      text: `*Tags:*\n${(data.imageTags as string[]).map((t) => `\`${t}\``).join(', ')}`,
    });
  } else if (data.imageTag) {
    fields.push({
      type: 'mrkdwn',
      text: `*Image Tag:*\n\`${data.imageTag}\``,
    });
  }

  if (fields.length > 0) {
    blocks.push({
      type: 'section',
      fields,
    });
  }

  // Action buttons (if BRIDGEPORT URL is configured)
  if (bridgeportUrl) {
    const buttons: SlackBlock['elements'] = [];

    // Determine the best link based on notification type
    const typeCode = notificationType.code;

    if (typeCode.includes('deployment') && data.serviceId) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Service', emoji: true },
        url: `${bridgeportUrl}/services/${data.serviceId}`,
      });
    } else if (typeCode.includes('server') && data.serverId) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Server', emoji: true },
        url: `${bridgeportUrl}/servers/${data.serverId}`,
      });
    } else if (typeCode.includes('backup') && data.databaseId) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Database', emoji: true },
        url: `${bridgeportUrl}/databases/${data.databaseId}`,
      });
    } else if (typeCode.includes('container') && data.serviceId) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Service', emoji: true },
        url: `${bridgeportUrl}/services/${data.serviceId}`,
      });
    } else if (typeCode.includes('health') && data.resourceType === 'service' && data.resourceId) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Service', emoji: true },
        url: `${bridgeportUrl}/services/${data.resourceId}`,
      });
    } else if (typeCode.includes('health') && data.resourceType === 'server' && data.resourceId) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Server', emoji: true },
        url: `${bridgeportUrl}/servers/${data.resourceId}`,
      });
    }

    // Always add a dashboard link
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Open BRIDGEPORT', emoji: true },
      url: bridgeportUrl,
    });

    if (buttons.length > 0) {
      blocks.push({
        type: 'actions',
        elements: buttons,
      });
    }
  }

  // Context block with the notification type code — gives operators a quick
  // way to see which rule fired in Slack without opening BRIDGEPORT.
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Type: \`${notificationType.code}\``,
      },
    ],
  });

  return {
    attachments: [
      {
        color,
        blocks,
      },
    ],
  };
}

// ==================== Sending Notifications ====================

async function sendSlackMessage(
  webhookUrl: string,
  message: SlackMessage
): Promise<{ success: boolean; error?: string }> {
  const settings = await getSystemSettings();
  const timeoutMs = settings.webhookTimeoutMs;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function dispatchSlackNotification(
  notificationType: NotificationType,
  title: string,
  message: string,
  data: Record<string, unknown>,
  environmentId: string | null,
  environmentName?: string
): Promise<Array<{ channelId: string; channelName: string; success: boolean; error?: string }>> {
  // Find matching channels through routing rules
  const routings = await prisma.slackTypeRouting.findMany({
    where: { typeId: notificationType.id },
    include: { channel: true },
  });

  // Filter by environment if applicable
  const matchingRoutings = routings.filter((routing) => {
    if (!routing.channel.enabled) return false;

    // Check environment filter
    if (routing.environmentIds && environmentId) {
      const allowedEnvs = safeJsonParse(routing.environmentIds, [] as string[]);
      if (!allowedEnvs.includes(environmentId)) return false;
    }

    return true;
  });

  // If no specific routings match, use default channel
  let channelsToNotify: SlackChannel[] = matchingRoutings.map((r) => r.channel);

  if (channelsToNotify.length === 0) {
    const defaultChannel = await prisma.slackChannel.findFirst({
      where: { isDefault: true, enabled: true },
    });
    if (defaultChannel) {
      channelsToNotify = [defaultChannel];
    }
  }

  if (channelsToNotify.length === 0) {
    return [];
  }

  // Deduplicate channels
  const uniqueChannels = Array.from(
    new Map(channelsToNotify.map((c) => [c.id, c])).values()
  );

  // Get BRIDGEPORT URL for action buttons (prefer publicUrl over agentCallbackUrl)
  const settings = await getSystemSettings();
  const bridgeportUrl = settings.publicUrl || undefined;

  // Build and send message to each channel
  const results: Array<{ channelId: string; channelName: string; success: boolean; error?: string }> =
    [];

  for (const channel of uniqueChannels) {
    if (!channel.webhookUrl || !channel.webhookUrlNonce) continue;

    const webhookUrl = decrypt(channel.webhookUrl, channel.webhookUrlNonce);
    const slackMessage = buildSlackMessage(
      { title, message, data, environmentName, notificationType },
      bridgeportUrl
    );

    const result = await sendSlackMessage(webhookUrl, slackMessage);
    results.push({
      channelId: channel.id,
      channelName: channel.name,
      ...result,
    });
  }

  return results;
}

// ==================== Testing ====================

export async function testSlackChannel(
  id: string
): Promise<{ success: boolean; error?: string }> {
  const channel = await prisma.slackChannel.findUnique({ where: { id } });
  if (!channel) {
    return { success: false, error: 'Channel not found' };
  }

  if (!channel.webhookUrl || !channel.webhookUrlNonce) {
    return { success: false, error: 'No webhook URL configured' };
  }

  const webhookUrl = decrypt(channel.webhookUrl, channel.webhookUrlNonce);

  // Get BRIDGEPORT URL for action buttons (prefer publicUrl over agentCallbackUrl)
  const settings = await getSystemSettings();
  const bridgeportUrl = settings.publicUrl || undefined;

  const testMessage = buildSlackMessage(
    {
      title: 'Test Notification',
      message: 'This is a test message from BRIDGEPORT to verify your Slack integration is working correctly.',
      data: { isTest: true },
      notificationType: {
        id: 'test',
        code: 'test.message',
        name: 'Test',
        description: 'Test notification',
        template: 'Test message',
        defaultChannels: '[]',
        severity: 'info',
        category: 'system',
        enabled: true,
        bounceEnabled: false,
        bounceThreshold: 3,
        bounceCooldown: 900,
        createdAt: new Date(),
      },
    },
    bridgeportUrl
  );

  const result = await sendSlackMessage(webhookUrl, testMessage);

  // Update last tested timestamp
  if (result.success) {
    await prisma.slackChannel.update({
      where: { id },
      data: { lastTestedAt: new Date() },
    });
  }

  return result;
}
