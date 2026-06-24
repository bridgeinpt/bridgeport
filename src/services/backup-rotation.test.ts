import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// GFS backup-rotation unit tests (issue #291 §14 — pure selection logic).
//
// These exercise the pure, Prisma-free helpers from database-backup.ts plus
// resolveRetentionPolicy (Prisma + SystemSettings mocked). Runs under the UNIT
// config (config/vitest.unit.config.ts: src/services/**, mocked db, isolate:true).
//
// The mock factories below mirror what the module imports at load time so the
// pure helpers can be imported without dragging in real Prisma / SSH / S3.
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    backupRetentionPolicy: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({ prisma: mockPrisma }));

// system-settings is consulted by resolveRetentionPolicy for the inherited path.
const { mockGetSystemSettings } = vi.hoisted(() => ({
  mockGetSystemSettings: vi.fn(),
}));
vi.mock('./system-settings.js', () => ({ getSystemSettings: mockGetSystemSettings }));

// These modules are imported by database-backup.ts but unused by the helpers
// under test; stub them so import resolves cleanly under isolate:true.
vi.mock('../lib/crypto.js', () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock('../lib/ssh.js', () => ({
  SSHClient: vi.fn(),
  LocalClient: vi.fn(),
  isLocalhost: vi.fn(),
  shellEscape: (s: string) => s,
}));
vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn(),
  getEnvironmentSpacesConfig: vi.fn(),
}));
vi.mock('./notifications.js', () => ({
  sendSystemNotification: vi.fn(),
  NOTIFICATION_TYPES: {},
}));
vi.mock('./webhook-subscriptions.js', () => ({ emitWebhookEvent: vi.fn() }));
vi.mock('./audit.js', () => ({ logAudit: vi.fn() }));

import {
  periodKey,
  selectPeriodTier,
  selectKeep,
  applyFloor,
  applySizeCap,
  resolveRetentionPolicy,
  PRESETS,
  RETENTION_BOUNDS,
  type RetentionPolicy,
  type RotationCandidate,
} from './database-backup.js';

const UTC = 'UTC';
const LA = 'America/Los_Angeles';

/** Build a RotationCandidate. `size` defaults to 1n. */
function cand(id: string, iso: string, size: bigint = 1n): RotationCandidate {
  return { id, createdAt: new Date(iso), size };
}

/** A policy with all tiers off except what's overridden (minFloor defaults 1). */
function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return { keepLast: 0, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1, ...overrides };
}

describe('periodKey', () => {
  it('produces day / month / year keys for a UTC date', () => {
    const d = new Date('2026-06-22T12:00:00Z');
    expect(periodKey(d, 'day', UTC)).toBe('2026-06-22');
    expect(periodKey(d, 'month', UTC)).toBe('2026-06');
    expect(periodKey(d, 'year', UTC)).toBe('2026');
  });

  it('zero-pads month and day', () => {
    const d = new Date('2026-01-05T00:00:00Z');
    expect(periodKey(d, 'day', UTC)).toBe('2026-01-05');
    expect(periodKey(d, 'month', UTC)).toBe('2026-01');
  });

  describe('ISO week (Monday start) — year boundaries', () => {
    // Cases asserted verbatim from issue #291 §14.
    const cases: Array<[string, string]> = [
      ['2021-01-01T12:00:00Z', '2020-W53'], // Fri belongs to prev year's W53
      ['2021-01-04T12:00:00Z', '2021-W01'], // Mon — first ISO week of 2021
      ['2019-12-30T12:00:00Z', '2020-W01'], // Mon — already in 2020's W01
      ['2016-01-01T12:00:00Z', '2015-W53'],
      ['2023-01-01T12:00:00Z', '2022-W52'],
      ['2024-12-30T12:00:00Z', '2025-W01'],
      ['2026-06-22T12:00:00Z', '2026-W26'],
    ];
    for (const [iso, expected] of cases) {
      it(`${iso} → ${expected}`, () => {
        expect(periodKey(new Date(iso), 'week', UTC)).toBe(expected);
      });
    }
  });

  describe('timezone bucketing', () => {
    it('buckets a ~00:30 UTC backup to the previous calendar day under America/Los_Angeles', () => {
      // 00:30 UTC on Jun 22 == 17:30 PDT on Jun 21 (UTC-7 in summer).
      const d = new Date('2026-06-22T00:30:00Z');
      expect(periodKey(d, 'day', LA)).toBe('2026-06-21');
      // Same instant lands on Jun 22 under UTC.
      expect(periodKey(d, 'day', UTC)).toBe('2026-06-22');
    });

    it('buckets a ~01:30 UTC backup to the previous day under LA too', () => {
      const d = new Date('2026-06-22T01:30:00Z'); // 18:30 PDT Jun 21
      expect(periodKey(d, 'day', LA)).toBe('2026-06-21');
      expect(periodKey(d, 'day', UTC)).toBe('2026-06-22');
    });

    it('month/year buckets also shift across the LA midnight boundary', () => {
      // 2026-07-01T05:00Z == 2026-06-30T22:00 PDT → June under LA, July under UTC.
      const d = new Date('2026-07-01T05:00:00Z');
      expect(periodKey(d, 'month', LA)).toBe('2026-06');
      expect(periodKey(d, 'month', UTC)).toBe('2026-07');
      expect(periodKey(d, 'year', LA)).toBe('2026');
    });
  });
});

describe('selectPeriodTier', () => {
  it('returns empty when count <= 0', () => {
    const candidates = [cand('a', '2026-06-22T10:00:00Z')];
    expect(selectPeriodTier(candidates, 'day', 0, UTC).size).toBe(0);
    expect(selectPeriodTier(candidates, 'day', -3, UTC).size).toBe(0);
  });

  it('keeps the newest-by-createdAt backup within each bucket', () => {
    const early = cand('early', '2026-06-22T01:00:00Z');
    const late = cand('late', '2026-06-22T23:00:00Z');
    const selected = selectPeriodTier([early, late], 'day', 5, UTC);
    expect([...selected]).toEqual(['late']);
  });

  it('takes the N most-recent buckets that EXIST among candidates (gaps skipped)', () => {
    // Buckets: Jun 20, Jun 18, Jun 15 (Jun 19/17/16 missing). count=2 → newest 2 buckets.
    const candidates = [
      cand('d20', '2026-06-20T10:00:00Z'),
      cand('d18', '2026-06-18T10:00:00Z'),
      cand('d15', '2026-06-15T10:00:00Z'),
    ];
    const selected = selectPeriodTier(candidates, 'day', 2, UTC);
    expect([...selected].sort()).toEqual(['d18', 'd20']);
  });

  it('groups by ISO week for the week period', () => {
    // Two backups in 2026-W26, one in 2026-W25. weekly=1 → newest week only,
    // and within it the newest backup.
    const w26a = cand('w26a', '2026-06-22T08:00:00Z'); // Mon W26
    const w26b = cand('w26b', '2026-06-24T08:00:00Z'); // Wed W26 (newer)
    const w25 = cand('w25', '2026-06-19T08:00:00Z'); // Fri W25
    expect([...selectPeriodTier([w26a, w26b, w25], 'week', 1, UTC)]).toEqual(['w26b']);
    expect([...selectPeriodTier([w26a, w26b, w25], 'week', 2, UTC)].sort()).toEqual(['w25', 'w26b']);
  });
});

describe('selectKeep (tier union, not sum)', () => {
  it('unions the recent tier with the day/week/month/year tiers', () => {
    // newest=n0; an older daily/weekly/monthly representative each.
    const n0 = cand('n0', '2026-06-24T12:00:00Z');
    const n1 = cand('n1', '2026-06-24T06:00:00Z'); // same day as n0
    const dayOld = cand('dayOld', '2026-06-20T12:00:00Z');
    const weekOld = cand('weekOld', '2026-06-10T12:00:00Z');
    const monthOld = cand('monthOld', '2026-03-15T12:00:00Z');
    const ancient = cand('ancient', '2025-01-01T12:00:00Z'); // not in any tier window below

    const keep = selectKeep(
      [n0, n1, dayOld, weekOld, monthOld, ancient],
      policy({ keepLast: 1, daily: 3, weekly: 2, monthly: 2, yearly: 0 }),
      UTC
    );
    // keepLast=1 → n0. daily=3 newest 3 day-buckets → n0(24th), dayOld(20th), weekOld(10th).
    // weekly=2 newest 2 weeks, monthly=2 newest 2 months → all add monthOld too.
    // ancient (2025) is outside the 3-day/2-week/2-month windows and yearly=0 → pruned.
    expect(keep.has('n0')).toBe(true);
    expect(keep.has('dayOld')).toBe(true);
    expect(keep.has('weekOld')).toBe(true);
    expect(keep.has('monthOld')).toBe(true);
    expect(keep.has('ancient')).toBe(false);
  });

  it('a backup kept by multiple tiers is counted once (set semantics)', () => {
    const only = cand('only', '2026-06-24T12:00:00Z');
    const keep = selectKeep([only], policy({ keepLast: 5, daily: 5, weekly: 5, monthly: 5 }), UTC);
    expect([...keep]).toEqual(['only']);
  });

  it('keepLast=0 with all tiers 0 keeps nothing', () => {
    const candidates = [cand('a', '2026-06-24T12:00:00Z'), cand('b', '2026-06-23T12:00:00Z')];
    expect(selectKeep(candidates, policy(), UTC).size).toBe(0);
  });
});

describe('applyFloor', () => {
  it('pulls the most-recent pruned items back into keep until the floor is met', () => {
    const c0 = cand('c0', '2026-06-24T12:00:00Z'); // newest
    const c1 = cand('c1', '2026-06-23T12:00:00Z');
    const c2 = cand('c2', '2026-06-22T12:00:00Z');
    // keep starts empty, no exempt; floor 2 → pulls c0 then c1 (most-recent first).
    const keep = applyFloor([c0, c1, c2], new Set<string>(), 0, 2);
    expect(keep.has('c0')).toBe(true);
    expect(keep.has('c1')).toBe(true);
    expect(keep.has('c2')).toBe(false);
    expect(keep.size).toBe(2);
  });

  it('counts exempt-successful backups toward the floor', () => {
    const c0 = cand('c0', '2026-06-24T12:00:00Z');
    const c1 = cand('c1', '2026-06-23T12:00:00Z');
    // 2 exempt-successful already satisfy floor=2 → pull nothing back.
    const keep = applyFloor([c0, c1], new Set<string>(), 2, 2);
    expect(keep.size).toBe(0);
  });

  it('never prunes the only successful backup (minFloor=1)', () => {
    const only = cand('only', '2026-06-24T12:00:00Z');
    const keep = applyFloor([only], new Set<string>(), 0, 1);
    expect([...keep]).toEqual(['only']);
  });

  it('is a no-op when keep already meets the floor', () => {
    const c0 = cand('c0', '2026-06-24T12:00:00Z');
    const c1 = cand('c1', '2026-06-23T12:00:00Z');
    const keep = applyFloor([c0, c1], new Set(['c0', 'c1']), 0, 2);
    expect(keep.size).toBe(2);
  });
});

describe('applySizeCap', () => {
  it('is a no-op when the cap is null', () => {
    const candidates = [cand('a', '2026-06-24T12:00:00Z', 100n)];
    const res = applySizeCap(candidates, new Set(['a']), 0n, 0, 1, null);
    expect(res.cappedButUnreachable).toBe(false);
    expect([...res.keep]).toEqual(['a']);
  });

  it('evicts the OLDEST prunable kept item first to meet the cap', () => {
    const oldC = cand('old', '2026-06-20T12:00:00Z', 10n);
    const midC = cand('mid', '2026-06-22T12:00:00Z', 10n);
    const newC = cand('new', '2026-06-24T12:00:00Z', 10n);
    const all = [oldC, midC, newC];
    // total kept = 30, cap = 25 → must evict 1; oldest (old) goes first. floor=1.
    const res = applySizeCap(all, new Set(['old', 'mid', 'new']), 0n, 0, 1, 25n);
    expect(res.keep.has('old')).toBe(false);
    expect(res.keep.has('mid')).toBe(true);
    expect(res.keep.has('new')).toBe(true);
    expect(res.cappedButUnreachable).toBe(false);
  });

  it('respects the floor: stops evicting once retained-successful would drop below minFloor', () => {
    const oldC = cand('old', '2026-06-20T12:00:00Z', 10n);
    const newC = cand('new', '2026-06-24T12:00:00Z', 10n);
    // cap=1 is unreachable; floor=2 with no exempt means we cannot evict either
    // (each eviction would drop retained to 1 < 2). Both survive.
    const res = applySizeCap([oldC, newC], new Set(['old', 'new']), 0n, 0, 2, 1n);
    expect(res.keep.size).toBe(2);
    expect(res.cappedButUnreachable).toBe(true);
  });

  it('never evicts exempt (manual/pinned) backups — only the kept prunable candidates', () => {
    // exemptSize models a large manual/pinned total that alone blows the cap.
    const kept = cand('kept', '2026-06-24T12:00:00Z', 5n);
    // exemptSize=100, kept=5, cap=50, floor=1. Evicting `kept` (→ total 100) still
    // exceeds the cap, and exempt can't be touched → cappedButUnreachable.
    const res = applySizeCap([kept], new Set(['kept']), 100n, 1, 1, 50n);
    expect(res.cappedButUnreachable).toBe(true);
    // `kept` itself may be evicted (it's prunable and floor is satisfied by exempt),
    // but the exempt total is never reduced — the flag reflects that.
    expect(res.keep.has('kept')).toBe(false);
  });

  it('sets cappedButUnreachable=false when eviction brings total within the cap', () => {
    const a = cand('a', '2026-06-20T12:00:00Z', 40n);
    const b = cand('b', '2026-06-24T12:00:00Z', 40n);
    const res = applySizeCap([a, b], new Set(['a', 'b']), 0n, 0, 1, 50n);
    // Evict oldest (a, 40) → total 40 <= 50.
    expect(res.keep.has('a')).toBe(false);
    expect(res.keep.has('b')).toBe(true);
    expect(res.cappedButUnreachable).toBe(false);
  });
});

describe('PRESETS / RETENTION_BOUNDS constants', () => {
  it('balanced is the documented default', () => {
    expect(PRESETS.balanced).toEqual({ keepLast: 24, daily: 7, weekly: 4, monthly: 6, yearly: 0, minFloor: 2 });
  });
  it('lean and long_term match the spec', () => {
    expect(PRESETS.lean).toEqual({ keepLast: 12, daily: 7, weekly: 4, monthly: 0, yearly: 0, minFloor: 2 });
    expect(PRESETS.long_term).toEqual({ keepLast: 24, daily: 7, weekly: 4, monthly: 12, yearly: 3, minFloor: 2 });
  });
  it('bounds cover the documented ranges', () => {
    expect(RETENTION_BOUNDS.daily).toEqual({ min: 0, max: 366 });
    expect(RETENTION_BOUNDS.weekly).toEqual({ min: 0, max: 520 });
    expect(RETENTION_BOUNDS.minFloor).toEqual({ min: 1, max: 10 });
  });
});

describe('resolveRetentionPolicy', () => {
  const globalSettings = {
    backupRetentionPreset: 'balanced',
    backupRetentionKeepLast: 24,
    backupRetentionDaily: 7,
    backupRetentionWeekly: 4,
    backupRetentionMonthly: 6,
    backupRetentionYearly: 0,
    backupRetentionMinFloor: 2,
    backupRetentionMaxTotalBytes: null as bigint | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSystemSettings.mockResolvedValue(globalSettings as never);
  });

  it('returns the override fields with source="override" when a row exists and inheritGlobal=false', async () => {
    mockPrisma.backupRetentionPolicy.findUnique.mockResolvedValue({
      databaseId: 'db-1',
      inheritGlobal: false,
      preset: 'custom',
      keepLast: 5,
      daily: 3,
      weekly: 1,
      monthly: 0,
      yearly: 0,
      minFloor: 2,
      maxTotalBytes: 1000n,
    });

    const eff = await resolveRetentionPolicy('db-1');
    expect(eff).toEqual({
      keepLast: 5,
      daily: 3,
      weekly: 1,
      monthly: 0,
      yearly: 0,
      minFloor: 2,
      maxTotalBytes: 1000n,
      preset: 'custom',
      source: 'override',
    });
    // Inherited path not consulted.
    expect(mockGetSystemSettings).not.toHaveBeenCalled();
  });

  it('falls back to the global default (source="inherited") when no override row exists', async () => {
    mockPrisma.backupRetentionPolicy.findUnique.mockResolvedValue(null);

    const eff = await resolveRetentionPolicy('db-2');
    expect(eff).toEqual({
      keepLast: 24,
      daily: 7,
      weekly: 4,
      monthly: 6,
      yearly: 0,
      minFloor: 2,
      maxTotalBytes: null,
      preset: 'balanced',
      source: 'inherited',
    });
    expect(mockGetSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('falls back to the global default when the override row has inheritGlobal=true', async () => {
    mockPrisma.backupRetentionPolicy.findUnique.mockResolvedValue({
      databaseId: 'db-3',
      inheritGlobal: true,
      preset: 'custom',
      keepLast: 99, // these are ignored when inheriting
      daily: 99,
      weekly: 99,
      monthly: 99,
      yearly: 99,
      minFloor: 9,
      maxTotalBytes: 42n,
    });

    const eff = await resolveRetentionPolicy('db-3');
    expect(eff.source).toBe('inherited');
    expect(eff.keepLast).toBe(24); // global, not the row's 99
    expect(eff.maxTotalBytes).toBeNull();
  });

  it('propagates a bigint global size cap unchanged', async () => {
    mockPrisma.backupRetentionPolicy.findUnique.mockResolvedValue(null);
    mockGetSystemSettings.mockResolvedValue({
      ...globalSettings,
      backupRetentionMaxTotalBytes: 5_000_000_000n,
    } as never);

    const eff = await resolveRetentionPolicy('db-4');
    expect(eff.maxTotalBytes).toBe(5_000_000_000n);
  });
});
