# Agent Activity Packages

Status: shared Agent Activity core, desktop adapter, Agent GUI runtime input,
and Message Center snapshot model implemented; legacy Host API projection kept
only at compatibility and desktop bridge boundaries

This document records the package split for reusable Agent Activity and Agent
GUI surfaces. The goal is to make the agent session data flow reusable by other
repositories while keeping host-specific transport and desktop integration out
of the shared packages.

## Goals

- Replace the legacy `@tutti-os/agentactivity-renderer` package name with
  clearer public package names.
- Put reusable agent session state, event merging, and attention selectors
  behind a host-agnostic core package.
- Keep `apps/desktop` responsible for `tuttid`, preload, Electron, local file,
  and runtime integration.
- Let Agent GUI and the future Agent Message Center consume one shared Agent
  Activity snapshot instead of building separate session caches.
- Prepare for external repository adoption through a narrow adapter interface.

## Package Plan

The long-term package family is:

```text
packages/agent/activity-core
  @tutti-os/agent-activity-core

packages/agent/gui
  @tutti-os/agent-gui

packages/agent/message-center
  @tutti-os/agent-message-center
```

This iteration creates the first two packages only.
`@tutti-os/agent-message-center` remains a planned package name until the
header message UI is implemented.

## Responsibilities

### `@tutti-os/agent-activity-core`

`agent-activity-core` is host-agnostic and must not import React, Electron,
desktop preload APIs, or the generated `tuttid` client.

It owns:

- agent activity contracts used by UI packages and host adapters
- the host adapter interface
- session and message snapshot state
- live event subscription lifecycle
- retained stream reference counting when multiple consumers watch the same
  session
- message merge, version ordering, and duplicate handling
- selectors for reusable derived state
- `selectNeedsAttentionCount`
- `selectNeedsAttentionItems`

It does not own:

- HTTP path construction
- authentication
- `EventSource` or fetch implementation details
- `tuttid` generated client usage
- workspace file access
- Electron IPC or preload APIs
- React hooks or UI components

### `@tutti-os/agent-gui`

`agent-gui` is the renamed successor of
`@tutti-os/agentactivity-renderer`.

It owns:

- `AgentGUI`
- `AgentActivityRuntime` provider and hooks
- Agent GUI workbench node UI
- session list and detail rendering
- timeline, tool call, approval, and interactive prompt presentation
- package-owned stylesheet entrypoint
- React-facing hooks or providers that are specific to Agent GUI

It may depend on `@tutti-os/agent-activity-core`.

Agent GUI must read and write agent session/activity data through
`AgentActivityRuntime`. `AgentHostApi` remains available for host capabilities
such as files, clipboard, runtime metadata, account lookup, composer options,
and temporary desktop-only session-control behavior.

`AgentActivity*` types are the canonical frontend agent activity data model.
`AgentHostWorkspaceAgent*` types may only appear in compatibility or projection
layers while the legacy Agent GUI internals are being migrated. Production read
paths must not call `workspaceAgents.list`,
`workspaceAgents.listSessionMessages`, `agentSessions.retainEventStream`, or
`agentSessions.subscribeEvents` directly. Production write paths must not call
`agentSessions.exec`, `agentSessions.cancel`,
`agentSessions.submitInteractive`, or `agentSessions.pinSession`; use
`AgentActivityRuntime` instead. Legacy host DTOs are allowlisted only in the
host API contract, explicit projection helpers, and message merge/page-loading
helpers that accept runtime-shaped adapters.

It should not know how a host connects to `tuttid`, opens SSE streams, resolves
workspace paths, or talks to Electron.

### `@tutti-os/agent-message-center`

This package is planned but not created in this iteration.

It is expected to own:

- the header Agent Message trigger
- needs-attention badge UI
- needs-attention popover/list UI
- actions that open the relevant Agent GUI session or submit the required user
  response

It should consume `agent-activity-core` selectors instead of interpreting raw
message payloads directly.

### `apps/desktop`

The desktop app owns the concrete adapter from `tuttid` and Electron runtime
capabilities into `agent-activity-core`.

It owns:

- `tuttid` client calls
- SSE connection implementation
- backend base URL and authentication details
- preload/runtime/file adapters
- `IWorkspaceAgentActivityService` and the desktop
  `AgentActivityRuntime` wrapper
- workspace chrome placement
- workbench contribution wiring
- desktop i18n overrides

`WorkspaceAgentActivityService` is the desktop renderer source for workspace
agent activity snapshots. Desktop chrome MessageCenter and AgentGUI workbench
nodes must subscribe to the same service instance for the same workspace.

## Core Adapter Shape

The core package should be constructed from a host adapter rather than from
desktop-specific objects:

```ts
createAgentActivityController({
  workspaceId,
  adapter
});
```

The adapter should expose the host operations needed by the controller:

```ts
export interface AgentActivityAdapter {
  listSessions(input: {
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<AgentActivitySessionList>;

  listSessionMessages(input: {
    workspaceId: string;
    agentSessionId: string;
    afterVersion?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<AgentActivityMessagePage>;

  subscribeSessionEvents(input: {
    workspaceId: string;
    agentSessionId: string;
    afterVersion?: number;
    signal: AbortSignal;
    onEvent(event: AgentActivitySessionEventEnvelope): void;
    onError?(error: unknown): void;
  }): Promise<() => void>;

  createSession(
    input: AgentActivityCreateSessionInput
  ): Promise<AgentActivitySession>;
  sendInput(input: AgentActivitySendInput): Promise<AgentActivitySession>;
  cancelSession(
    input: AgentActivityCancelSessionInput
  ): Promise<AgentActivitySession>;
  respondPermission(
    input: AgentActivityPermissionResponseInput
  ): Promise<unknown>;
  deleteSession(
    input: AgentActivityDeleteSessionInput
  ): Promise<AgentActivityDeleteSessionResult>;
}
```

The adapter decides how to connect. The controller decides when to connect,
when to disconnect, and how to merge the resulting events.

Hosts may accept older provider/runtime reports with missing transcript
ownership or ordering fields, but those gaps must be filled before events enter
`agent-activity-core` or `@tutti-os/agent-gui`. Session-level notices and
statuses should use state patches or explicit notice semantics; they should not
be published as ordinary assistant transcript messages without a turn scope.

## Stream Lifecycle

SSE lifecycle belongs in `agent-activity-core` at the semantic level:

- subscribe when a session is visible, active, or explicitly retained by a UI
- retain one stream for multiple consumers of the same session
- abort and unsubscribe when the last consumer releases the session
- merge live message events into the cached snapshot
- keep persisted message pages and live events ordered by version
- deduplicate messages by stable message identity and version
- treat transcript `message_update` messages as normalized input: each message
  must have `messageId`, positive `version`/`seq`, `turnId`, and
  `occurredAtUnixMs` before core merges it

SSE implementation belongs in the host adapter:

- URL construction
- token or cookie usage
- `EventSource`, `fetch`, IPC, or another transport
- raw protocol decoding
- host-specific retry capability

Generic retry and backoff can live in core only when the adapter exposes enough
transport-neutral error information.

## Needs Attention Contract

The future Agent Message Center counts user-actionable items, not all session
messages.

The initial selector surface is:

```ts
selectNeedsAttentionCount(snapshot): number;
selectNeedsAttentionItems(snapshot): AgentActivityNeedsAttentionItem[];
```

`AgentActivityNeedsAttentionItem` should contain:

```ts
export interface AgentActivityNeedsAttentionItem {
  id: string;
  workspaceId: string;
  agentSessionId: string;
  provider: string;
  title: string;
  cwd: string;
  kind: "permission" | "question" | "constraint" | "other";
  summary: string;
  occurredAtUnixMs: number;
}
```

The selector should count pending actionable prompts such as permission
approvals, ask-user questions, and constraint confirmations. Completed,
canceled, superseded, or already answered prompts must not be counted.

Failed sessions are not automatically needs-attention items unless they expose a
specific user action that can resolve the failure.

## Migration Plan

### Step 1: Breaking package rename

Move the legacy package:

```text
packages/agent/renderer
@tutti-os/agentactivity-renderer
```

to:

```text
packages/agent/gui
@tutti-os/agent-gui
```

Update all imports, stylesheet imports, Vite externals, package references,
local shims, and boundary documentation.

The stylesheet contract becomes:

```ts
import "@tutti-os/agent-gui/styles.css";
```

This step should not change runtime behavior.

### Step 2: Create `agent-activity-core`

Create `packages/agent/activity-core` with:

- package manifest and build scripts
- public contracts
- adapter interface
- controller/store skeleton
- message merge helpers
- needs-attention selectors
- unit tests for merge and attention counting

The package must typecheck without React or desktop dependencies.

### Step 3: Add the desktop adapter

In `apps/desktop`, create a concrete adapter that wraps the generated
`tuttid` client and event stream APIs.

Desktop keeps transport and host knowledge. Core receives normalized contracts.

The first implementation routes desktop session-message cache merging and
retained event stream lifecycle through `agent-activity-core`. The concrete
desktop adapter owns the `tuttid` calls, SSE subscription, and host event
normalization.

`createDesktopAgentHostApi` remains the compatibility adapter from the shared
activity controller into the existing Agent GUI Host API. It may still call
desktop-only Host APIs directly when those operations are outside the shared
activity snapshot.

### Step 4: Connect Agent GUI to core

Update `@tutti-os/agent-gui` and the desktop Agent GUI workbench body to use
the shared controller or snapshot source.

AgentGUI now requires `agentActivityRuntime: AgentActivityRuntime` in
production. Desktop passes a runtime wrapper over
`WorkspaceAgentActivityService` together with `agentHostApi`.

AgentGUI production code should call the runtime hook directly and keep
UI-local state limited to selection, drafts, scroll/loading/error state,
highlight state, and optimistic overlays. Legacy host session-control helpers
(`activate`, `unactivate`, `getState`, `updateSettings`, and
`getComposerOptions`) remain temporary host capabilities; they must not be used
as list, timeline, message, or write-operation data sources.

`@tutti-os/agent-gui` now also exposes
`buildAgentActivitySnapshotProjection(snapshot)`, so shared Agent GUI surfaces
can start from the core snapshot and shared needs-attention selectors without
rebuilding Host DTO projection locally.

### Step 5: Message Center Snapshot Model

Do not create an empty `@tutti-os/agent-message-center` package in this
iteration.

Desktop chrome MessageCenter remains in `@tutti-os/agent-gui` for now. Its
model is derived directly from `AgentActivitySnapshot`,
`AgentActivitySession`, `AgentActivityMessage`, and
`selectNeedsAttentionItems`; it must not round-trip through
`AgentHostWorkspaceAgent*` DTOs.

## Testing Expectations

For package rename work:

- `pnpm typecheck`
- `pnpm --filter @tutti-os/desktop typecheck`
- `pnpm check:ui-boundaries` when stylesheet boundary rules change
- `pnpm check:renderer-boundaries` when desktop renderer imports change

For `agent-activity-core`:

- unit tests for message merge ordering and deduplication
- unit tests for retained stream lifecycle
- unit tests for needs-attention selectors
- package typecheck

For desktop adapter integration:

- existing desktop workspace-agent tests
- adapter tests for `tuttid` response normalization
- live event merge tests using a fake subscription adapter

For Agent GUI behavior:

- existing Agent GUI component and projection tests
- focused tests for working, waiting, completed, failed, and needs-attention
  states
- tests that AgentGUI list/detail and write operations use
  `AgentActivityRuntime` when provided

For runtime boundary enforcement:

- `pnpm check:agent-activity-runtime-boundaries`
- the same check is included in `pnpm check:full`

## Non-Goals

- Do not move desktop transport into a package.
- Do not create a vague `shared`, `common`, or `utils` package.
- Do not create an empty message-center package before there is UI behavior.
- Do not rewrite all Agent GUI projection code in the first migration step.
- Do not change daemon HTTP contracts without first updating
  `services/tuttid/api/openapi/tuttid.v1.yaml`.

## Review Rules

- New public exports in `agent-activity-core` should be stable contracts, not
  convenience exports for one host.
- A selector belongs in core when both Agent GUI and Agent Message Center can
  consume it without knowing host details.
- A React hook belongs in `agent-gui` or the future `agent-message-center`, not
  in core.
- A `tuttid` mapping belongs in the desktop adapter unless it is a
  host-agnostic contract type.
- External repository adoption should require implementing the adapter, not
  copying session merge or needs-attention logic.
