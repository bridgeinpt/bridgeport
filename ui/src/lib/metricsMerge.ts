/**
 * Client-side helpers for stitching delta refreshes onto a previously-known
 * columnar metrics response. Issue #171.
 *
 * Wire shape (per the three /metrics/history endpoints):
 *   {
 *     timestamps: string[],
 *     series: Record<string, Array<Array<number | null>>>,
 *     ...entityMeta,
 *     mode: 'full' | 'delta',
 *     until: string,
 *   }
 *
 * On the first load we receive `mode='full'` (LTTB-downsampled). On every
 * auto-refresh tick the client sends the previous `until` as `?since=` and
 * receives `mode='delta'` carrying only the new points. This module turns
 * those payloads into a single merged response the chart can render.
 *
 * Important invariants:
 *  - Entity order in `entities[]` must match the row order in `series` —
 *    the backend echoes the same order on every response, but to be safe
 *    we re-index by id when entity sets diverge (e.g. a new server was
 *    added since the initial load).
 *  - Duplicate timestamps are deduped (delta is exclusive, but clock skew
 *    between client/server could in theory cause overlap; explicit dedup
 *    is a small price for predictable behaviour).
 */

export interface ColumnarHistory<Entity extends { id: string }, SeriesKey extends string = string> {
  entities: Entity[];
  timestamps: string[];
  series: Partial<Record<SeriesKey, Array<Array<number | null>>>>;
  mode?: 'full' | 'delta';
  until?: string;
}

/**
 * Merge a delta payload onto an existing full-window response. Returns a
 * brand new object so React state setters trigger a re-render.
 *
 * `windowSize`, when set, caps the merged timestamp count to the most
 * recent N points. This stops memory growth across long auto-refresh
 * sessions without dropping the visual window the user picked at load
 * time (the initial full response is already LTTB-downsampled to ≤120
 * points by default, so the typical cap is `prev.timestamps.length +
 * delta.timestamps.length` rounded up by a comfortable buffer).
 */
export function mergeColumnarHistory<E extends { id: string }, K extends string = string>(
  prev: ColumnarHistory<E, K>,
  delta: ColumnarHistory<E, K>,
  options?: { windowSize?: number }
): ColumnarHistory<E, K> {
  // Build a unified entity list. We keep `prev` order so existing chart
  // legend slots don't reshuffle on refresh — new entities are appended.
  const entities: E[] = [...prev.entities];
  const idToIdx = new Map<string, number>();
  prev.entities.forEach((e, i) => idToIdx.set(e.id, i));
  for (const e of delta.entities) {
    if (!idToIdx.has(e.id)) {
      idToIdx.set(e.id, entities.length);
      entities.push(e);
    }
  }

  // Dedupe timestamps across prev + delta. Same-ISO collisions are dropped
  // (delta payloads use strict `>` on the backend so this is rare, but
  // defensive: we'd rather render one point than two stacked at the same x).
  const seen = new Set<string>(prev.timestamps);
  const newTs: string[] = [];
  for (const t of delta.timestamps) {
    if (!seen.has(t)) {
      seen.add(t);
      newTs.push(t);
    }
  }

  const mergedTimestamps = [...prev.timestamps, ...newTs];
  const cap = options?.windowSize;
  const trimFrom = cap != null && mergedTimestamps.length > cap ? mergedTimestamps.length - cap : 0;

  // Merge series. Allocate the union of keys present in prev OR delta —
  // a series key might be absent from `prev` if it was empty at load time
  // but populated by the delta (e.g. backend started collecting a metric).
  const allKeys = new Set<K>([
    ...(Object.keys(prev.series) as K[]),
    ...(Object.keys(delta.series) as K[]),
  ]);

  const mergedSeries: Partial<Record<K, Array<Array<number | null>>>> = {};
  // delta timestamp -> delta-index lookup, built once per merge.
  const tsToDeltaIdx = new Map<string, number>();
  delta.timestamps.forEach((t, j) => tsToDeltaIdx.set(t, j));

  for (const key of allKeys) {
    const prevRows = prev.series[key];
    const deltaRows = delta.series[key];

    const out: Array<Array<number | null>> = new Array(entities.length);
    for (let i = 0; i < entities.length; i++) {
      // For each entity slot, pull the prev row by its prev-index and the
      // delta row by its delta-index, then concatenate the delta-new points.
      const e = entities[i];
      const prevIdx = prev.entities.findIndex((p) => p.id === e.id);
      const deltaIdx = delta.entities.findIndex((p) => p.id === e.id);

      const prevRow: Array<number | null> = prevIdx >= 0 && prevRows
        ? prevRows[prevIdx] ?? new Array(prev.timestamps.length).fill(null)
        : new Array(prev.timestamps.length).fill(null);

      // Project delta into only the new timestamps (in the same order we
      // appended above) — if delta carries old timestamps that prev already
      // had, we skip them.
      const deltaRow: Array<number | null> = new Array(newTs.length).fill(null);
      if (deltaIdx >= 0 && deltaRows) {
        const dr = deltaRows[deltaIdx];
        if (dr) {
          newTs.forEach((t, j) => {
            const di = tsToDeltaIdx.get(t);
            deltaRow[j] = di != null ? dr[di] ?? null : null;
          });
        }
      }

      const concatRow = prevRow.concat(deltaRow);
      out[i] = trimFrom > 0 ? concatRow.slice(trimFrom) : concatRow;
    }
    mergedSeries[key] = out;
  }

  const finalTimestamps = trimFrom > 0 ? mergedTimestamps.slice(trimFrom) : mergedTimestamps;

  return {
    entities,
    timestamps: finalTimestamps,
    series: mergedSeries,
    mode: 'full',
    until: delta.until ?? prev.until,
  } as ColumnarHistory<E, K>;
}
