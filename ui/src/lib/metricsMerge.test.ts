import { describe, it, expect } from 'vitest';
import { mergeColumnarHistory, type ColumnarHistory } from './metricsMerge';

/**
 * Tests for the client-side delta stitcher (issue #171).
 *
 * Wire shape recap (per /metrics/history endpoints):
 *   { entities[], timestamps[], series: { [key]: rows[][] }, mode, until }
 *
 * `mergeColumnarHistory(prev, delta)` returns a merged response so React
 * state setters can replace the previous object on each refresh tick.
 */
describe('mergeColumnarHistory', () => {
  // Helper: build a ColumnarHistory<E, K> for assertions. Entities are
  // identified by `id` (the merger keys by id).
  const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);
  const ts = (i: number): string => new Date(baseTime + i * 60_000).toISOString();

  it('appends new timestamps + per-entity rows to the existing window', () => {
    const prev: ColumnarHistory<{ id: string; name: string }, 'cpu'> = {
      entities: [
        { id: 's1', name: 'srv1' },
        { id: 's2', name: 'srv2' },
      ],
      timestamps: [ts(0), ts(1), ts(2)],
      series: {
        cpu: [
          [10, 11, 12],
          [20, 21, 22],
        ],
      },
      mode: 'full',
      until: ts(2),
    };
    const delta: ColumnarHistory<{ id: string; name: string }, 'cpu'> = {
      entities: [
        { id: 's1', name: 'srv1' },
        { id: 's2', name: 'srv2' },
      ],
      timestamps: [ts(3), ts(4)],
      series: {
        cpu: [
          [13, 14],
          [23, 24],
        ],
      },
      mode: 'delta',
      until: ts(4),
    };

    const merged = mergeColumnarHistory(prev, delta);

    expect(merged.timestamps).toEqual([ts(0), ts(1), ts(2), ts(3), ts(4)]);
    expect(merged.series.cpu).toEqual([
      [10, 11, 12, 13, 14],
      [20, 21, 22, 23, 24],
    ]);
    expect(merged.entities).toEqual(prev.entities);
    expect(merged.until).toBe(ts(4));
    // Result mode is 'full' — the merged shape is again a complete window.
    expect(merged.mode).toBe('full');
  });

  it('dedupes timestamps when delta overlaps the prev boundary', () => {
    const prev: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(0), ts(1), ts(2)],
      series: { cpu: [[1, 2, 3]] },
      until: ts(2),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      // ts(2) overlaps with prev — should NOT be duplicated.
      timestamps: [ts(2), ts(3)],
      series: { cpu: [[99, 4]] },
      until: ts(3),
    };

    const merged = mergeColumnarHistory(prev, delta);

    // No duplicate of ts(2). prev's value at ts(2) is preserved (since dedup
    // skips the delta sample at the boundary).
    expect(merged.timestamps).toEqual([ts(0), ts(1), ts(2), ts(3)]);
    expect(merged.series.cpu).toEqual([[1, 2, 3, 4]]);
  });

  it('appends a new entity row when delta carries one prev does not have', () => {
    const prev: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(0), ts(1)],
      series: { cpu: [[10, 11]] },
      until: ts(1),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }, { id: 's2' }], // s2 is new.
      timestamps: [ts(2)],
      series: {
        cpu: [
          [12],
          [22],
        ],
      },
      until: ts(2),
    };

    const merged = mergeColumnarHistory(prev, delta);

    expect(merged.entities.map((e) => e.id)).toEqual(['s1', 's2']);
    // s2 row gets nulls for the prev window since it wasn't present then.
    expect(merged.series.cpu).toEqual([
      [10, 11, 12],
      [null, null, 22],
    ]);
  });

  it('preserves prev entity order even if delta reorders entities', () => {
    // Reordering would otherwise reshuffle chart legend slots.
    const prev: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }, { id: 's2' }],
      timestamps: [ts(0)],
      series: { cpu: [[1], [2]] },
      until: ts(0),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu'> = {
      // Reversed.
      entities: [{ id: 's2' }, { id: 's1' }],
      timestamps: [ts(1)],
      series: { cpu: [[20], [10]] },
      until: ts(1),
    };

    const merged = mergeColumnarHistory(prev, delta);

    expect(merged.entities.map((e) => e.id)).toEqual(['s1', 's2']);
    expect(merged.series.cpu).toEqual([
      [1, 10], // s1 at slot 0 in prev, slot 1 from delta where s1 was at index 1.
      [2, 20], // s2.
    ]);
  });

  it('handles empty prev (initial-like state with no points yet)', () => {
    const prev: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [],
      series: { cpu: [[]] },
      until: undefined,
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(0), ts(1)],
      series: { cpu: [[1, 2]] },
      until: ts(1),
    };

    const merged = mergeColumnarHistory(prev, delta);
    expect(merged.timestamps).toEqual([ts(0), ts(1)]);
    expect(merged.series.cpu).toEqual([[1, 2]]);
    expect(merged.until).toBe(ts(1));
  });

  it('handles empty delta (no new points since last tick)', () => {
    const prev: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(0), ts(1)],
      series: { cpu: [[1, 2]] },
      until: ts(1),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [],
      series: { cpu: [[]] },
      until: ts(5),
    };

    const merged = mergeColumnarHistory(prev, delta);
    // Timestamps unchanged but the until high-water mark advances.
    expect(merged.timestamps).toEqual([ts(0), ts(1)]);
    expect(merged.series.cpu).toEqual([[1, 2]]);
    expect(merged.until).toBe(ts(5));
  });

  it('returns a new object (does not mutate prev)', () => {
    const prev: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(0)],
      series: { cpu: [[1]] },
      until: ts(0),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(1)],
      series: { cpu: [[2]] },
      until: ts(1),
    };

    const merged = mergeColumnarHistory(prev, delta);
    expect(merged).not.toBe(prev);
    expect(merged.timestamps).not.toBe(prev.timestamps);
    expect(merged.series).not.toBe(prev.series);
    // prev untouched.
    expect(prev.timestamps).toEqual([ts(0)]);
    expect(prev.series.cpu).toEqual([[1]]);
  });

  it('windowSize trims the merged result to the most recent N points', () => {
    const prev: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(0), ts(1), ts(2), ts(3)],
      series: { cpu: [[1, 2, 3, 4]] },
      until: ts(3),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(4), ts(5)],
      series: { cpu: [[5, 6]] },
      until: ts(5),
    };

    const merged = mergeColumnarHistory(prev, delta, { windowSize: 3 });

    // Most recent 3 of [ts(0)..ts(5)] = [ts(3), ts(4), ts(5)].
    expect(merged.timestamps).toEqual([ts(3), ts(4), ts(5)]);
    expect(merged.series.cpu).toEqual([[4, 5, 6]]);
  });

  it('windowSize does not trim when total is within cap', () => {
    const prev: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(0)],
      series: { cpu: [[1]] },
      until: ts(0),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(1)],
      series: { cpu: [[2]] },
      until: ts(1),
    };

    const merged = mergeColumnarHistory(prev, delta, { windowSize: 100 });
    expect(merged.timestamps).toEqual([ts(0), ts(1)]);
    expect(merged.series.cpu).toEqual([[1, 2]]);
  });

  it('merges a series key only present in delta (not in prev)', () => {
    // E.g. backend started collecting a new metric mid-window.
    const prev: ColumnarHistory<{ id: string }, 'cpu' | 'memory'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(0)],
      series: { cpu: [[1]] },
      until: ts(0),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu' | 'memory'> = {
      entities: [{ id: 's1' }],
      timestamps: [ts(1)],
      series: { cpu: [[2]], memory: [[100]] },
      until: ts(1),
    };

    const merged = mergeColumnarHistory(prev, delta);
    expect(merged.series.cpu).toEqual([[1, 2]]);
    // memory row gets null padding for the prev range, then the delta value.
    expect(merged.series.memory).toEqual([[null, 100]]);
  });

  it('produces output rows that align to the merged timestamp count', () => {
    const prev: ColumnarHistory<{ id: string }, 'cpu' | 'memory'> = {
      entities: [{ id: 's1' }, { id: 's2' }],
      timestamps: [ts(0), ts(1)],
      series: {
        cpu: [
          [1, 2],
          [10, 20],
        ],
        memory: [
          [100, 200],
          [1000, 2000],
        ],
      },
      until: ts(1),
    };
    const delta: ColumnarHistory<{ id: string }, 'cpu' | 'memory'> = {
      entities: [{ id: 's1' }, { id: 's2' }],
      timestamps: [ts(2)],
      series: {
        cpu: [[3], [30]],
        memory: [[300], [3000]],
      },
      until: ts(2),
    };

    const merged = mergeColumnarHistory(prev, delta);
    expect(merged.timestamps.length).toBe(3);
    // Both metric keys preserved, both row counts match entity count, all
    // rows align to timestamps.length.
    for (const key of ['cpu', 'memory'] as const) {
      const rows = merged.series[key]!;
      expect(rows.length).toBe(merged.entities.length);
      for (const row of rows) {
        expect(row.length).toBe(merged.timestamps.length);
      }
    }
  });
});
