# Workbench Dock Model

This document defines the target dock model for
`@tutti-os/workbench-surface`.

The goal is to make dock behavior expressive enough for product-grade desktop
navigation without forcing hosts to encode business state into node `typeId`,
icon render trees, CSS hacks, or placeholder nodes.

## Problem Summary

Workbench dock behavior must support product navigation concerns such as:

- one node type with multiple provider-specific dock entries
- entries that are hidden by default but appear when matching nodes exist
- grouped dock sections with stable ordering and separators
- host-controlled disabled, loading, unavailable, and install/sync guidance
- host-controlled badge and attention state
- stable semantic anchor keys that are not equal to node `typeId`

These are dock concerns, not node-type concerns, so the dock model should be
entry-centric rather than type-centric.

## Design Goals

The target model should:

1. separate node type identity from dock entry identity
2. keep business workflow state owned by the consuming host
3. support default dock rendering with low host integration cost
4. allow narrow presentation overrides without redefining the dock model
5. preserve snapshot purity by keeping transient launch payloads out of
   persisted layout state
6. keep dock grouping, popup behavior, and anchor lookup stable across empty,
   active, and restored workbench sessions

## Non-Goals

This change does not try to:

- make `workbench-surface` understand product-specific workflows such as agent
  installation, provider sync, or transfer lifecycle semantics
- turn dock hover content into a general-purpose business popover framework
- store host-owned workflow state in workbench snapshots

## Ownership Boundaries

`workbench-surface` should own:

- dock layout, grouping, separator, popup, and anchor mechanics
- default dock entry rendering and keyboard/pointer interaction
- normalized badge, state, attention, and hover-action presentation
- event dispatch for dock entry interactions

The consuming host should own:

- dock entry configuration data
- business-state derivation for entry visibility, disabled/loading state, and
  badges
- install, sync, retry, or other domain actions
- launch payload semantics
- custom presentation overrides beyond the default dock primitives

This keeps the shared package thin and stable while still reducing repeated UI
work for hosts.

## Core Model

The dock should be modeled as a host-level collection of dock entries rather
than as a property of node definitions.

### Node Definitions

`WorkbenchHostNodeDefinition` continues to describe shell-level behavior for a
node type:

- `typeId`
- default frame and title
- renderers
- instance strategy
- window capabilities

Node definitions should not be the primary source of dock slot identity,
ordering, visibility, badge state, or provider-specific grouping.

### Dock Entries

Each dock entry describes one navigation target in the host chrome.

Illustrative shape:

```ts
export interface WorkbenchHostDockEntry {
  id: string;
  typeId: string;

  label: string;
  icon: ReactNode;

  sectionId?: string;
  order?: number;
  anchorKey?: string;

  visibility?: "always" | "when-open" | "never";
  launchBehavior?: "enabled" | "disabled";
  launchPayload?: unknown;

  state?: {
    kind: "enabled" | "disabled" | "loading" | "unavailable";
    reason?: string;
  };

  badge?:
    | { kind: "count"; value: number }
    | { kind: "status"; status: "running" | "completed" | "failed" | "warning" }
    | { kind: "custom"; content: ReactNode };

  attentionToken?: string | number | null;

  capturePopupItemPreview?: (
    input: WorkbenchHostDockPopupItemInput
  ) => Promise<string | null> | string | null;

  resolvePopupItem?: (
    input: WorkbenchHostDockPopupItemInput
  ) => WorkbenchHostDockPopupItemDescriptor;

  hoverActions?: readonly {
    disabled?: boolean;
    id: string;
    label: string;
    pendingLabel?: string;
  }[];

  matchNode?: (node: WorkbenchNode<WorkbenchHostNodeData>) => boolean;
}
```

Key points:

- `id` is the dock identity key
- `typeId` says what kind of node this entry launches
- `anchorKey` defaults to `id`
- `launchPayload` is transient launch input, not persisted layout state
- popup title, subtitle, and preview remain host-controlled through narrow
  entry hooks
- `matchNode` is a fallback, not the preferred grouping mechanism

### Dock Entry Affinity

Launched or projected nodes may need to declare which dock entry they belong
to.

Illustrative shape:

```ts
export interface WorkbenchHostNodeData {
  typeId: string;
  instanceId: string;
  instanceKey?: string | null;
  dockEntryId?: string | null;
}
```

`dockEntryId` is the preferred mechanism for popup grouping, anchor lookup, and
stable dock reappearance after snapshot restore.

When `dockEntryId` is missing, a dock entry may still match nodes through
`matchNode`, but that path should stay secondary.

### Launch Payload

Launch should support host-provided payloads without overloading `typeId`.

Illustrative shape:

```ts
export interface WorkbenchHostLaunchInput {
  reason: "dock" | "command" | "shortcut" | "host";
  typeId: string;
  payload?: unknown;
  dockEntryId?: string;
}

export interface WorkbenchHostLaunchRequest extends WorkbenchHostLaunchInput {
  workspaceId: string;
}

export interface WorkbenchHostLaunchResult {
  typeId: string;
  instanceId: string;
  instanceKey?: string | null;
  title?: string;
  defaultFrame?: WorkbenchFrame;
  activation?: {
    type: string;
    payload?: unknown;
  } | null;
  dockEntryId?: string;
}
```

Rules:

- launch payloads are transient
- launch payloads are not written to snapshots
- `dockEntryId` is stable shell affinity metadata and may be persisted

## Visibility And Launch Semantics

Dock visibility and launchability should be modeled separately.

### Visibility

- `always`: render the dock entry even when no matching node exists
- `when-open`: render the dock entry only when one or more matching nodes exist
- `never`: never render the dock entry

`when-open` is the intended solution for entries that are not part of the
default navigation set but should appear when a matching node is already open
or restored from snapshot.

Installed workspace applications default to `when-open`: installation makes an
application launchable from App Center but does not pin it to the Dock. A host
may persist an explicit Keep in Dock choice and override visibility to `always`;
closing the last matching node hides an application without that retained choice.

### Open-State Indicator

An entry with a matching open or minimized node renders the shared Dock state
indicator; a closed entry does not. This is a Workbench interaction invariant,
not an application-specific presentation choice. Dock placement may reposition
the indicator but must not suppress it: the bottom Dock places it below the
icon, while the left Dock places it to the left and vertically centers it.

The indicator state follows canonical `dockEntryId` affinity. Hosts should
migrate stale durable affinity values rather than loosen exact matching or add
application-specific CSS exceptions.

### Launch Behavior

- `enabled`: dock may create a new node when click behavior resolves to launch
- `disabled`: dock never launches a new node, but may still render and surface
  hover content

This avoids overloading a single boolean to describe both visibility and
interactivity.

## Grouping, Ordering, And Separators

Dock ordering should not depend on `nodeDefinitions` array order.

The preferred structure is:

- `sectionId` groups adjacent entries into visual sections
- `order` sorts entries inside a section
- the host renderer inserts separators between section changes

This model is more stable than `separatorBefore` and `separatorAfter` flags and
better matches product-owned dock organization.

## Popup And Click Behavior

Dock interaction should follow stable, entry-level rules.

Dock magnification snapshots viewport and slot geometry once when a pointer
session starts. Later animation frames derive centered or overflow-aligned slot
positions from that snapshot and the sizes already written by the spring. They
must not interleave per-frame `getBoundingClientRect()` reads with slot size
writes. Resetting the interaction or changing slot membership invalidates the
snapshot.

Native popup previews pass the clamped target rectangle to Electron capture;
they must not capture the whole `webContents` and crop afterward. A native
region capture is valid only for the foreground node represented by those
composited pixels. When native capture misses, a popup first reads the Node's
shared latest Dock preview from memory. After a memory miss, it reads the
unrevisioned persistent latest identity and the exact-revision identity in
parallel. The shared latest entry wins; an exact-revision entry is a
compatibility fallback for previously captured generations and is promoted to
the shared identity when used. When every cache source misses, a non-minimized
background node may fall back to a DOM-cloned snapshot. Successful native and
DOM captures update the one shared latest entry, so popup and minimize capture
reuse the same bounded Dock PNG without duplicating persistent writes or
sharing the full-resolution Genie animation texture. DOM
fallbacks run serially, are deduplicated by preview identity and revision, and
yield the renderer task queue between clones so a large popup cannot turn the
serialized work into one microtask-bound long task. They persist only successful
images so repeated popup openings do not repeat the expensive clone. Minimized
nodes must not request a fresh DOM snapshot because
their bodies may be unhydrated or their imperative resources may be inactive.
A failed capture is terminal only for the mounted popup; it must not be retained
across popup lifetimes because the node may be foreground the next time. Popup
capture effects are keyed by preview identity and revision, not transient item
arrays or callback references. Cleanup may fence stale UI writes, but it must
retain the pending marker for a native capture that has already started until
that capture settles, because Electron capture cannot be canceled. Skeletons
represent in-flight capture only; a terminally unavailable preview uses a
non-loading static placeholder.

Dock popup responsibilities stay split by lifecycle: `WorkbenchHostDockPopup`
owns portal/layout and dismissal, `WorkbenchHostDockPopupPresentation` owns
cards and context-menu rendering, and
`useWorkbenchHostDockPopupPreviewCapture` owns capture, pending-operation
fencing, and preview caches.

`WorkbenchHost` normalizes its preview capture callbacks in both directions.
Hosts that can capture `captureNodePreviewImages` do not also need to provide
`captureNodePreviewImage`; the surface derives the Dock image from
`dockPreviewImageUrl`. The legacy single-image callback remains supported and
is preferred when both callbacks are present, so normalization never starts a
second native capture.

### Matching

For each dock entry, the host resolves matching nodes using:

1. `node.data.dockEntryId === entry.id`
2. fallback `entry.matchNode(node)` when `dockEntryId` is unavailable

Grouping by `typeId` alone should no longer be the default.

### Click Resolution

Suggested default behavior:

1. if the entry state is `disabled`, `loading`, or `unavailable`, do not launch
2. if there is exactly one matching node, restore and focus that node
3. if there are multiple matching nodes, open the dock popup
4. if there are no matching nodes and launch is enabled, dispatch a launch
   request using `typeId`, `dockEntryId`, and `launchPayload`

This keeps dock behavior focused on navigation first and creation second.

## State, Badge, And Attention

Dock entry state should be host-controlled and surface-rendered.

### State

The shared package should recognize normalized presentation states:

- `enabled`
- `disabled`
- `loading`
- `unavailable`

The shared package may provide default visuals through explicit asset subpaths
and may provide tooltip treatment for these states, but it should not own the
underlying workflow state machine.

Dock placement may adapt those visuals without changing node state semantics.
The bottom Dock renders the existing open/minimized status dot below the icon.
The left Dock keeps one centered icon axis without reserving a horizontal
gutter, and renders the same indicator to the left of the icon.

### Badge

Dock entries should support:

- count badges
- normalized status badges
- optional custom badge content through a narrow override

Hosts should not be forced to hide badge logic inside icon render trees.

### Attention

Dock attention should be modeled as a change token rather than a persistent
boolean.

`attentionToken` should trigger a one-shot animation when the value changes,
allowing hosts to signal events such as completed transfers without forcing the
shared package to understand business semantics.

## Dynamic Dock State Source

`dockEntries` should describe stable dock identity and launch wiring. They
should not become the transport for high-churn business state such as provider
installation, authentication, quota, sync, or usage status.

When a dock entry needs live business state, the host should provide a dynamic
state source beside the static entry list:

```ts
export type WorkbenchHostDockEntryDynamicState = Partial<
  Pick<
    WorkbenchHostDockEntry,
    | "attentionToken"
    | "badge"
    | "hoverActions"
    | "launchBehavior"
    | "state"
    | "visibility"
  >
>;

export interface WorkbenchHostDockEntryStateSource {
  getEntryState(
    entryId: string
  ): WorkbenchHostDockEntryDynamicState | null | undefined;
  subscribe(listener: () => void): () => void;
}

export interface WorkbenchHostProps {
  dockEntries: readonly WorkbenchHostDockEntry[];
  dockStateSource?: WorkbenchHostDockEntryStateSource;
}
```

Rules:

- keep `dockEntries` referentially stable for a workspace whenever node
  registration and launch wiring did not actually change
- use `dockStateSource` for dynamic presentation fields such as disabled
  state, install/login hover actions, loading labels, badges, attention tokens,
  and temporary visibility changes
- the source should expose getters over the owning service/store rather than
  copying business state into the Workbench host input
- source updates should re-render the dock only; they must not recreate the
  Workbench host session, node definitions, or active node shells
- avoid using a host-level revision prop or React state just to force
  `createHostInput(...)` to run after every business-status update

This separation lets a host show local CLI install/login status in the dock
while keeping open Agent GUI or terminal nodes stable during status refreshes.

## Hover Actions And Default Components

The shared package should provide reliable default dock primitives to reduce
host implementation cost:

- dock entry button
- badge rendering
- state indicator treatment
- popup item preview/title/subtitle rendering
- hover panel shell
- hover action list
- multi-window popup

The shared package should not become a full custom popover framework. Instead,
it should expose narrow extension hooks around a standard shell.

Recommended host callback:

```ts
export interface WorkbenchHostProps {
  dockEntries: readonly WorkbenchHostDockEntry[];
  dockStateSource?: WorkbenchHostDockEntryStateSource;
  onDockEntryAction?: (input: {
    entryId: string;
    actionId: string;
    host: WorkbenchHostHandle;
  }) => void | Promise<void>;
}
```

This allows flows such as "hover disabled entry, click Install, host transitions
entry state to loading, then back to enabled" without moving installation logic
into `workbench-surface`.

## Snapshot Rules

Snapshot purity remains a P0 rule.

Allowed dock-related snapshot metadata:

- `dockEntryId` when needed to reconnect a shell to its dock entry

Disallowed dock-related snapshot metadata:

- launch payloads
- hover action definitions
- badge state derived from host business state
- disabled/loading/unavailable workflow internals

The host should recompute dock visibility, badges, and hover actions from live
state on each render.

## Current Outcomes

The implemented model lets hosts express:

- stable dock ordering and grouping
- provider-specific entries for a shared node type
- default-hidden entries that appear when matching nodes exist
- stable anchor keys for genie animation and tests
- normalized badge and attention behavior
- host-controlled disabled, loading, and unavailable states
- host-controlled hover guidance such as install or sync actions

This restores dock to a host-chrome navigation model while keeping business
logic out of the shared workbench surface.
