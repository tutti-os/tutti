/**
 * Split a flat list into consecutive runs. A new run starts whenever
 * `sameRun(previousItem, currentItem)` returns false. Total function: every
 * input element lands in exactly one run, runs preserve order, and an empty
 * input yields an empty result. No element is ever dropped or duplicated.
 *
 * This is the segmentation primitive behind neighbour-dependent projections
 * (e.g. coalescing thinking into the message it precedes). Keeping it generic
 * and pure means the grouping decision lives entirely in the `sameRun`
 * predicate, which is trivially table-testable on its own.
 */
export function chunkBy<T>(
  items: readonly T[],
  sameRun: (previous: T, current: T) => boolean
): T[][] {
  const runs: T[][] = [];
  for (const item of items) {
    const current = runs.at(-1);
    if (current && sameRun(current.at(-1)!, item)) {
      current.push(item);
      continue;
    }
    runs.push([item]);
  }
  return runs;
}
