---
name: analyze-performance-traces
description: Analyze large Chrome, Chromium, Electron, React DevTools, or Perfetto-compatible JSON performance traces without loading the whole file into context; locate concrete source-level bottlenecks, explain trigger-to-layout/render chains, classify behavior-preserving versus user-observable optimizations, implement safe fixes when requested, and verify semantic equivalence. Use for trace files, dropped frames, long tasks, resize jank, render storms, layout thrashing, selector hot paths, interaction latency, or requests to identify exact code choke points from profiling evidence.
---

# Analyze Performance Traces

Turn a large trace into an evidence chain ending at concrete files, symbols, and lines. Optimize root causes only. Keep measured facts separate from inference.

## Start safely

1. Read repository instructions and relevant architecture docs before interpreting ownership or editing.
2. Inspect file size and envelope; never print or load a huge trace into model context:

   ```sh
   ls -lh TRACE.json
   head -c 512 TRACE.json
   tail -c 512 TRACE.json
   ```

3. Run the bundled bounded-memory summarizer:

   ```sh
   node <skill-dir>/scripts/summarize_trace.mjs TRACE.json --top 40 --min-ms 16
   ```

4. Record whether the trace includes development-only profiling, React component tracks, source maps, screenshots, or multiple renderer processes. Treat profiler startup and instrumentation cost separately from product cost.

## Build the evidence chain

Work in this order:

1. **Select process/thread**: use metadata to identify browser main, renderer main, compositor, workers, and GPU threads. Do not combine their durations.
2. **Find symptoms**: quantify long tasks, worst interactions, dropped/begin frames, layout/style duration, scripting duration, and burst windows.
3. **Correlate timestamps**: connect input/resize/timer events to state updates, React renders, style recalculation, layout, paint, and frame loss within the same window.
4. **Measure fanout**: count repeated component events or DOM/layout objects. Express multiplicative patterns such as `34 sections × 67 parent updates = 2,278 renders`.
5. **Map to source**: extract stack URLs/function names, then use `rg` to follow symbols through current source. If trace points to a bundle, use source maps, named component tracks, event handler names, or unique class names. Verify that current code matches the traced revision.
6. **Inspect data cardinality**: use read-only DB/query inspection only when needed. Explain why an algorithm becomes hot using actual session/turn/item counts; remove local paths and personal data from durable output.
7. **State one causal chain**: `trigger → state write → reference churn/computation → render fanout → DOM/style/layout → missed frame`.

Do not rank functions only by inclusive time: nested trace events overlap and double-count. Report self time when available; otherwise label inclusive duration explicitly.

## Recognize common root causes

- Reducer recreates every entity during resize even when derived values are exactly equal.
- Memoized child receives inline callbacks or objects, defeating referential equality.
- Context provider publishes a fresh projection with unchanged rendered fields.
- Selector scans/sorts all entities once per session, producing `O(S × (T + I))` work.
- Layout read follows DOM mutation or repeats across a large subtree.
- Development profiling or extension hooks create apparent long frames not present in production.

Prefer fixing the earliest proven cause. Do not hide upstream churn with broad leaf memoization when stable ownership/projection can be fixed at the producer.

## Classify optimization visibility

Treat an optimization as strictly behavior-preserving only when rendered values, ordering, event timing, focus, lock scope, mounted state, and side effects remain equivalent.

Usually safe after exact tests:

- Reuse entity/array references when every derived value is exactly equal.
- Stabilize callbacks while preserving event-time reads and dependency semantics.
- Replace repeated scans with one-pass grouping while preserving filtering, orphan rules, stable ordering, and tie-breakers.
- Memoize a presentation projection using every field that affects its output.
- Replace full sort for latest-item selection with the identical comparator and a one-pass maximum.

Potentially user-observable; exclude or request approval:

- Debounce, throttle, or move work to `requestAnimationFrame`.
- Reduce animation/carousel frame rate.
- Pause work using visibility/intersection heuristics.
- Remove global interaction locks, focus behavior, autofocus, or layout reads.
- Virtualize/unmount content, drop events, delay updates, or return stale cached values.

When unsure, classify as observable.

## Implement without semantic drift

1. Preserve existing architecture and module ownership.
2. Add identity tests for structural sharing and output tests for selector ordering/filtering.
3. Keep exact comparators in named helpers so old and optimized paths cannot diverge.
4. Avoid new persistent indexes unless evidence shows ephemeral one-pass grouping is insufficient; persistent indexes expand reducer/state migration surface.
5. Do not add compatibility, fallback, cache, or timing layers without evidence.
6. Run formatter, targeted tests, typecheck/lint, architecture budgets, then changed-aware checks required by the repository.

If asked only to analyze, stop before editing. If asked to optimize, implement only the authorized visibility class.

## Validate and report

Validate at three levels:

- **Semantic**: same values, sort order, filters, lock transitions, focus, and event behavior.
- **Structural**: unchanged values retain references; changed entities still receive new references.
- **Performance**: complexity reduction or rerender containment is proven; recapture a comparable trace when practical.

Report:

1. Trace facts with counts/durations and process/thread.
2. Concrete source locations and causal chain.
3. Fixes grouped by strictly invisible versus potentially observable.
4. Validation commands/results.
5. What remains unverified, especially when no post-fix trace was captured.
6. Any implementation-plan changes and documentation impact required by repository rules.

Never claim millisecond or frame-rate improvement without a comparable post-change measurement. Complexity reduction and prevented rerenders may be stated as such.

## Bundled script

`scripts/summarize_trace.mjs` streams `traceEvents`, keeps bounded top-event state, and outputs JSON containing thread metadata, event totals, long tasks, frame signals, and source hints. Use it for the first pass; write narrow follow-up scripts only after a specific hypothesis exists.
