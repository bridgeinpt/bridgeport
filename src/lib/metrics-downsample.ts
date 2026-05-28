/**
 * Columnar metrics downsampling using LTTB (Largest-Triangle-Three-Buckets).
 *
 * The monitoring history endpoints return one shared `timestamps[]` and a
 * matrix of per-entity rows (`number | null` per timestamp slot). We want to
 * cap the wire payload + chart point count without distorting the visual
 * shape of each series.
 *
 * Approach:
 *  1. Bucket the shared timestamp index into `maxPoints` slots (first and
 *     last points are always kept verbatim).
 *  2. For each row, pick the timestamp index inside each interior bucket
 *     whose corresponding value forms the largest triangle with the
 *     previously-selected point and the average of the next bucket. This is
 *     the standard LTTB algorithm — see Sveinn Steinarsson's thesis, 2013.
 *  3. Nulls are excluded from the triangle calculation; if a bucket has no
 *     numeric samples for a given row, that row emits `null` at that slot
 *     (matching the "no sample" semantics of the columnar shape).
 *  4. Picking the timestamp index once per bucket, then projecting every row
 *     against that shared index, keeps timestamps aligned across all
 *     entities — required by the frontend, which assumes
 *     `series[key][rowIdx][tIdx]` corresponds to `timestamps[tIdx]`.
 *
 * If `timestamps.length <= maxPoints` (or `maxPoints < 3`, since LTTB needs
 * at least three slots to form a triangle), the input is returned as-is.
 */

export interface DownsampleResult {
  timestamps: string[];
  rows: Array<Array<number | null>>;
}

export function downsampleColumnar(
  timestamps: string[],
  rows: Array<Array<number | null>>,
  maxPoints: number
): DownsampleResult {
  const n = timestamps.length;
  // LTTB needs at least 3 buckets (first + interior + last). For trivially
  // small inputs, return the original arrays untouched — callers can rely on
  // referential identity to skip the copy.
  if (n <= maxPoints || maxPoints < 3) {
    return { timestamps, rows };
  }

  // Pick `maxPoints - 2` interior buckets evenly across indices [1, n-1).
  // Endpoints (index 0 and n-1) are always preserved.
  const interior = maxPoints - 2;
  const bucketSize = (n - 2) / interior;

  // Pre-compute the bucket boundaries in index-space so each row picks from
  // the same shared slots. boundaries[i] = [startIdx, endIdx) for bucket i,
  // i in [0, interior). Bucket 0 covers indices starting at 1 (just after
  // the preserved first point).
  const boundaries: Array<[number, number]> = new Array(interior);
  for (let i = 0; i < interior; i++) {
    const start = Math.floor(i * bucketSize) + 1;
    const end = Math.floor((i + 1) * bucketSize) + 1;
    boundaries[i] = [start, Math.min(end, n - 1)];
  }

  // Time as a numeric axis for the triangle-area calculation. We use the
  // shared timestamp index as the x coordinate — the actual ISO string only
  // needs to be carried through, not measured against. This keeps the
  // algorithm purely numeric and avoids parsing dates in the hot loop.
  const x = (idx: number): number => idx;

  // Pick interior bucket indices per row, then assemble the shared list of
  // selected timestamp indices. We aggregate the picks across all rows by
  // keeping the union — but to preserve alignment we instead pick ONE shared
  // index per bucket: the index that maximizes the SUM of triangle areas
  // across rows (so each row contributes evidence to the shared pick).
  const selectedIndices: number[] = new Array(interior);

  // The "previous point" tracking is per-row (used to compute the triangle
  // base). For the shared selection we maintain a per-row previous index.
  const prevIdxByRow: number[] = new Array(rows.length).fill(0);

  for (let bucket = 0; bucket < interior; bucket++) {
    const [bStart, bEnd] = boundaries[bucket];
    if (bEnd <= bStart) {
      // Degenerate bucket — fall back to the start index.
      selectedIndices[bucket] = bStart;
      continue;
    }

    // Compute the "next bucket average point" per row. For the last interior
    // bucket, the "next" point is the preserved final index (n-1).
    const nextStart = bucket + 1 < interior ? boundaries[bucket + 1][0] : n - 1;
    const nextEnd = bucket + 1 < interior ? boundaries[bucket + 1][1] : n;

    let bestIdx = bStart;
    let bestScore = -Infinity;

    for (let candidate = bStart; candidate < bEnd; candidate++) {
      const cx = x(candidate);
      let score = 0;
      let contributing = 0;

      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const cy = row[candidate];
        if (cy == null) continue;

        const pIdx = prevIdxByRow[r];
        const py = row[pIdx];
        if (py == null) continue;

        // Average of valid next-bucket samples for this row.
        let nxSum = 0;
        let nySum = 0;
        let nCount = 0;
        for (let j = nextStart; j < nextEnd; j++) {
          const v = row[j];
          if (v == null) continue;
          nxSum += x(j);
          nySum += v;
          nCount++;
        }
        if (nCount === 0) continue;
        const nx = nxSum / nCount;
        const ny = nySum / nCount;

        const px = x(pIdx);
        // Triangle area = |(px - nx) * (cy - py) - (px - cx) * (ny - py)| / 2.
        // We compare areas across candidates so the /2 is irrelevant.
        const area = Math.abs(
          (px - nx) * (cy - py) - (px - cx) * (ny - py)
        );
        score += area;
        contributing++;
      }

      // Prefer candidates with at least one contributing row. If no row had
      // valid data at this index, fall back to a low-priority tie-break.
      if (contributing > 0 && score > bestScore) {
        bestScore = score;
        bestIdx = candidate;
      }
    }

    selectedIndices[bucket] = bestIdx;

    // Advance the per-row previous index for the next bucket.
    for (let r = 0; r < rows.length; r++) {
      if (rows[r][bestIdx] != null) {
        prevIdxByRow[r] = bestIdx;
      }
    }
  }

  // Final index list: 0, ...selectedIndices, n-1.
  const finalIdx: number[] = new Array(maxPoints);
  finalIdx[0] = 0;
  for (let i = 0; i < interior; i++) finalIdx[i + 1] = selectedIndices[i];
  finalIdx[maxPoints - 1] = n - 1;

  // Project timestamps + each row onto the selected indices. A null at the
  // chosen index stays null (the row's data shape is preserved point-wise).
  const newTimestamps = finalIdx.map((i) => timestamps[i]);
  const newRows: Array<Array<number | null>> = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const out: Array<number | null> = new Array(maxPoints);
    for (let i = 0; i < maxPoints; i++) {
      const v = row[finalIdx[i]];
      out[i] = v ?? null;
    }
    newRows[r] = out;
  }

  return { timestamps: newTimestamps, rows: newRows };
}
