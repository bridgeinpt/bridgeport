import { describe, it, expect } from 'vitest';
import { downsampleColumnar } from './metrics-downsample.js';

/**
 * Tests for LTTB downsampling of columnar metrics history (issue #171).
 *
 * The helper picks a shared set of timestamp indices for every row so that
 * `series[key][rowIdx][tIdx]` stays aligned to `timestamps[tIdx]` — those
 * invariants are what the chart layer relies on, so we assert them rather
 * than the exact picked indices (which are an implementation detail of the
 * triangle scoring).
 */
describe('downsampleColumnar', () => {
  // Helper: build an ISO timestamp `i` minutes from a fixed base. We don't
  // care about the wall-clock value, only that strings are distinct and
  // deterministic so we can assert structural identity.
  const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);
  const ts = (i: number): string => new Date(baseTime + i * 60_000).toISOString();
  const timestamps = (n: number): string[] => Array.from({ length: n }, (_, i) => ts(i));

  describe('input-passthrough cases', () => {
    it('returns inputs unchanged when timestamps.length <= maxPoints', () => {
      const t = timestamps(10);
      const rows = [t.map((_, i) => i)];
      const result = downsampleColumnar(t, rows, 10);

      // Referential identity — callers can skip the copy.
      expect(result.timestamps).toBe(t);
      expect(result.rows).toBe(rows);
    });

    it('returns inputs unchanged when maxPoints < 3 (LTTB requires triangles)', () => {
      const t = timestamps(100);
      const rows = [t.map((_, i) => i)];
      const result = downsampleColumnar(t, rows, 2);

      expect(result.timestamps).toBe(t);
      expect(result.rows).toBe(rows);
    });

    it('returns inputs unchanged when maxPoints equals input length', () => {
      const t = timestamps(50);
      const rows = [t.map((_, i) => i * 2)];
      const result = downsampleColumnar(t, rows, 50);

      expect(result.timestamps).toBe(t);
      expect(result.rows).toBe(rows);
    });
  });

  describe('LTTB downsampling', () => {
    it('produces exactly maxPoints when downsampling', () => {
      const t = timestamps(720);
      const rows = [t.map((_, i) => Math.sin(i / 10) * 100)];
      const result = downsampleColumnar(t, rows, 120);

      expect(result.timestamps.length).toBe(120);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.length).toBe(120);
    });

    it('preserves first and last timestamps (LTTB endpoint property)', () => {
      const t = timestamps(720);
      const rows = [t.map((_, i) => i)];
      const result = downsampleColumnar(t, rows, 120);

      expect(result.timestamps[0]).toBe(t[0]);
      expect(result.timestamps[result.timestamps.length - 1]).toBe(t[t.length - 1]);
    });

    it('preserves first and last values for each row', () => {
      const t = timestamps(500);
      const rowA = t.map((_, i) => i);
      const rowB = t.map((_, i) => i * 10);
      const result = downsampleColumnar(t, [rowA, rowB], 50);

      expect(result.rows[0]![0]).toBe(rowA[0]);
      expect(result.rows[0]![result.rows[0]!.length - 1]).toBe(rowA[rowA.length - 1]);
      expect(result.rows[1]![0]).toBe(rowB[0]);
      expect(result.rows[1]![result.rows[1]!.length - 1]).toBe(rowB[rowB.length - 1]);
    });

    it('keeps every output row aligned to the picked timestamps (shared slot invariant)', () => {
      const t = timestamps(300);
      const rowA = t.map((_, i) => Math.sin(i / 5) * 50);
      const rowB = t.map((_, i) => Math.cos(i / 5) * 30);
      const rowC = t.map((_, i) => i % 10);
      const result = downsampleColumnar(t, [rowA, rowB, rowC], 60);

      // All rows must be the same length as timestamps — this is the
      // load-bearing invariant for the chart.
      expect(result.timestamps.length).toBe(60);
      for (const row of result.rows) {
        expect(row.length).toBe(result.timestamps.length);
      }
    });

    it('reduces a 720-point dataset to 120 with monotonic timestamps', () => {
      const t = timestamps(720);
      const rows = [t.map((_, i) => i)];
      const result = downsampleColumnar(t, rows, 120);

      expect(result.timestamps.length).toBe(120);
      // Timestamps must remain in ascending order (we project a strictly
      // increasing index list onto the original ISO strings).
      for (let i = 1; i < result.timestamps.length; i++) {
        expect(
          new Date(result.timestamps[i]!).getTime() >
            new Date(result.timestamps[i - 1]!).getTime()
        ).toBe(true);
      }
    });

    it('every output value matches some original value at the same picked slot', () => {
      const t = timestamps(300);
      // Use distinct values so we can prove each output value came from the
      // original (not synthesized via averaging).
      const row = t.map((_, i) => i * 7 + 3);
      const result = downsampleColumnar(t, [row], 30);

      const originalSet = new Set(row);
      for (const v of result.rows[0]!) {
        if (v == null) continue;
        expect(originalSet.has(v)).toBe(true);
      }
    });
  });

  describe('null handling', () => {
    it('emits null at a slot whose chosen index has null in that row', () => {
      const t = timestamps(300);
      // Row A has all values; row B has nulls in a wide stripe in the middle.
      const rowA = t.map((_, i) => i);
      const rowB = t.map((_, i) => (i > 50 && i < 250 ? null : i * 2));
      const result = downsampleColumnar(t, [rowA, rowB], 30);

      // rowB has some null bucket projections.
      const hasNullInB = result.rows[1]!.some((v) => v === null);
      expect(hasNullInB).toBe(true);

      // Same slot projections — for every i, both rows are derived from
      // the same underlying index, so lengths still match.
      expect(result.rows[0]!.length).toBe(result.rows[1]!.length);
    });

    it('returns null for a row that is entirely null', () => {
      const t = timestamps(300);
      const rowA = t.map((_, i) => i);
      const rowAllNull = t.map(() => null as number | null);
      const result = downsampleColumnar(t, [rowA, rowAllNull], 30);

      expect(result.rows[1]!.every((v) => v === null)).toBe(true);
      // rowA must still have meaningful (numeric) endpoints.
      expect(result.rows[0]![0]).toBe(0);
      expect(result.rows[0]![result.rows[0]!.length - 1]).toBe(t.length - 1);
    });

    it('rows of different sparsity stay aligned to the same timestamps', () => {
      const t = timestamps(200);
      // Dense row, occasional null row, mostly-null row.
      const dense = t.map((_, i) => i);
      const occasional = t.map((_, i) => (i % 7 === 0 ? null : i * 2));
      const sparse = t.map((_, i) => (i % 50 === 0 ? i : null as number | null));
      const result = downsampleColumnar(t, [dense, occasional, sparse], 40);

      expect(result.timestamps.length).toBe(40);
      // All three rows aligned to the same axis.
      expect(result.rows[0]!.length).toBe(40);
      expect(result.rows[1]!.length).toBe(40);
      expect(result.rows[2]!.length).toBe(40);
    });
  });

  describe('edge cases', () => {
    it('handles a single row', () => {
      const t = timestamps(500);
      const rows = [t.map((_, i) => i)];
      const result = downsampleColumnar(t, rows, 50);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.length).toBe(50);
    });

    it('handles many rows (e.g. many servers in one env)', () => {
      const t = timestamps(400);
      const rows = Array.from({ length: 12 }, (_, r) =>
        t.map((_, i) => (i + r) % 100)
      );
      const result = downsampleColumnar(t, rows, 40);
      expect(result.rows.length).toBe(12);
      for (const row of result.rows) expect(row.length).toBe(40);
    });

    it('handles empty rows array', () => {
      const t = timestamps(100);
      const result = downsampleColumnar(t, [], 30);
      expect(result.timestamps.length).toBe(30);
      expect(result.rows.length).toBe(0);
    });

    it('handles maxPoints exactly at the LTTB minimum (3)', () => {
      const t = timestamps(100);
      const rows = [t.map((_, i) => i)];
      const result = downsampleColumnar(t, rows, 3);

      expect(result.timestamps.length).toBe(3);
      expect(result.rows[0]!.length).toBe(3);
      // First and last preserved.
      expect(result.rows[0]![0]).toBe(0);
      expect(result.rows[0]![2]).toBe(99);
    });
  });
});
