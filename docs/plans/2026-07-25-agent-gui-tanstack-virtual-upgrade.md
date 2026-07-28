# AgentGUI TanStack Virtual Upgrade Plan

Status: implemented on 2026-07-25

## Goal

Reduce AgentGUI transcript scroll and layout work by upgrading TanStack Virtual
and letting it own the chat-list mechanics it already implements.

Keep Turn-level virtualization in the first implementation. Row-level
virtualization is a later step only if traces still show that one oversized
active Turn is the main bottleneck.

## Current evidence

- `@tutti-os/agent-gui` declares `@tanstack/react-virtual: ^3.13.12`.
- The lockfile currently resolves `@tanstack/react-virtual` 3.13.26 and
  `@tanstack/virtual-core` 3.16.0.
- The current virtualizer counts transcript Turn groups, uses stable Turn-group
  keys, dynamically measures mounted groups, anchors to the end outside Turn
  disclosure motion, and uses six Turn groups of overscan.
- `followOnAppend`, `isAtEnd`, `getDistanceFromEnd`, `scrollToEnd`,
  `scrollToIndex`, `rangeExtractor`, `initialMeasurementsCache`, and
  `takeSnapshot` already exist in the resolved core version.
- `AgentTranscriptView` does not enable `followOnAppend`.
- `useAgentGUIDetailScroll` separately owns bottom following, content-resize
  bottom correction, and `scrollHeight`-delta prepend compensation.
- The older-message loading indicator is a normal-flow sibling before
  `AgentConversationFlow`. While it is visible, the virtual list does not start
  at the scroll element's origin.
- The transcript virtualizer and `useAgentGUIDetailScroll` can therefore react
  to the same content-size change. This split ownership is the main
  simplification target.
- The latest packages checked on 2026-07-25 are
  `@tanstack/react-virtual` 3.14.8 and `@tanstack/virtual-core` 3.17.6.
  React Virtual 3.14.8 depends on Virtual Core 3.17.6.
- The newer releases add eager prepend reconciliation, safer dynamic-size
  adjustment, cached remeasurement, iOS momentum handling, and React
  `directDomUpdates`.

The original Browser-behind-AgentGUI visual tearing report is not a proven
TanStack bug. Renderer pressure and Electron webview stacking remain separate
candidate mechanisms.

## Decisions

### 1. Upgrade before changing virtualization granularity

Upgrade:

```text
@tanstack/react-virtual  3.13.26 -> 3.14.8
@tanstack/virtual-core   3.16.0  -> 3.17.6 (transitive)
```

Update the manifest minimum to `^3.14.8` so the declared contract includes the
React APIs used by the implementation.

Do not add a direct `@tanstack/virtual-core` dependency. AgentGUI consumes the
React adapter, and its exact core dependency supplies the matching core.

### 2. Keep Turn-level virtual items initially

The first implementation keeps:

```text
virtual item = presentation Turn group + its Turn attachments
```

This preserves:

- completed Turn disclosure and auto-collapse;
- canonical Turn versus presentation-group separation;
- `goal-control` rows with `turnId: null`;
- current locator and attachment group indexes;
- current spacing, dividers, participant headers, and CSS grouping.

The change reduces scroll coordination and React/layout overhead. It does not
bound the DOM inside one mounted oversized running Turn.

### 3. Give each scroll behavior one owner

When Turn virtualization is active, TanStack owns item-list geometry changes.
When virtualization is inactive, `useAgentGUIDetailScroll` keeps the current
native DOM behavior.

| Behavior                                    | Virtualized owner                                  | Non-virtual owner         |
| ------------------------------------------- | -------------------------------------------------- | ------------------------- |
| New Turn appended while already at the end  | `followOnAppend`                                   | `useAgentGUIDetailScroll` |
| Last Turn grows while streaming             | `anchorTo: "end"` plus `measureElement`            | content `ResizeObserver`  |
| Older Turns prepended                       | stable keys, `scrollMargin`, and `anchorTo: "end"` | `scrollHeight` delta      |
| Determine whether latest content is visible | `isAtEnd()`                                        | DOM geometry              |
| User requests “scroll to bottom”            | `scrollToEnd()`                                    | native smooth scroll      |
| Locate an offscreen Turn or attachment      | `scrollToIndex()`                                  | DOM lookup                |
| Trigger older-history loading near the top  | AgentGUI                                           | AgentGUI                  |
| Detect wheel, keyboard, or pointer intent   | AgentGUI                                           | AgentGUI                  |
| Conversation selection and identity fencing | AgentGUI                                           | AgentGUI                  |
| Bottom-dock safe-area measurement           | AgentGUI                                           | AgentGUI                  |

AgentGUI must not apply its manual prepend delta or content-resize bottom write
after TanStack has accepted ownership of the virtualized branch.

### 4. Expose a narrow virtual-scroll controller

`AgentTranscriptView` owns the TanStack instance. The detail pane still owns
the product-level scroll button, loading trigger, conversation switch, and
native non-virtual branch.

Pass a ref through:

```text
AgentGUIDetailPane
  -> AgentGUIDetailTimeline
  -> AgentGUIConversationTimelinePane
  -> AgentConversationFlow
  -> AgentTranscriptView
```

The ref exposes only presentation scrolling:

```ts
interface AgentTranscriptVirtualScrollController {
  agentSessionId: string;
  enabled: boolean;
  isAtEnd(): boolean;
  scrollToEnd(options?: { behavior?: ScrollBehavior }): void;
}
```

`scrollToIndex` remains internal to `AgentTranscriptView`, because locator and
attachment indexes belong to the transcript projection.

Every controller use must check the exact `agentSessionId`. A controller from
the previous Session must not move the newly selected timeline.

TanStack measurement keys must also include
`conversation.sourceDetail.session.agentSessionId`. A Turn-group key is stable
inside one Session, but it is not a repository-wide Session identity. Prefixing
it prevents one Session from reading another Session's cached height.

### 5. Use the chat parameters deliberately

Target virtualizer configuration:

```ts
useVirtualizer({
  count: turnGroups.length,
  getScrollElement: () => virtualScrollElement,
  getItemKey: (index) =>
    `${agentSessionId}\u0000${turnGroups[index]?.key ?? index}`,
  estimateSize: () => AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX,
  overscan: AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN,
  scrollMargin: virtualListOffsetFromScrollOrigin,
  anchorTo: hasMovingTurnDisclosure ? "start" : "end",
  followOnAppend: hasMovingTurnDisclosure ? false : true,
  scrollEndThreshold: 24,
  directDomUpdates: true,
  directDomUpdatesMode: "transform",
  useFlushSync: true
});
```

Rules:

- `followOnAppend` handles only a count increase with a new last key while the
  previous list was at the end.
- Memoize the Session-prefixed `getItemKey` callback so unrelated renders do
  not invalidate measurement work.
- Measure `scrollMargin` from the timeline scroll origin to the virtual
  container. Recompute it when the older-message loading indicator appears or
  disappears. Direct DOM transform mode subtracts this option when positioning
  items.
- Before direct DOM updates are enabled, AgentGUI's JSX transform must subtract
  the same `scrollMargin`. Task 3 removes that JSX transform when TanStack takes
  over item positioning.
- Do not remove manual prepend compensation until the measured `scrollMargin`
  path is active. Otherwise the external loading indicator can move every
  rendered Turn without TanStack knowing that the list origin moved.
- Streaming growth of the existing last Turn is handled by end anchoring and
  measurement, not `followOnAppend`.
- During disclosure motion, keep start anchoring, disable append following,
  keep the existing pinned-row behavior, and suppress TanStack size-change
  correction.
- Keep `useFlushSync: true` for the first implementation. Test
  `useFlushSync: false` separately only if a trace still identifies synchronous
  React commits as a material cost.
- Do not enable `useAnimationFrameWithResizeObserver` without trace evidence;
  it intentionally delays measurement by one frame.
- Do not enable `useCachedMeasurements` unless AgentGUI keeps the same
  transcript mounted but CSS-hidden. Conversation replacement is not that
  case.
- Do not add snapshot restoration. The current product contract opens a newly
  selected conversation at the latest content.
- Do not add a custom `rangeExtractor` until a real offscreen item must remain
  mounted.

### 6. Use direct DOM updates only with its required markup

With `directDomUpdates: true`:

- attach `rowVirtualizer.containerRef` to the inner virtual-size container;
- remove its JSX `height: rowVirtualizer.getTotalSize()` value;
- keep each virtual item `position: absolute`, `top: 0`, and `left: 0`;
- remove each item's JSX main-axis `transform`;
- keep `measureElement` and `data-index`;
- keep cross-axis width and Turn-specific bottom padding in AgentGUI.

The existing CSS already satisfies the absolute-position requirements.

Transform mode creates a stacking context and usually a compositor layer per
item. Because the reported visual symptom involves an Electron webview, landing
this option requires both trace evidence and a real-pixel/webview-order check.
If transform mode reproduces the visual fault, compare the upgraded virtualizer
without direct DOM updates before considering position mode. Do not ship an
unmeasured mode switch.

## What stays in AgentGUI

TanStack does not understand AgentGUI domain semantics. These remain
application-owned:

- transcript row and Turn-group projection;
- canonical Turn identity and presentation grouping;
- `goal-control` rows without Turn ownership;
- Turn disclosure and completion-time collapse;
- user-message locator and Turn-attachment index mapping;
- exact Session identity and stale-controller fencing;
- older-page request state and top-prefetch policy;
- participant headers, dividers, spacing, and attachment placement;
- tool-group disclosure and its inner DOM;
- Browser webview visibility, stacking, and pixel correctness.

## Implementation tasks

### Task 1: Upgrade and lock the dependency

Files:

- `packages/agent/gui/package.json`
- `pnpm-lock.yaml`

Steps:

1. Update `@tanstack/react-virtual` to `^3.14.8`.
2. Install with the repository package manager.
3. Confirm the lockfile resolves React Virtual 3.14.8 and Core 3.17.6.
4. Run the focused AgentGUI typecheck before behavior changes.

### Task 2: Add the virtual-scroll controller and behavior delegation

Files:

- `packages/agent/gui/shared/agentConversation/components/AgentTranscriptView.tsx`
- `packages/agent/gui/shared/agentConversation/components/AgentConversationFlow.tsx`
- `packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIConversationTimelinePane.tsx`
- `packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIDetailTimeline.tsx`
- `packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIDetailPane.tsx`
- `packages/agent/gui/agent-gui/agentGuiNode/view/useAgentGUIDetailScroll.ts`

Steps:

1. Add the exact-conversation virtual-scroll controller.
2. Prefix TanStack item keys with the exact Agent Session id.
3. Pass older-message loading state as a virtual-list layout revision and
   measure the list's `scrollMargin`.
4. Subtract `scrollMargin` in the existing JSX transform.
5. Enable `followOnAppend` outside disclosure motion.
6. Route virtualized at-end reads and explicit bottom requests through TanStack.
7. Disable the outer content-resize bottom write for virtualized transcripts.
8. Disable manual prepend-delta restoration for virtualized transcripts only
   after `scrollMargin` is active.
9. Preserve the native branch unchanged for short transcripts.

### Task 3: Enable direct DOM updates

Files:

- `packages/agent/gui/shared/agentConversation/components/AgentTranscriptView.tsx`
- `packages/agent/gui/app/renderer/agentactivity.css`

Steps:

1. Attach `containerRef`.
2. Remove React-owned virtual container height and item transform.
3. Keep disclosure spacing, measurement, and locator attributes.
4. Confirm the option remains fixed for the virtualizer's mount lifetime.

### Task 4: Add and update behavior coverage

Files:

- `packages/agent/gui/shared/agentConversation/components/AgentTranscriptView.virtual.spec.tsx`
- `packages/agent/gui/agent-gui/agentGuiNode/view/useAgentGUIDetailScroll.spec.tsx`
- relevant detail timeline render-budget specs

Required cases:

1. A new Turn follows only when the previous viewport was at the end.
2. Streaming growth remains bottom-locked at the end.
3. Wheel, keyboard, and pointer scroll-away intent prevents following.
4. A submitted prompt explicitly returns to the end.
5. Older-history prepend preserves the visible Turn without a manual DOM delta.
6. Showing and hiding the older-message loading indicator does not move the
   visible Turn.
7. Disclosure motion keeps its pinned position and does not follow appends.
8. The scroll-to-bottom button uses TanStack only for the matching Session.
9. Switching Sessions cannot reuse the previous Session's measurement keys.
10. Locator and attachment scrolling still reach offscreen Turn groups.
11. Direct DOM mode owns container height and item transforms.

### Task 5: Capture before/after performance evidence

Use the same database snapshot and viewport for both captures.

Run:

- `virtualized-streaming`;
- `virtualized-scroll-locator`;
- repeated long/short Session switching;
- an oversized live-Turn case matching approximately 19 Turns, 250 tool calls,
  and at least 40 tool calls in the active Turn.

If the oversized live-Turn case becomes a named performance scenario, add it to
`tools/scripts/agent-gui-layout-performance-scenarios.mjs`, its registry tests,
and `docs/conventions/testing.md`.

Compare:

- React commit and render work;
- `Layout` and `UpdateLayoutTree`;
- scroll event duration and long tasks;
- mounted Turn and row counts;
- viewport jumps during prepend, append, disclosure, and Session switch.

Also reproduce with a Browser node mounted behind AgentGUI and inspect real
pixels. DOM count or trace improvement alone does not prove the original visual
tearing is fixed.

## Acceptance gates

The first implementation may land when:

- all required behavior cases pass;
- virtualized prepend and loading-indicator transitions have no manual
  `scrollHeight` compensation;
- a user reading history is never pulled to the end by streaming or append;
- Session switching never shows or scrolls the previous Session;
- existing disclosure, locator, and attachment behavior is unchanged;
- `virtualized-streaming` and `virtualized-scroll-locator` do not regress;
- the chosen direct DOM mode improves or preserves measured trace results;
- Browser-behind-AgentGUI pixel validation shows no new stacking fault.

If traces still show one oversized active Turn dominating render or DOM work,
continue with stable render-unit virtualization. Do not use the current
complexity score as a split threshold: it can be high even when the expensive
content is one indivisible tool-group row.

## Implementation evidence

- The manifest resolves React Virtual 3.14.8 and Virtual Core 3.17.6.
- AgentGUI package typecheck and all 2,341 package tests pass.
- `virtualized-scroll-locator` passes all 24 gates. The locator index moves
  monotonically from 14 to 0 with zero reverse or return transitions; measured
  `Layout` is 31.58 ms and `UpdateLayoutTree` is 348.77 ms.
- `virtualized-streaming` remains within the same observed range as the source
  snapshot: 2,258.26 ms after the change versus 2,212 ms before it. This is
  preservation evidence, not a broad speedup claim.
- `virtualized-session-cycle` passes two long/short round trips and observes
  `native → virtual → native → virtual`.
- `virtualized-oversized-active-turn` reaches 19 Turns and 250 tool calls while
  keeping only 9 virtual Turns mounted. Its 1,118 `AgentGUINode` markers show
  that stable render-unit virtualization has real evidence for a separate
  follow-up, but it remains outside this upgrade.
- `browser-behind-agent-gui-pixels` captures the high-contrast Browser fixture
  first, then the fullscreen AgentGUI covering that still-mounted webview. The
  composited screenshot has no visible fixture-color leakage.

## Deferred render-unit virtualization

The deferred design uses one pure projection that emits stable render units and
all indexes consumed by locators and attachments:

```ts
interface AgentTranscriptRenderUnitProjection {
  units: readonly AgentTranscriptRenderUnit[];
  unitIndexByRowIndex: ReadonlyMap<number, number>;
  unitIndexByRenderKey: ReadonlyMap<string, number>;
  anchorUnitIndexByPresentationGroup: ReadonlyMap<string, number>;
  lastUnitIndexByCanonicalTurnId: ReadonlyMap<string, number>;
  unitIndexByAttachmentId: ReadonlyMap<string, number>;
}
```

The active Turn is split from the start. A settled collapsed Turn remains one
unit. A stable group-anchor key survives active-to-settled presentation so the
visible anchor is not deleted during collapse.

This phase requires its own design review and performance evidence. It is not
part of the TanStack upgrade.

## References

- [TanStack Virtual chat guide](https://tanstack.com/virtual/latest/docs/chat)
- [TanStack Virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer)
- [TanStack Virtual performance and iOS notes](https://tanstack.com/blog/tanstack-virtual-perf-and-ios)
- [TanStack eager prepend reconciliation](https://github.com/TanStack/virtual/pull/1176)
- [TanStack React Virtual source](https://github.com/TanStack/virtual/blob/main/packages/react-virtual/src/index.tsx)
- [TanStack Virtual Core source](https://github.com/TanStack/virtual/blob/main/packages/virtual-core/src/index.ts)
