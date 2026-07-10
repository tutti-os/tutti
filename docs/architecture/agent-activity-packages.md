# Agent Activity Packages

Status: current implemented architecture

This document records the package split for reusable Agent Activity and Agent
GUI surfaces. The goal is to make the agent session data flow reusable by other
repositories while keeping host-specific transport and desktop integration out
of the shared packages.

## Design Goals

- Put reusable agent session state, event merging, and attention selectors
  behind a host-agnostic core package.
- Keep `apps/desktop` responsible for `tuttid`, preload, Electron, local file,
  and runtime integration.
- Let Agent GUI and Message Center consume one shared Agent Activity snapshot
  instead of building separate session caches.
- Prepare for external repository adoption through a narrow adapter interface.

## Package Map

The current package family is:

```text
packages/agent/activity-core
  @tutti-os/agent-activity-core

packages/agent/gui
  @tutti-os/agent-gui
```

## Responsibilities

### `@tutti-os/agent-activity-core`

`agent-activity-core` is host-agnostic and must not import React, Electron,
desktop preload APIs, or the generated `tuttid` client.

It owns:

- agent activity contracts used by UI packages and host adapters
- the host adapter interface
- session and message snapshot state
- optional live event subscription lifecycle for hosts that let the core
  controller manage per-session streams
- retained stream reference counting when multiple consumers watch the same
  session through the optional adapter stream capability
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
- Message Center snapshot model and UI while it shares AgentGUI activity and
  interaction ownership

It may depend on `@tutti-os/agent-activity-core`.

Agent GUI must read and write agent session/activity data through
`AgentActivityRuntime`. `AgentHostApi` remains available for host capabilities
such as files, clipboard, runtime metadata, account lookup, composer options,
and temporary desktop-only session-control behavior.
Conversation rail sections are also an `AgentActivityRuntime` contract:
AgentGUI calls `listSessionSections` for the first page of every returned rail
section and `listSessionSectionPage` for Show more by `sectionKey` and cursor.
Hosts must pass those calls through to the daemon section endpoints so project
sections come from current user projects and session membership comes from
persisted `rail_section_key`, not frontend cwd grouping or project-root
filters.
The `listSessionSections` bootstrap also carries the first pinned session page,
and pinned Show more uses the dedicated pinned page endpoint/runtime method.
Pinned is not a section kind; it is a session/rail-record projection derived
from `pinnedAtUnixMs` so pinned conversations can render on first load even
when they are older than the first ordinary project or Chats page.
When AgentGUI's provider rail is narrowed to one target, the runtime request
must include `agentTargetId`; hosts and the daemon apply it before section
pagination so `hasMore` describes the target-filtered rail, not the unfiltered
workspace history.
Activating a conversation must not by itself call `listSessionSections` again.
Likewise, active detail provider changes should not reload section first pages.
AgentGUI may merge updated props for already-rendered rows from the activity
snapshot, but section first-page reloads should be tied to workspace, rail
filter, user project, or session membership changes.

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
    beforeVersion?: number;
    limit?: number;
    order?: AgentActivityMessageOrder;
    signal?: AbortSignal;
  }): Promise<AgentActivityMessagePage>;

  loadComposerOptions(
    input: AgentActivityLoadComposerOptionsInput
  ): Promise<AgentActivityComposerOptions>;

  subscribeSessionEvents?(input: {
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
  sendInput(
    input: AgentActivitySendInput
  ): Promise<AgentActivitySendInputResult>;
  cancelSession(
    input: AgentActivityCancelSessionInput
  ): Promise<AgentActivityCancelSessionResult>;
  goalControl(
    input: AgentActivityGoalControlInput
  ): Promise<AgentActivityGoalControlResult>;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput
  ): Promise<unknown>;
  deleteSession(
    input: AgentActivityDeleteSessionInput
  ): Promise<AgentActivityDeleteSessionResult>;
  renameSession(
    input: AgentActivityRenameSessionInput
  ): Promise<AgentActivitySession>;
}
```

`AgentActivityRuntime.activateSession` requires `agentTargetId` for
`mode: "new"`. Shared UI passes it through unchanged; trusted host or daemon code
resolves it against `agent_targets`, validates enabled state and launch ref
shape, and derives the execution `provider` and runtime `providerTargetRef`
from the resolved target. Target-backed create requests may omit `provider`; if
both fields are present, the daemon rejects provider mismatches. Client-provided
`providerTargetRef` is not allowed to override the daemon-derived runtime ref
when `agentTargetId` is present. The resulting
`AgentActivitySession` and session events should preserve `agentTargetId` when
present. State patch reducers must update the session when an event includes
`agentTargetId`, but a patch that omits the field must not clear an existing
target id because older runtimes and historical imports are provider-only.

Composer options use one cache key space: the resolved `agentTargetId` is passed
to activity-core as an opaque `targetKey`, round-tripped verbatim, and forwarded
to the daemon as `agentTargetId`. Activity-core must not parse or rewrite the
key. There is no provider-keyed fallback cache: two targets under the same
provider must remain isolated. Provider-based invalidation filters on the
`provider` stored in each cached value rather than deriving provider identity
from the key.

`AgentActivityCreateSessionInput.providerTargetRef` is an optional opaque
host-owned legacy reference for selecting which target under the real provider
should launch the session. It is not authority, a credential, or an invocation
plan. New runtime launches must provide `agentTargetId`; `providerTargetRef`
must not be used as a provider-only launch fallback. Target-backed launches use
the daemon-derived ref shape from `agent_targets` instead. Adapters and trusted
launchers must re-authenticate and resolve it before using any concrete provider
invocation. UI packages must keep `provider` as the real provider identity and
must not synthesize providers for shared or remote targets.

The adapter decides how to connect. The controller decides when to connect,
when to disconnect, and how to merge the resulting events.
`subscribeSessionEvents` is optional because some hosts own real-time delivery
at a service/runtime layer and apply events to the controller from that layer.
Those hosts should omit the adapter method instead of providing a throwing
stub.

Hosts may accept older provider/runtime reports with missing transcript
ownership or ordering fields, but those gaps must be filled before events enter
`agent-activity-core` or `@tutti-os/agent-gui`. Session-level notices and
statuses should use state patches or explicit notice semantics; they should not
be published as ordinary assistant transcript messages without a turn scope.
Activity reports may carry a host-defined user id in the activity source before
they reach durable session projection. Local single-user hosts should leave the
field empty instead of deriving it from account login state; cloud
collaboration hosts may inject real account user ids so downstream views can
distinguish self-owned and peer-owned sessions. Reporters run on the streaming
persistence hot path, so identity enrichment there must use host-provided local
state; it must not call account refresh or user-info APIs that perform network
round-trips or write refreshed auth state.

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

## Validation

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
- Do not change daemon HTTP contracts without first updating
  `services/tuttid/api/openapi/tuttid.v1.yaml`.

## Review Rules

- New public exports in `agent-activity-core` should be stable contracts, not
  convenience exports for one host.
- A selector belongs in core when Agent GUI and another host-agnostic consumer can
  use it without knowing host details.
- A React hook belongs in `agent-gui` rather than in core.
- A `tuttid` mapping belongs in the desktop adapter unless it is a
  host-agnostic contract type.
- External repository adoption should require implementing the adapter, not
  copying session merge or needs-attention logic.
