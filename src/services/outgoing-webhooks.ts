import { createHmac } from 'crypto';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import type { WebhookConfig } from '@prisma/client';
import { getSystemSettings, parseWebhookRetryDelays } from './system-settings.js';
import { safeJsonParse } from '../lib/helpers.js';

interface WebhookConfigInput {
  name: string;
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  typeFilter?: string[];
  environmentIds?: string[];
}

interface WebhookConfigOutput {
  id: string;
  name: string;
  url: string;
  hasSecret: boolean;
  headers: string | null;
  enabled: boolean;
  typeFilter: string | null;
  environmentIds: string | null;
  lastTriggeredAt: Date | null;
  successCount: number;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface WebhookPayload {
  event: string;
  timestamp: string;
  environmentId?: string;
  environmentName?: string;
  data: Record<string, unknown>;
}

// Default values - actual values come from system settings
// const MAX_RETRIES = 3;
// const RETRY_DELAYS = [1000, 5000, 15000]; // ms

/**
 * Convert database record to output format
 */
function toOutput(webhook: WebhookConfig): WebhookConfigOutput {
  return {
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    hasSecret: !!webhook.encryptedSecret,
    headers: webhook.headers,
    enabled: webhook.enabled,
    typeFilter: webhook.typeFilter,
    environmentIds: webhook.environmentIds,
    lastTriggeredAt: webhook.lastTriggeredAt,
    successCount: webhook.successCount,
    failureCount: webhook.failureCount,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  };
}

/**
 * List all webhook configurations
 */
export async function listWebhooks(): Promise<WebhookConfigOutput[]> {
  const webhooks = await prisma.webhookConfig.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return webhooks.map(toOutput);
}

/**
 * Get a webhook configuration by ID
 */
export async function getWebhook(id: string): Promise<WebhookConfigOutput | null> {
  const webhook = await prisma.webhookConfig.findUnique({ where: { id } });
  return webhook ? toOutput(webhook) : null;
}

/**
 * Create a webhook configuration
 */
export async function createWebhook(input: WebhookConfigInput): Promise<WebhookConfigOutput> {
  const data: {
    name: string;
    url: string;
    encryptedSecret?: string;
    secretNonce?: string;
    headers?: string;
    enabled: boolean;
    typeFilter?: string;
    environmentIds?: string;
  } = {
    name: input.name,
    url: input.url,
    enabled: input.enabled ?? true,
  };

  if (input.secret) {
    const { ciphertext, nonce } = encrypt(input.secret);
    data.encryptedSecret = ciphertext;
    data.secretNonce = nonce;
  }

  if (input.headers) {
    data.headers = JSON.stringify(input.headers);
  }

  if (input.typeFilter) {
    data.typeFilter = JSON.stringify(input.typeFilter);
  }

  if (input.environmentIds) {
    data.environmentIds = JSON.stringify(input.environmentIds);
  }

  const webhook = await prisma.webhookConfig.create({ data });
  return toOutput(webhook);
}

/**
 * Update a webhook configuration
 */
export async function updateWebhook(
  id: string,
  input: Partial<WebhookConfigInput>
): Promise<WebhookConfigOutput> {
  const data: Record<string, unknown> = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.url !== undefined) data.url = input.url;
  if (input.enabled !== undefined) data.enabled = input.enabled;

  if (input.secret !== undefined) {
    if (input.secret) {
      const { ciphertext, nonce } = encrypt(input.secret);
      data.encryptedSecret = ciphertext;
      data.secretNonce = nonce;
    } else {
      data.encryptedSecret = null;
      data.secretNonce = null;
    }
  }

  if (input.headers !== undefined) {
    data.headers = input.headers ? JSON.stringify(input.headers) : null;
  }

  if (input.typeFilter !== undefined) {
    data.typeFilter = input.typeFilter ? JSON.stringify(input.typeFilter) : null;
  }

  if (input.environmentIds !== undefined) {
    data.environmentIds = input.environmentIds ? JSON.stringify(input.environmentIds) : null;
  }

  const webhook = await prisma.webhookConfig.update({ where: { id }, data });
  return toOutput(webhook);
}

/**
 * Delete a webhook configuration
 */
export async function deleteWebhook(id: string): Promise<void> {
  await prisma.webhookConfig.delete({ where: { id } });
}

/**
 * Generate HMAC signature for webhook payload
 */
function generateSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Send a webhook with retry logic
 */
async function sendWebhookWithRetry(
  webhook: WebhookConfig,
  payload: WebhookPayload
): Promise<{ success: boolean; error?: string }> {
  // Get settings for retry logic
  const settings = await getSystemSettings();
  const maxRetries = settings.webhookMaxRetries;
  const timeoutMs = settings.webhookTimeoutMs;
  const retryDelays = parseWebhookRetryDelays(settings);

  const payloadString = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'BRIDGEPORT-Webhook/1.0',
  };

  // Add custom headers if configured
  if (webhook.headers) {
    const customHeaders = safeJsonParse(webhook.headers, {} as Record<string, string>);
    Object.assign(headers, customHeaders);
  }

  // Add signature if secret is configured
  if (webhook.encryptedSecret && webhook.secretNonce) {
    const secret = decrypt(webhook.encryptedSecret, webhook.secretNonce);
    const signature = generateSignature(payloadString, secret);
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: payloadString,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        return { success: true };
      }

      lastError = `HTTP ${response.status}: ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';
    }

    // Wait before retry (except on last attempt)
    if (attempt < maxRetries - 1) {
      const delay = retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 5000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: lastError };
}

/**
 * Dispatch webhook to all matching configurations
 */
export async function dispatchWebhook(
  typeCode: string,
  environmentId: string | null,
  data: Record<string, unknown>,
  environmentName?: string
): Promise<Array<{ webhookId: string; success: boolean; error?: string }>> {
  // Get all enabled webhooks
  const webhooks = await prisma.webhookConfig.findMany({
    where: { enabled: true },
  });

  const results: Array<{ webhookId: string; success: boolean; error?: string }> = [];

  for (const webhook of webhooks) {
    // Check type filter
    if (webhook.typeFilter) {
      const allowedTypes = safeJsonParse(webhook.typeFilter, [] as string[]);
      if (!allowedTypes.includes(typeCode)) {
        continue;
      }
    }

    // Check environment filter
    if (webhook.environmentIds && environmentId) {
      const allowedEnvs = safeJsonParse(webhook.environmentIds, [] as string[]);
      if (!allowedEnvs.includes(environmentId)) {
        continue;
      }
    }

    const payload: WebhookPayload = {
      event: typeCode,
      timestamp: new Date().toISOString(),
      environmentId: environmentId || undefined,
      environmentName,
      data,
    };

    const result = await sendWebhookWithRetry(webhook, payload);

    // Update webhook stats
    await prisma.webhookConfig.update({
      where: { id: webhook.id },
      data: {
        lastTriggeredAt: new Date(),
        successCount: result.success ? { increment: 1 } : undefined,
        failureCount: !result.success ? { increment: 1 } : undefined,
      },
    });

    results.push({ webhookId: webhook.id, ...result });
  }

  return results;
}

/**
 * Test a webhook configuration by sending a test payload
 */
export async function testWebhook(id: string): Promise<{ success: boolean; error?: string }> {
  const webhook = await prisma.webhookConfig.findUnique({ where: { id } });
  if (!webhook) {
    return { success: false, error: 'Webhook not found' };
  }

  const payload: WebhookPayload = {
    event: 'test',
    timestamp: new Date().toISOString(),
    data: {
      message: 'This is a test webhook from BRIDGEPORT',
    },
  };

  return sendWebhookWithRetry(webhook, payload);
}
