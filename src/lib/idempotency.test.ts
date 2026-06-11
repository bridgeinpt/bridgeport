import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('./db.js', () => ({
  prisma: {
    idempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from './db.js';
import { Prisma } from '@prisma/client';
import idempotencyPlugin, {
  cleanupExpiredIdempotencyKeys,
  IDEMPOTENCY_RETENTION_MS,
} from './idempotency.js';

const mockPrisma = vi.mocked(prisma, true);

type Hook = (...args: unknown[]) => unknown;

/**
 * Register the plugin against a fake Fastify instance to capture the
 * preHandler/onSend/onResponse hooks so we can drive them directly with fake
 * req/reply.
 */
async function loadHooks(): Promise<{ preHandler: Hook; onSend: Hook; onResponse: Hook }> {
  const hooks: Record<string, Hook> = {};
  const fakeFastify = {
    addHook: (name: string, fn: Hook) => {
      hooks[name] = fn;
    },
  };
  // fastify-plugin wraps the fn; .default is callable with our fake instance.
  await (idempotencyPlugin as unknown as (f: unknown) => Promise<void>)(fakeFastify);
  return { preHandler: hooks.preHandler, onSend: hooks.onSend, onResponse: hooks.onResponse };
}

/**
 * The onSend hook is callback-style (`done(err, payload)`). Drive it and
 * resolve with the payload it forwards to `done`.
 */
function callOnSend(
  onSend: Hook,
  req: unknown,
  reply: unknown,
  payload: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    onSend(req, reply, payload, (err: unknown, p: unknown) =>
      err ? reject(err) : resolve(p)
    );
  });
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'POST',
    url: '/api/environments/env-1/webhooks',
    routeOptions: { url: '/api/environments/:envId/webhooks' },
    headers: { 'idempotency-key': 'key-123' },
    body: { url: 'https://x.test', events: ['plan.completed'] },
    params: { envId: 'env-1' },
    ...overrides,
  };
}

function makeReply() {
  const reply: Record<string, unknown> & { statusCode: number } = {
    statusCode: 200,
    sent: false,
    sentBody: undefined,
    code(this: Record<string, unknown> & { statusCode: number }, c: number) {
      this.statusCode = c;
      return this;
    },
    header(this: unknown) {
      return this;
    },
    send(this: Record<string, unknown>, body: unknown) {
      this.sent = true;
      this.sentBody = body;
      return this;
    },
  };
  return reply;
}

function hashOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('idempotency preHandler', () => {
  it('skips non-POST requests entirely', async () => {
    const { preHandler } = await loadHooks();
    await preHandler(makeRequest({ method: 'GET' }), makeReply());
    expect(mockPrisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('skips POSTs without an Idempotency-Key header', async () => {
    const { preHandler } = await loadHooks();
    await preHandler(makeRequest({ headers: {} }), makeReply());
    expect(mockPrisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it('skips exempt paths (/api/sync/batch)', async () => {
    const { preHandler } = await loadHooks();
    await preHandler(
      makeRequest({ routeOptions: { url: '/api/sync/batch' }, url: '/api/sync/batch' }),
      makeReply()
    );
    expect(mockPrisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it('skips non-JSON/non-object bodies (e.g. multipart upload stream)', async () => {
    const { preHandler } = await loadHooks();
    await preHandler(makeRequest({ body: Buffer.from('binary') }), makeReply());
    expect(mockPrisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('rejects an over-long Idempotency-Key with a VALIDATION_ERROR', async () => {
    const { preHandler } = await loadHooks();
    const longKey = 'a'.repeat(201);
    await expect(
      preHandler(makeRequest({ headers: { 'idempotency-key': longKey } }), makeReply())
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('creates a fresh row when no live key exists', async () => {
    const { preHandler } = await loadHooks();
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyKey.create.mockResolvedValue({ id: 'row-1' } as never);

    const req = makeRequest();
    await preHandler(req, makeReply());

    expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
    const data = (mockPrisma.idempotencyKey.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data).toMatchObject({
      key: 'key-123',
      method: 'POST',
      path: '/api/environments/:envId/webhooks',
      environmentId: 'env-1',
      inProgress: true,
    });
    expect(data.requestHash).toBe(hashOf((req as { body: unknown }).body));
    // expiresAt is ~24h out.
    const ttl = (data.expiresAt as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(IDEMPOTENCY_RETENTION_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(IDEMPOTENCY_RETENTION_MS + 5_000);
  });

  it('short-circuits a replay (same body, finished) with the stored response', async () => {
    const { preHandler } = await loadHooks();
    const body = { url: 'https://x.test', events: ['plan.completed'] };
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: hashOf(body),
      inProgress: false,
      responseStatus: 201,
      responseBody: '{"subscription":{"id":"sub-1"}}',
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    const reply = makeReply();
    await preHandler(makeRequest({ body }), reply);

    // Handler is skipped: a fresh row is never created.
    expect(mockPrisma.idempotencyKey.create).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(201);
    expect(reply.sent).toBe(true);
    expect(reply.sentBody).toBe('{"subscription":{"id":"sub-1"}}');
  });

  it('throws CONFLICT when the same key+body is still in progress', async () => {
    const { preHandler } = await loadHooks();
    const body = { url: 'https://x.test', events: ['plan.completed'] };
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: hashOf(body),
      inProgress: true,
      responseStatus: null,
      responseBody: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    await expect(preHandler(makeRequest({ body }), makeReply())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('throws IDEMPOTENCY_KEY_REUSED when the same key has a different body', async () => {
    const { preHandler } = await loadHooks();
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: hashOf({ different: 'payload' }),
      inProgress: false,
      responseStatus: 201,
      responseBody: '{}',
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    await expect(
      preHandler(makeRequest({ body: { url: 'https://x.test', events: ['plan.completed'] } }), makeReply())
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('treats a P2002 create race as a concurrent CONFLICT', async () => {
    const { preHandler } = await loadHooks();
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyKey.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    await expect(preHandler(makeRequest(), makeReply())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
  });

  it('treats an expired row as absent and creates a new one', async () => {
    const { preHandler } = await loadHooks();
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: hashOf({ stale: true }),
      inProgress: false,
      responseStatus: 201,
      responseBody: '{}',
      expiresAt: new Date(Date.now() - 1_000), // already expired
    } as never);
    mockPrisma.idempotencyKey.create.mockResolvedValue({ id: 'row-new' } as never);

    const reply = makeReply();
    await preHandler(makeRequest(), reply);

    // Expired → no replay, a fresh row is created.
    expect(reply.sent).toBeFalsy();
    expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
  });
});

describe('idempotency onSend (sync capture)', () => {
  it('forwards the payload unchanged via done() and touches no DB', async () => {
    const { onSend } = await loadHooks();
    const out = await callOnSend(onSend, makeRequest(), makeReply(), 'payload');
    expect(out).toBe('payload');
    // onSend must never persist — that is onResponse's job.
    expect(mockPrisma.idempotencyKey.update).not.toHaveBeenCalled();
    expect(mockPrisma.idempotencyKey.delete).not.toHaveBeenCalled();
  });

  it('captures the response status + body onto the fresh-row marker', async () => {
    const { preHandler, onSend, onResponse } = await loadHooks();
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyKey.create.mockResolvedValue({ id: 'row-1' } as never);
    mockPrisma.idempotencyKey.update.mockResolvedValue({} as never);

    const req = makeRequest();
    await preHandler(req, makeReply()); // stashes the fresh-row marker on req

    const reply = makeReply();
    reply.statusCode = 201;
    const body = '{"subscription":{"id":"sub-1"}}';
    const out = await callOnSend(onSend, req, reply, body);
    expect(out).toBe(body); // payload forwarded unchanged

    // The capture is observable via what onResponse subsequently persists.
    await onResponse(req);
    const arg = mockPrisma.idempotencyKey.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where.id).toBe('row-1');
    expect(arg.data).toMatchObject({ inProgress: false, responseStatus: 201, responseBody: body });
  });
});

describe('idempotency onResponse (finalize)', () => {
  it('is a no-op when this request did not create a fresh row', async () => {
    const { onResponse } = await loadHooks();
    await onResponse(makeRequest());
    expect(mockPrisma.idempotencyKey.update).not.toHaveBeenCalled();
    expect(mockPrisma.idempotencyKey.delete).not.toHaveBeenCalled();
  });

  it('persists the response and clears inProgress on a 2xx', async () => {
    const { preHandler, onSend, onResponse } = await loadHooks();
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyKey.create.mockResolvedValue({ id: 'row-1' } as never);
    mockPrisma.idempotencyKey.update.mockResolvedValue({} as never);

    const req = makeRequest();
    await preHandler(req, makeReply());

    const reply = makeReply();
    reply.statusCode = 201;
    const body = '{"subscription":{"id":"sub-1"}}';
    await callOnSend(onSend, req, reply, body);
    await onResponse(req);

    const arg = mockPrisma.idempotencyKey.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where.id).toBe('row-1');
    expect(arg.data).toMatchObject({ inProgress: false, responseStatus: 201, responseBody: body });
  });

  it('deletes the row on a non-2xx so the key can be retried', async () => {
    const { preHandler, onSend, onResponse } = await loadHooks();
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyKey.create.mockResolvedValue({ id: 'row-1' } as never);
    mockPrisma.idempotencyKey.delete.mockResolvedValue({} as never);

    const req = makeRequest();
    await preHandler(req, makeReply());

    const reply = makeReply();
    reply.statusCode = 500;
    await callOnSend(onSend, req, reply, 'boom');
    await onResponse(req);

    expect(mockPrisma.idempotencyKey.update).not.toHaveBeenCalled();
    expect(mockPrisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
  });

  it('finalizes the fresh row only once even if onResponse fires twice', async () => {
    const { preHandler, onSend, onResponse } = await loadHooks();
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyKey.create.mockResolvedValue({ id: 'row-1' } as never);
    mockPrisma.idempotencyKey.update.mockResolvedValue({} as never);

    const req = makeRequest();
    await preHandler(req, makeReply());

    const reply = makeReply();
    reply.statusCode = 200;
    await callOnSend(onSend, req, reply, 'a');
    await onResponse(req);
    await onResponse(req); // second invocation must be a no-op

    expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledTimes(1);
  });
});

describe('cleanupExpiredIdempotencyKeys', () => {
  it('deletes rows whose expiry is in the past and returns the count', async () => {
    mockPrisma.idempotencyKey.deleteMany.mockResolvedValue({ count: 7 } as never);

    const before = Date.now();
    const count = await cleanupExpiredIdempotencyKeys();
    const after = Date.now();

    expect(count).toBe(7);
    const where = (mockPrisma.idempotencyKey.deleteMany.mock.calls[0][0] as {
      where: { expiresAt: { lt: Date } };
    }).where;
    const cutoff = where.expiresAt.lt.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
  });
});
