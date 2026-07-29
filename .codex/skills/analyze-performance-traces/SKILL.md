---
name: analyze-performance-traces
description: Analyze Chrome, Chromium, Electron, React DevTools, or Perfetto-compatible JSON traces and audit user-reported profiling findings without loading large artifacts into context; prove trigger-to-render/layout chains, separate measured facts from source inference, find exact code choke points, classify forced layout and render fanout, implement semantically safe fixes, and verify behavior plus repository budgets. Use for trace files, reported profiling durations or call chains, dropped frames, long tasks, resize or scroll jank, render storms, layout thrashing, selector hot paths, interaction latency, or requests to locate exact source-level bottlenecks.
---

# Analyze Performance Traces

End with an evidence chain from trigger to exact source. Fix the earliest proven cause. Never turn an API name or an inclusive duration into a causal claim without checking execution context.

## Choose the evidence mode

State which mode applies before making findings:

1. **Trace-backed**: a trace is supplied or discoverable. Durations, processes, threads, and event ordering may be reported from it.
2. **Reported-finding audit**: the user supplies durations or a chain but not the artifact. Treat those details as leads. Confirm current source paths and trigger conditions; label the durations, thread, and invalidation scope unverified.
3. **Source-only**: no trace-derived lead exists. Report hypotheses, not measured bottlenecks.

Do not block a reported-finding audit merely because the original trace file is absent. If the user asks for safe implementation after the source chain is proven, proceed within authorization; require a comparable post-change trace before claiming millisecond or frame-rate improvement.

If neither a trace nor a concrete lead exists, ask for the smallest reproducible capture unless the user explicitly wants source-only analysis.

## Start safely

1. Read repository instructions, nearest area instructions, relevant architecture docs, current diff, and validation policy. Record Git baseline before editing.
2. Discover trace artifacts without printing them wholesale. For each candidate:

   ```sh
   ls -lh TRACE.json
   head -c 512 TRACE.json
   tail -c 512 TRACE.json
   ```

3. Run the bundled bounded-memory summarizer:

   ```sh
   node <skill-dir>/scripts/summarize-trace TRACE.json --top 40 --min-ms 16
   ```

4. Record trace revision/build, production versus development mode, profiling hooks, source maps, screenshots, React tracks, renderer count, and capture window. Separate profiler startup and instrumentation overhead from product work.
5. Prefer a repository-owned performance runner when it reproduces the same interaction. List scenarios first; a convenient but different scenario is not proof. In this repository, inspect `docs/conventions/testing.md` and use `pnpm perf:agent-gui -- --list-scenarios` when relevant.

### Tutti manual capture

When a new Desktop trace is required:

```sh
TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT=9223 \
TUTTI_ELECTRON_JS_FLAGS=--max-old-space-size=8192 \
VITE_TUTTI_WHY_DID_YOU_RENDER=0 \
make dev-gui
```

Then capture from another terminal:

```sh
pnpm trace:desktop -- --duration 15
```

## Build one evidence chain

Work in this order:

1. **Select process/thread**: identify browser main, renderer main, compositor, workers, and GPU threads. Never sum unrelated threads.
2. **Select the window**: locate the interaction or burst containing the symptom. Quantify long tasks, layout/style, scripting, paint, frame signals, and repeated events only inside that window.
3. **Correlate timestamps**: connect input, timer, stream, resize, or observer delivery to state updates, React commits, DOM mutation, style/layout, paint, and missed frames.
4. **Measure fanout**: count repeated components, selectors, entities, DOM nodes, or geometry reads. Express multiplicative patterns such as `34 sections × 67 updates = 2,278 renders`.
5. **Map to source**: use stack URLs, source maps, named React tracks, event handlers, class names, and unique strings. Follow symbols with `rg`. Verify current source still matches the traced revision.
6. **Inspect cardinality**: use read-only DB/query inspection when scale explains the cost. Remove local paths, secrets, and personal data from durable output.
7. **State the chain**:

   ```text
   trigger → state/DOM write → churn or invalidation → render/layout fanout → paint/frame impact
   ```

Keep measured facts, source-confirmed facts, and inference visibly separate. Do not rank nested events only by inclusive time; use self time when available or label duration inclusive.

## Audit forced layout precisely

For every suspected geometry hotspot, record:

| Field          | Question                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Trigger        | What invokes it, and how often?                                                                   |
| Invalidation   | Which DOM/style write may have dirtied layout first?                                              |
| Read/operation | `scrollHeight`, `client*`, `offset*`, rect/style read, `scrollIntoView`, virtualizer measurement? |
| Phase          | render, ref commit, layout effect, effect, observer, event, or animation frame?                   |
| Scope          | Which scroll/layout subtree must become current?                                                  |
| Semantics      | Why is the read needed: selection, bottom lock, prepend anchor, tooltip, placement?               |
| Evidence       | Trace-backed, source-confirmed path, or inference?                                                |

Apply these rules:

- A geometry API can force layout only when relevant layout is dirty. Its presence alone is not proof.
- A layout effect after a DOM-heavy commit is high risk because the read occurs before paint while invalidation is pending.
- `ResizeObserver` runs after layout calculation; a read-first callback usually consumes current geometry. Writes earlier in the same observer delivery can dirty layout again, so keep observer callbacks read-first, then write.
- `requestAnimationFrame`, scroll events, and ordinary effects are not automatically layout-clean.
- `scrollIntoView` performs synchronous visibility/scroll calculation. An explicit low-frequency reveal may still be correct and cheaper than changing interaction timing.
- Replacing `scrollIntoView` with `offsetTop`, rect reads, or computed style does not inherently remove forced layout.
- Distinguish **natural layout work** from **synchronously forced scheduling**. Observer-driven code may coalesce layout without eliminating the layout itself.
- Do not claim “whole page/tree layout” without trace scope, layout-object evidence, or containment analysis.

## Recognize root-cause families

- Reducer recreates every entity when derived values are unchanged.
- Memoized child receives fresh callbacks, arrays, objects, or context projections.
- Selector scans/sorts all entities once per consumer, producing `O(S × (T + I))` work.
- Streaming or resize commits trigger unconditional scroll-container geometry reads.
- A measurement effect reads, writes state/style, then causes another render/layout pass.
- The same resize is covered by both `ResizeObserver` and a global resize listener.
- Virtualizer DOM writes are followed by parent scroll geometry reads in the same commit.
- Development profiling, extensions, or source-map instrumentation dominate the apparent frame.

Fix the earliest owner. Do not hide producer churn with broad leaf memoization or replace a proven geometry problem with timing heuristics.

## Choose a fix without semantic drift

### Data and render churn

- Reuse references when every rendered/derived value is exactly equal.
- Stabilize event-time callbacks without freezing stale reads.
- Replace repeated scans with one-pass grouping while preserving filters, orphan rules, stable ordering, and tie-breakers.
- Keep exact comparators in named helpers.
- Avoid persistent indexes unless evidence proves ephemeral grouping insufficient.

### DOM geometry and scrolling

- Separate **semantic pre-paint commands** from **high-frequency content growth**. Conversation switches, explicit submit-to-bottom, focus, and prepend restoration may require layout-phase correction; ordinary streaming growth should not automatically share that path.
- Before reading geometry, gate on the semantic branches that genuinely need it. A hot update that requires no scroll side effect should return before any geometry read.
- For continuing content/viewport growth, prefer observing the actual content box and viewport. Consume geometry after layout while preserving bottom lock, user scroll-away, prepend anchors, and explicit reveal identity.
- Expose a narrow content ref through the owning primitive when needed; avoid brittle queries into private DOM structure.
- Remove a global resize listener only when element/parent observation covers the same geometry changes.
- Preserve initial observer delivery and text/content-change remeasurement; observing a fixed outer box alone may miss intrinsic overflow changes unless observation is re-established or the measured node resizes.
- Avoid CSS containment, `content-visibility`, or size containment around virtualized/dynamic-height content unless measurement, sticky, focus, overlay, and clipping behavior are proven equivalent.
- Reuse an existing lifecycle effect/observer owner when repository budgets constrain effect count. Do not raise an architecture baseline to land an optimization.

### Visibility classification

Treat a change as strictly behavior-preserving only when rendered values, ordering, scroll/focus timing, lock ownership, mounted state, and side effects remain equivalent.

Usually safe after exact tests:

- return before an unused geometry read;
- consume observer-delivered geometry while preserving the same lock and anchor transitions;
- remove a redundant event source with equivalent observation coverage;
- reuse references or replace equivalent scans.

Potentially user-observable; exclude or request direction unless explicitly authorized:

- debounce, throttle, or move behavior to a later animation frame/effect;
- IntersectionObserver visibility gating;
- delayed reveal or autofocus;
- always showing a tooltip instead of measuring overflow;
- virtualization/unmounting, stale caching, event dropping, or reduced animation rate.

## Implement with direct performance tests

1. Preserve architecture and local ownership. Do not add compatibility, fallback, or timing layers without evidence.
2. Add tests that expose both semantics and the expensive operation:
   - spy on geometry getters; after stable mount, a hot streaming rerender should perform zero synchronous reads when no semantic scroll command exists;
   - mock `ResizeObserver`, deliver it explicitly, and verify bottom lock plus user scroll-away;
   - verify prepend, selection, focus, reveal revision, tooltip overflow, and native/custom primitive variants affected by the change;
   - add structural-sharing identity tests for render-churn fixes.
3. Scan sibling callsites by mechanism, not API string alone. Classify each as confirmed same trigger, structurally similar but different frequency/semantics, or unverified.
4. Run formatter and focused tests while iterating. Inspect the repository's changed-aware dry-run before the final gate.
5. Run architecture budgets/boundaries. If a metric increases, redesign or merge ownership; never raise the baseline merely to pass.
6. Run the repository-selected final validation once the diff settles. Perform the documentation-impact and durable-lesson check.

## Validate and report

Validate at three levels:

- **Semantic**: identical values, ordering, filtering, focus, scroll lock, reveal, prepend, and event behavior.
- **Structural**: stable references, bounded render fanout, and no new duplicate effect/observer owner.
- **Performance**: prevented hot-path reads/renders proven by tests; comparable trace when practical.

Report:

1. evidence mode and process/thread/window facts;
2. exact source chain and trigger frequency;
3. measured facts versus source inference;
4. fixes grouped by behavior-preserving versus timing-sensitive;
5. implementation-plan changes caused by gates or counter-evidence;
6. tests, typechecks, boundaries, and changed-aware result;
7. same-mechanism sweep: included, excluded, and why;
8. documentation impact and line-count distribution when code changed;
9. anything unverified, especially missing post-change trace.

Never claim millisecond, frame-rate, or layout-scope improvement without a comparable post-change capture. It is valid to claim a proven reduction such as “ordinary streaming rerender performs zero synchronous `scrollHeight` reads.”

## Bundled script

`scripts/summarize-trace` streams `traceEvents`, keeps bounded top-event state, and outputs JSON with thread metadata, event totals, long tasks, frame signals, and source hints. Use it first for large traces; write narrow follow-up scripts only after a specific hypothesis exists.
