/**
 * Env-scoped webhook subscriptions with signed, background-retried deliveries
 * (issue #126).
 *
 * This is a SEPARATE system from `src/services/outgoing-webhooks.ts`
 * (WebhookConfig). That one is the global, admin-scoped notification fan-out
 * using header `X-Webhook-Signature`. This one is per-environment, exposes a
 * delivery history, and signs with `X-BridgePort-Signature`. The two share no
 * code or models on purpose.
 *
 * Lifecycle:
 *   1. A terminal event (deploy/plan/backup/sync) calls `emitWebhookEvent`,
 *      which enqueues one WebhookDelivery row (status=pending) per matching
 *      enabled subscription and kicks `deliverPending()` via setImmediate.
 *   2. The scheduler also calls `deliverPending()` on a short interval so
 *      deliveries land within a few seconds even if the kick is missed.
 *   3. `deliverPending()` POSTs each due row, retrying with exponential backoff
 *      until a 2xx (delivered) or the attempt cap (failed, terminal).
 */

import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { safeJsonParse, getErrorMessage } from '../lib/helpers.js';
import { config } from '../lib/config.js';
import type { WebhookSubscription, WebhookDelivery } from '@prisma/client';

/**
 * Canonical set of event codes a subscription may listen for. The route layer
 * validates requested events against this list, and emitters reference these
 * constants so a typo fails at compile time.
 */
export const WEBHOOK_EVENTS = [
  'deployment.completed',
  'deployment.failed',
  'plan.completed',
  'plan.failed',
  'plan.rolled_back',
  'backup.completed',
  'backup.failed',
  'sync.completed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const WEBHOOK_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

/** Max delivery attempts before a delivery is marked failed (terminal). */
const MAX_DELIVERY_ATTEMPTS = config.WEBHOOK_DELIVERY_MAX_ATTEMPTS;

/** Per-request HTTP timeout for an outbound delivery POST. */
const DELIVERY_TIMEOUT_MS = config.WEBHOOK_DELIVERY_TIMEOUT_MS;

/** How many due deliveries to process per `deliverPending()` sweep. */
const DELIVERY_BATCH_SIZE = config.WEBHOOK_DELIVERY_BATCH_SIZE;

/** Signature header sent with every delivery (HMAC-SHA256, hex). */
export const SIGNATURE_HEADER = 'X-BridgePort-Signature';

// Guard against overlapping sweeps (the scheduler interval + the setImmediate
// kick on enqueue could otherwise run concurrently and double-POST a row).
let delivering = false;

/** Max concurrent deliveries per sweep — bounds a sweep to ~one timeout, not N. */
const DELIVERY_CONCURRENCY = config.WEBHOOK_DELIVERY_CONCURRENCY;

/**
 * SSRF guard: is `ip` (a literal IPv4/IPv6 address) in a loopback, private,
 * link-local, or otherwise non-routable range? Covers the cloud metadata
 * endpoint (169.254.169.254 falls in link-local) and IPv6-mapped IPv4.
 */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) {
    // The WHATWG URL parser may have already stripped brackets, and the address
    // may be hex-compressed (`::ffff:7f00:1`) or dotted (`::ffff:127.0.0.1`).
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    // Unique local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;

    // IPv4-mapped (::ffff:x), IPv4-compatible (::x), and any other form that
    // embeds a v4 in the low 32 bits. These can SSRF-bypass a naive dotted-only
    // check because Node normalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`. Decode
    // the embedded IPv4 from EITHER the dotted-decimal or the hex-quartet form
    // and range-check it. If it looks like such an address but cannot be cleanly
    // decoded, fail closed (block) rather than allow.
    const embedsV4 =
      lower.startsWith('::ffff:') || lower.startsWith('::') || lower.includes('.');
    if (embedsV4) {
      const v4 = embeddedIpv4(lower);
      if (v4 === null) return true; // undecodable but v4-shaped → fail closed
      return isBlockedIpv4(v4);
    }
    return false;
  }
  return false;
}

/**
 * Decode the IPv4 embedded in the low 32 bits of an IPv4-mapped / IPv4-compatible
 * IPv6 literal, accepting BOTH the dotted-decimal tail (`::ffff:127.0.0.1`) and
 * the hex-quartet tail (`::ffff:7f00:1` → 127.0.0.1). Returns the dotted-decimal
 * IPv4 string, or null when it cannot be cleanly decoded. `host` must be
 * lower-cased and bracket-stripped.
 */
function embeddedIpv4(host: string): string | null {
  // Dotted-decimal tail: `::ffff:a.b.c.d` or `::a.b.c.d`.
  const dotted = host.match(/^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];

  // Hex-quartet tail: `::ffff:HHHH:HHHH`, `::ffff:0:HHHH:HHHH`, or `::HHHH:HHHH`.
  const hex = host.match(/^::(?:ffff:(?:0:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed — block to be safe
  }
  const [a, b] = parts;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl. metadata)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/**
 * Reject a webhook destination that targets internal/loopback/link-local/
 * metadata infrastructure. Blocks non-http(s) schemes, `localhost`/`*.local`,
 * and any literal IP in a non-routable range. For hostnames, resolve via DNS and
 * range-check every returned address (so a public name pointing at an internal
 * IP is also blocked). Returns true when the URL must NOT be delivered to.
 */
export async function isBlockedWebhookHost(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // unparseable — block
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

  let host = parsed.hostname.toLowerCase();
  // IPv6 literals arrive bracketed in URL.hostname on some runtimes; strip them.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost' || host === 'localhost.localdomain') return true;
  if (host.endsWith('.local')) return true;

  // Literal IP — range-check directly, no DNS needed.
  if (isIP(host) !== 0) return isBlockedIp(host);

  // Hostname — resolve and range-check every address. A DNS failure (NXDOMAIN,
  // timeout) is NOT treated as blocked: an unresolvable host is not an SSRF
  // target (it points at nothing internal), and the delivery fetch will simply
  // fail on its own. We only block when an address actually lands in a
  // non-routable range — so a public name pointing at an internal IP is caught.
  try {
    const records = await dnsLookup(host, { all: true });
    return records.some((r) => isBlockedIp(r.address));
  } catch {
    return false;
  }
}

/** Public-facing shape — NEVER includes the decrypted secret. */
export interface WebhookSubscriptionOutput {
  id: string;
  environmentId: string;
  url: string;
  events: string[];
  hasSecret: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Convert a DB row to the safe output shape (no secret material). */
function toOutput(sub: WebhookSubscription): WebhookSubscriptionOutput {
  return {
    id: sub.id,
    environmentId: sub.environmentId,
    url: sub.url,
    events: safeJsonParse(sub.events, [] as string[]),
    hasSecret: !!sub.encryptedSecret,
    enabled: sub.enabled,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

/** True when every supplied event code is in the canonical set. */
export function areValidEvents(events: string[]): boolean {
  return events.length > 0 && events.every((e) => WEBHOOK_EVENT_SET.has(e));
}

export interface CreateSubscriptionInput {
  url: string;
  secret?: string;
  events: string[];
  enabled?: boolean;
}

/** Create a subscription. The signing secret is encrypted at rest. */
export async function createWebhookSubscription(
  environmentId: string,
  input: CreateSubscriptionInput
): Promise<WebhookSubscriptionOutput> {
  // SSRF guard: refuse a destination that targets internal/loopback/metadata
  // infrastructure. The route layer maps the thrown error to a 400.
  if (await isBlockedWebhookHost(input.url)) {
    throw new Error(
      'Webhook URL targets a private, loopback, link-local, or metadata address, which is not allowed'
    );
  }

  const data: {
    environmentId: string;
    url: string;
    events: string;
    enabled: boolean;
    encryptedSecret?: string;
    secretNonce?: string;
  } = {
    environmentId,
    url: input.url,
    events: JSON.stringify(input.events),
    enabled: input.enabled ?? true,
  };

  if (input.secret) {
    const { ciphertext, nonce } = encrypt(input.secret);
    data.encryptedSecret = ciphertext;
    data.secretNonce = nonce;
  }

  const sub = await prisma.webhookSubscription.create({ data });
  return toOutput(sub);
}

/** List subscriptions for an environment (newest first). */
export async function listWebhookSubscriptions(
  environmentId: string
): Promise<WebhookSubscriptionOutput[]> {
  const subs = await prisma.webhookSubscription.findMany({
    where: { environmentId },
    orderBy: { createdAt: 'desc' },
  });
  return subs.map(toOutput);
}

/**
 * Get one subscription scoped to its environment. Returns null when missing or
 * owned by a different environment (so callers return 404, never leak cross-env
 * existence).
 */
export async function getWebhookSubscription(
  environmentId: string,
  id: string
): Promise<WebhookSubscriptionOutput | null> {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id } });
  if (!sub || sub.environmentId !== environmentId) return null;
  return toOutput(sub);
}

/**
 * Delete a subscription scoped to its environment. Returns false when missing
 * or cross-env (caller returns 404). Deliveries cascade-delete via the FK.
 */
export async function deleteWebhookSubscription(
  environmentId: string,
  id: string
): Promise<boolean> {
  const sub = await prisma.webhookSubscription.findUnique({
    where: { id },
    select: { id: true, environmentId: true },
  });
  if (!sub || sub.environmentId !== environmentId) return false;
  await prisma.webhookSubscription.delete({ where: { id } });
  return true;
}

export interface DeliveryListResult {
  deliveries: Array<{
    id: string;
    event: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date | null;
    lastError: string | null;
    responseStatus: number | null;
    createdAt: Date;
    deliveredAt: Date | null;
  }>;
  total: number;
}

/** Paginated delivery history for a subscription (newest first). */
export async function listWebhookDeliveries(
  subscriptionId: string,
  options: { limit: number; offset: number }
): Promise<DeliveryListResult> {
  const [deliveries, total] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: 'desc' },
      take: options.limit,
      skip: options.offset,
      // Never expose `payload` in the listing — it can contain sensitive data
      // and the row count would otherwise balloon the response.
      select: {
        id: true,
        event: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        lastError: true,
        responseStatus: true,
        createdAt: true,
        deliveredAt: true,
      },
    }),
    prisma.webhookDelivery.count({ where: { subscriptionId } }),
  ]);
  return { deliveries, total };
}

/**
 * Enqueue a webhook event for every enabled subscription in `environmentId`
 * whose `events` array includes `event`. Fire-and-forget safe: this NEVER
 * throws into the caller (terminal deploy/backup/etc. paths must not break if
 * webhook bookkeeping fails). After enqueue it kicks an async delivery sweep.
 */
export async function emitWebhookEvent(
  event: WebhookEvent,
  environmentId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const subs = await prisma.webhookSubscription.findMany({
      where: { environmentId, enabled: true },
      select: { id: true, events: true },
    });

    const matching = subs.filter((s) =>
      safeJsonParse(s.events, [] as string[]).includes(event)
    );
    if (matching.length === 0) return;

    // The signed body the subscriber receives. Stored verbatim so the signature
    // computed at delivery time matches exactly what we persist.
    const body = JSON.stringify({
      event,
      environmentId,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    const now = new Date();
    await prisma.webhookDelivery.createMany({
      data: matching.map((s) => ({
        subscriptionId: s.id,
        event,
        payload: body,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
      })),
    });

    // Kick a sweep so deliveries land promptly without waiting for the
    // scheduler interval. Errors are swallowed — the interval is the backstop.
    setImmediate(() => {
      deliverPending().catch((err) => {
        console.error('[Webhooks] deliverPending (kick) failed:', err);
      });
    });
  } catch (err) {
    // Fire-and-forget contract: log, never propagate.
    console.error(`[Webhooks] emitWebhookEvent(${event}) failed:`, err);
  }
}

/** Exponential backoff (ms) for retry attempt N (1-based): 5s,10s,20s,40s,… */
function backoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** (attempts - 1), 5 * 60 * 1000);
}

/**
 * Deliver all due deliveries: status in (pending|failed), nextAttemptAt <= now,
 * attempts < MAX. POSTs the stored payload with an HMAC-SHA256 signature header.
 * Self-guards against overlapping runs. Per-row failures (including decrypt
 * failures) are isolated — one bad row never aborts the sweep.
 */
export async function deliverPending(): Promise<void> {
  if (delivering) return;
  delivering = true;
  try {
    const now = new Date();
    const due = await prisma.webhookDelivery.findMany({
      where: {
        status: { in: ['pending', 'failed'] },
        attempts: { lt: MAX_DELIVERY_ATTEMPTS },
        nextAttemptAt: { lte: now },
      },
      orderBy: { createdAt: 'asc' },
      take: DELIVERY_BATCH_SIZE,
      include: {
        subscription: {
          select: {
            url: true,
            enabled: true,
            encryptedSecret: true,
            secretNonce: true,
          },
        },
      },
    });

    // Process the batch with bounded concurrency so one hung subscriber (up to
    // DELIVERY_TIMEOUT_MS) can't head-of-line-block every other due delivery.
    // deliverOne isolates per-row failures and persists its own outcome, so
    // concurrent execution is safe.
    const queue = [...due];
    const runWorker = async (): Promise<void> => {
      for (;;) {
        const delivery = queue.shift();
        if (!delivery) return;
        await deliverOne(delivery).catch((err) => {
          // deliverOne already records failures on the row; this catch is a
          // last-resort guard so a single throw never aborts the worker.
          console.error(`[Webhooks] delivery ${delivery.id} threw:`, err);
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DELIVERY_CONCURRENCY, due.length) }, runWorker)
    );
  } finally {
    delivering = false;
  }
}

type DueDelivery = WebhookDelivery & {
  subscription: {
    url: string;
    enabled: boolean;
    encryptedSecret: string | null;
    secretNonce: string | null;
  };
};

/** Attempt a single delivery and persist the outcome. */
async function deliverOne(delivery: DueDelivery): Promise<void> {
  const sub = delivery.subscription;

  // A disabled subscription's queued deliveries are abandoned (terminal).
  if (!sub.enabled) {
    await markFailed(delivery.id, delivery.attempts + 1, 'Subscription disabled');
    return;
  }

  // SSRF guard at delivery time: the host may have been safe at create time but
  // now resolve (via DNS) to an internal address. Re-check before POSTing.
  if (await isBlockedWebhookHost(sub.url)) {
    await markFailed(
      delivery.id,
      delivery.attempts + 1,
      'Destination resolves to a blocked (private/loopback/link-local/metadata) address'
    );
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'BridgePort-Webhook/1.0',
    'X-BridgePort-Event': delivery.event,
    'X-BridgePort-Delivery': delivery.id,
  };

  // Sign with the decrypted secret if one is configured. A decrypt failure must
  // not crash the loop — record it as a (retryable until cap) failure instead.
  if (sub.encryptedSecret && sub.secretNonce) {
    let secret: string;
    try {
      secret = decrypt(sub.encryptedSecret, sub.secretNonce);
    } catch {
      await markFailed(
        delivery.id,
        delivery.attempts + 1,
        'Failed to decrypt signing secret'
      );
      return;
    }
    const signature = createHmac('sha256', secret).update(delivery.payload).digest('hex');
    headers[SIGNATURE_HEADER] = `sha256=${signature}`;
  }

  try {
    const response = await fetch(sub.url, {
      method: 'POST',
      headers,
      body: delivery.payload,
      // Do NOT auto-follow redirects: a 3xx could point at internal
      // infrastructure (SSRF). It instead falls through as a non-2xx failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (response.ok) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'delivered',
          attempts: delivery.attempts + 1,
          responseStatus: response.status,
          deliveredAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
        },
      });
      return;
    }

    await markFailed(
      delivery.id,
      delivery.attempts + 1,
      `HTTP ${response.status}`,
      response.status
    );
  } catch (err) {
    await markFailed(delivery.id, delivery.attempts + 1, getErrorMessage(err, 'Request failed'));
  }
}

/**
 * Record a failed attempt. Below the cap → status=failed with a backoff
 * nextAttemptAt (retryable). At/above the cap → terminal failed (no more
 * retries; nextAttemptAt cleared).
 */
async function markFailed(
  id: string,
  attempts: number,
  error: string,
  responseStatus?: number
): Promise<void> {
  const terminal = attempts >= MAX_DELIVERY_ATTEMPTS;
  await prisma.webhookDelivery.update({
    where: { id },
    data: {
      status: 'failed',
      attempts,
      lastError: error,
      responseStatus: responseStatus ?? null,
      nextAttemptAt: terminal ? null : new Date(Date.now() + backoffMs(attempts)),
    },
  });
}

/**
 * Delete delivered/failed deliveries older than `retentionDays`. Pending and
 * still-retrying rows are never touched. Returns the deleted count.
 */
export async function cleanupOldDeliveries(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await prisma.webhookDelivery.deleteMany({
    where: {
      status: { in: ['delivered', 'failed'] },
      createdAt: { lt: cutoff },
    },
  });
  return result.count;
}
