import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../lib/db.js', () => ({
  prisma: {
    webhookSubscription: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    webhookDelivery: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue({ ciphertext: 'enc-ciphertext', nonce: 'enc-nonce' }),
  // Default: decrypt yields the real secret used to compute the expected HMAC.
  decrypt: vi.fn().mockReturnValue('shhh-secret'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import {
  createWebhookSubscription,
  areValidEvents,
  emitWebhookEvent,
  deliverPending,
  cleanupOldDeliveries,
  SIGNATURE_HEADER,
} from './webhook-subscriptions.js';

const mockPrisma = vi.mocked(prisma, true);
const mockEncrypt = vi.mocked(encrypt);
const mockDecrypt = vi.mocked(decrypt);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  // Restore default crypto behavior (clearAllMocks wipes implementations).
  mockEncrypt.mockReturnValue({ ciphertext: 'enc-ciphertext', nonce: 'enc-nonce' });
  mockDecrypt.mockReturnValue('shhh-secret');
});

describe('createWebhookSubscription', () => {
  it('encrypts the secret and returns hasSecret=true without exposing it', async () => {
    mockPrisma.webhookSubscription.create.mockResolvedValue({
      id: 'sub-1',
      environmentId: 'env-1',
      url: 'https://hook.example.com',
      encryptedSecret: 'enc-ciphertext',
      secretNonce: 'enc-nonce',
      events: JSON.stringify(['deployment.completed']),
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const out = await createWebhookSubscription('env-1', {
      url: 'https://hook.example.com',
      secret: 'shhh-secret',
      events: ['deployment.completed'],
    });

    // Secret was encrypted at rest.
    expect(mockEncrypt).toHaveBeenCalledWith('shhh-secret');
    const createArg = mockPrisma.webhookSubscription.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.encryptedSecret).toBe('enc-ciphertext');
    expect(createArg.data.secretNonce).toBe('enc-nonce');

    // Output never leaks any secret material.
    expect(out.hasSecret).toBe(true);
    expect(out).not.toHaveProperty('secret');
    expect(out).not.toHaveProperty('encryptedSecret');
    expect(out).not.toHaveProperty('secretNonce');
    expect(out.events).toEqual(['deployment.completed']);
  });

  it('does not encrypt and reports hasSecret=false when no secret given', async () => {
    mockPrisma.webhookSubscription.create.mockResolvedValue({
      id: 'sub-2',
      environmentId: 'env-1',
      url: 'https://hook.example.com',
      encryptedSecret: null,
      secretNonce: null,
      events: JSON.stringify(['plan.failed']),
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const out = await createWebhookSubscription('env-1', {
      url: 'https://hook.example.com',
      events: ['plan.failed'],
    });

    expect(mockEncrypt).not.toHaveBeenCalled();
    const createArg = mockPrisma.webhookSubscription.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.encryptedSecret).toBeUndefined();
    expect(createArg.data.secretNonce).toBeUndefined();
    expect(out.hasSecret).toBe(false);
  });
});

describe('areValidEvents', () => {
  it('rejects an empty array', () => {
    expect(areValidEvents([])).toBe(false);
  });

  it('rejects unknown event codes', () => {
    expect(areValidEvents(['deployment.completed', 'not.a.real.event'])).toBe(false);
    expect(areValidEvents(['totally.bogus'])).toBe(false);
  });

  it('accepts a valid subset of the canonical events', () => {
    expect(areValidEvents(['deployment.completed'])).toBe(true);
    expect(areValidEvents(['plan.completed', 'backup.failed', 'sync.completed'])).toBe(true);
  });
});

describe('emitWebhookEvent', () => {
  it('enqueues deliveries only for enabled subs whose events include the code', async () => {
    // findMany already filters enabled:true at the DB layer; the service then
    // filters by event membership in JS.
    mockPrisma.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-a', events: JSON.stringify(['deployment.completed', 'plan.failed']) },
      { id: 'sub-b', events: JSON.stringify(['backup.completed']) }, // no match
      { id: 'sub-c', events: JSON.stringify(['deployment.completed']) },
    ] as never);
    mockPrisma.webhookDelivery.createMany.mockResolvedValue({ count: 2 } as never);

    await emitWebhookEvent('deployment.completed', 'env-1', { service: 'web' });

    // Only enabled subs were queried.
    expect(mockPrisma.webhookSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { environmentId: 'env-1', enabled: true } })
    );

    expect(mockPrisma.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.webhookDelivery.createMany.mock.calls[0][0] as {
      data: Array<{ subscriptionId: string; event: string; payload: string; status: string }>;
    };
    // Only sub-a and sub-c match the emitted event.
    expect(arg.data.map((d) => d.subscriptionId).sort()).toEqual(['sub-a', 'sub-c']);
    expect(arg.data.every((d) => d.event === 'deployment.completed')).toBe(true);
    expect(arg.data.every((d) => d.status === 'pending')).toBe(true);
    // Payload carries the canonical envelope shape.
    const parsed = JSON.parse(arg.data[0].payload);
    expect(parsed).toMatchObject({
      event: 'deployment.completed',
      environmentId: 'env-1',
      data: { service: 'web' },
    });
  });

  it('enqueues nothing when no subscription matches the event', async () => {
    mockPrisma.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-b', events: JSON.stringify(['backup.completed']) },
    ] as never);

    await emitWebhookEvent('deployment.completed', 'env-1', {});

    expect(mockPrisma.webhookDelivery.createMany).not.toHaveBeenCalled();
  });

  it('never throws when prisma rejects (fire-and-forget contract)', async () => {
    mockPrisma.webhookSubscription.findMany.mockRejectedValue(new Error('db down'));

    await expect(
      emitWebhookEvent('deployment.failed', 'env-1', {})
    ).resolves.toBeUndefined();
  });
});

/** Build a due-delivery row as returned by deliverPending's findMany include. */
function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    subscriptionId: 'sub-1',
    event: 'deployment.completed',
    payload: JSON.stringify({ event: 'deployment.completed', data: { ok: true } }),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    responseStatus: null,
    createdAt: new Date(),
    deliveredAt: null,
    subscription: {
      url: 'https://hook.example.com',
      enabled: true,
      encryptedSecret: 'enc-ciphertext',
      secretNonce: 'enc-nonce',
    },
    ...overrides,
  };
}

describe('deliverPending', () => {
  it('POSTs a due row with an independently-verifiable HMAC signature header', async () => {
    const payload = JSON.stringify({ event: 'deployment.completed', data: { ok: true } });
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([
      dueRow({ payload }),
    ] as never);
    mockPrisma.webhookDelivery.update.mockResolvedValue({} as never);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await deliverPending();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://hook.example.com');
    expect(init.body).toBe(payload);

    // Compute the expected HMAC independently from the decrypted secret.
    const expected = 'sha256=' + createHmac('sha256', 'shhh-secret').update(payload).digest('hex');
    expect(init.headers[SIGNATURE_HEADER]).toBe(expected);
  });

  it('marks a row delivered on a 2xx response', async () => {
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow()] as never);
    mockPrisma.webhookDelivery.update.mockResolvedValue({} as never);
    mockFetch.mockResolvedValue({ ok: true, status: 202 });

    await deliverPending();

    const updateArg = mockPrisma.webhookDelivery.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArg.where.id).toBe('del-1');
    expect(updateArg.data.status).toBe('delivered');
    expect(updateArg.data.attempts).toBe(1);
    expect(updateArg.data.responseStatus).toBe(202);
    expect(updateArg.data.nextAttemptAt).toBeNull();
    expect(updateArg.data.deliveredAt).toBeInstanceOf(Date);
  });

  it('marks failed with backoff and incremented attempts on a non-2xx response', async () => {
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([
      dueRow({ attempts: 1 }),
    ] as never);
    mockPrisma.webhookDelivery.update.mockResolvedValue({} as never);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const before = Date.now();
    await deliverPending();

    const data = (mockPrisma.webhookDelivery.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('failed');
    expect(data.attempts).toBe(2);
    expect(data.responseStatus).toBe(500);
    expect(data.lastError).toBe('HTTP 500');
    // Below the cap → a future nextAttemptAt is set (backoff).
    expect(data.nextAttemptAt).toBeInstanceOf(Date);
    expect((data.nextAttemptAt as Date).getTime()).toBeGreaterThan(before);
  });

  it('marks the last attempt terminal (nextAttemptAt null) at the cap', async () => {
    // attempts=4 → this attempt becomes 5, which is MAX_DELIVERY_ATTEMPTS.
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([
      dueRow({ attempts: 4 }),
    ] as never);
    mockPrisma.webhookDelivery.update.mockResolvedValue({} as never);
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await deliverPending();

    const data = (mockPrisma.webhookDelivery.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('failed');
    expect(data.attempts).toBe(5);
    expect(data.nextAttemptAt).toBeNull();
  });

  it('marks failed (not crash) when the signing secret cannot be decrypted', async () => {
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow()] as never);
    mockPrisma.webhookDelivery.update.mockResolvedValue({} as never);
    mockDecrypt.mockImplementation(() => {
      throw new Error('bad key');
    });

    await expect(deliverPending()).resolves.toBeUndefined();

    // Never attempted the POST; recorded a decrypt failure on the row instead.
    expect(mockFetch).not.toHaveBeenCalled();
    const data = (mockPrisma.webhookDelivery.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('failed');
    expect(data.lastError).toMatch(/decrypt/i);
  });

  it('isolates a single throwing row so the sweep does not abort', async () => {
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([
      dueRow({ id: 'del-bad' }),
      dueRow({ id: 'del-good' }),
    ] as never);
    // First update (for del-bad delivered path) throws; second must still run.
    mockPrisma.webhookDelivery.update
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue({} as never);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await expect(deliverPending()).resolves.toBeUndefined();

    // Both rows were attempted (fetch fired twice); the loop survived the throw
    // on del-bad's first update and went on to process del-good.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('guards against overlapping sweeps (a concurrent call returns early)', async () => {
    // Hold the first sweep open on findMany so the second call sees delivering=true.
    let release: (rows: unknown[]) => void = () => {};
    const gate = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    mockPrisma.webhookDelivery.findMany.mockReturnValueOnce(gate as never);

    const first = deliverPending();
    // Second call while the first is still in flight must short-circuit.
    await deliverPending();
    expect(mockPrisma.webhookDelivery.findMany).toHaveBeenCalledTimes(1);

    release([]);
    await first;
  });
});

describe('cleanupOldDeliveries', () => {
  it('deletes only delivered/failed rows older than the cutoff', async () => {
    mockPrisma.webhookDelivery.deleteMany.mockResolvedValue({ count: 3 } as never);

    const before = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const count = await cleanupOldDeliveries(30);
    const after = Date.now() - 30 * 24 * 60 * 60 * 1000;

    expect(count).toBe(3);
    const where = (mockPrisma.webhookDelivery.deleteMany.mock.calls[0][0] as {
      where: { status: { in: string[] }; createdAt: { lt: Date } };
    }).where;
    expect(where.status.in.sort()).toEqual(['delivered', 'failed']);
    const cutoff = where.createdAt.lt.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
  });
});
