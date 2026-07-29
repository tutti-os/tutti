# @tutti-os/agent-activity-core

Shared agent activity state, orchestration rules, merge rules, and selectors for
Tutti agent UIs.

This package owns the frontend-side workspace engine and activity snapshot model
used by Desktop and Mobile surfaces. It does not know about Electron, React
Native, HTTP, SSE, DeviceLink, or daemon DTOs. Product-specific adapters execute
transport commands and normalize observations before they enter the engine.

## Package Boundary

`@tutti-os/agent-activity-core` is the shared model layer:

- defines sessions, messages, presences, snapshots, and event envelopes
- loads session lists and paged session messages through an adapter
- can retain live session event streams with reference-counted subscription
  lifecycle when a host adapter exposes that optional capability
- merges persisted and live messages with version-aware conflict handling
- analyzes normalized activity events into one inline-observation intent plus
  an explicit authoritative-reconcile requirement
- projects shared activation, prompt send, settings update, turn cancel, and
  Interaction response commands onto one typed host effect port
- executes the shared prompt sequence, including required settings persistence
  before send
- exposes selectors such as `selectNeedsAttentionCount`

It intentionally does not render UI, open network connections directly, persist
state, or translate daemon/backend contracts. Those responsibilities belong to a
host adapter such as the desktop renderer adapter.

## Session Engine

`createAgentSessionEngine` is the workspace-level orchestration loop described
in `docs/architecture/agent-gui-refactor-plan.md` (section 3.3). It is
React-free and host-agnostic:

```ts
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";

const engine = createAgentSessionEngine({
  identity: { workspaceId: "workspace-1", origin: "local-tuttid" },
  commandPort, // typed lifecycle effects plus host-specific command extensions
  scheduler, // host timer port, e.g. setTimeout-backed outside this package
  clock, // host clock port: { nowUnixMs() }
  diagnosticSink // optional instance-level diagnostics receiver
});
```

Engine rules:

- Instances are identified by the workspace + origin pair and injected
  explicitly. There is no module-level singleton; hosts running multiple
  runtimes against one workspace create one engine per origin.
- `dispatch(intent)` is the only input. Reducers are pure and return new state
  plus command descriptions; the effect executor performs commands and feeds
  every settlement (success, failure, timeout) back into the loop as
  command-result intents.
- New hosts implement `AgentSessionEffectPort` for activation, prompt send,
  settings update, turn cancellation, and Interaction response. The Engine
  owns command-to-capability projection and required-settings-before-send
  ordering. A typed port declares `kind: "typed"` and its `execute` callback
  receives only `EngineExtensionCommand`; the discriminated legacy shape keeps
  the complete-command callback while existing package consumers migrate.
- Timing is never read inside reducers. Deadlines are `scheduleExpiry`
  commands handled by the expiry clock, which re-enters the loop with expiry
  intents through the injected host scheduler.
- `dispatch(intent, { batch: true })` coalesces high-frequency intents inside
  a 33ms frame window; a non-batched dispatch flushes the pending frame first
  so ordering is preserved.
- `getSnapshot()` / `subscribe()` expose the immutable state tree. React
  surfaces subscribe through the single `useEngineSelector` binding in
  `@tutti-os/agent-gui`.

The state tree includes lifecycle entities, message windows, prompt queue,
pending intents, composer options, runtime availability, reconciliation, and
attention/read state. Hosts must consume selectors or stable snapshot
projections instead of reading reducer maps from UI components.

## Adapter Contract

Business hosts implement `AgentActivityAdapter`:

```ts
import type { AgentActivityAdapter } from "@tutti-os/agent-activity-core";

export const adapter: AgentActivityAdapter = {
  async listSessions({ workspaceId, signal }) {
    return {
      sessions: await fetchSessionsForWorkspace(workspaceId, signal),
      presences: []
    };
  },

  async listSessionMessages(input) {
    return fetchMessages(input);
  },

  async loadComposerOptions(input) {
    return fetchComposerOptions(input);
  },

  // Optional: implement only when this host wants the core controller to manage
  // per-session live event streams. Hosts with a service/runtime event bus can
  // omit this method and push events into the controller themselves.
  async subscribeSessionEvents(input) {
    const stream = openSessionEventStream({
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      afterVersion: input.afterVersion,
      signal: input.signal,
      onEvent: input.onEvent,
      onError: input.onError
    });

    return () => stream.close();
  },

  createSession: createAgentSession,
  sendInput: sendAgentInput,
  goalControl: controlAgentGoal,
  submitInteractive: submitAgentInteractiveResponse,
  deleteSession: deleteAgentSession,
  deleteSessions: deleteAgentSessions,
  renameSession: renameAgentSession,
  setSessionPinned: setAgentSessionPinned
};
```

Adapters should normalize external data into core types before returning it.
For desktop, the concrete example is
`apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts`.

## Snapshot Model

The controller exposes an `AgentActivitySnapshot`:

```ts
{
  workspaceId: string;
  sessions: AgentActivitySession[];
  presences: AgentActivityPresence[];
  sessionMessagesById: Record<string, AgentActivityMessage[]>;
}
```

`load()` replaces `sessions` and `presences` from the adapter while preserving
cached `sessionMessagesById`. This lets a UI refresh session cards without
dropping message state that may already have arrived from a paged fetch or live
stream.

`getSnapshot()` and subscription callbacks return cloned snapshots so UI callers
cannot mutate controller state by accident.

When loaded or upserted session data is unchanged, the controller preserves the
current snapshot reference and does not notify subscribers.

## Composer Options Cache

`loadComposerOptions({ targetKey, provider, ... })` caches results in a single
key space, `composerOptionsByTargetKey`. `targetKey` is an **opaque** cache key:
the controller round-trips it verbatim to the adapter (as `agentTargetId`) and
uses it as the snapshot key — it never parses, derives meaning from, or rewrites
it. Callers pass the already-resolved directory target id; two distinct targets
that share a `provider` therefore keep isolated caches (no provider-dimension
fallback).

`invalidateComposerOptions({ providers })` drops freshness markers so the next
non-forced load refetches, while the last known options stay renderable. It
filters by the `provider` stored inside each cached value, never by inspecting
the opaque `targetKey`.

## Submit Availability

The engine derives submit availability from canonical Turns and pending
Interactions. Hosts must not copy deprecated session-level lifecycle or submit
availability fields into the frontend.

A host whose command transport can differ per Session may dispatch
`session/runtimeAvailabilityChanged`. This ephemeral, session-scoped fact is
kept outside the canonical Session and blocks runtime-dependent commands while
the exact Session transport reconnects or is unavailable. Omitted availability
defaults to available, so ordinary local runtimes retain their existing
behavior. A workspace-wide `engine/connectionChanged` event must not be used to
represent one remote Session's transport because that would also block
unrelated Sessions sharing the engine.

## Event Shape

Canonical streams emit a versioned `message_update`:

```ts
{
  workspaceId: "workspace-1",
  agentSessionId: "session-1",
  eventType: "message_update",
  data: {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    latestVersion: 12,
    acceptedCount: 1,
    messages: [/* canonical message snapshots */]
  }
}
```

Normalized provider text/reasoning streams may precede that confirmation with
an optimistic `message_delta`:

```ts
{
  workspaceId: "workspace-1",
  agentSessionId: "session-1",
  eventType: "message_delta",
  data: {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "message-1",
    turnId: "turn-1",
    role: "assistant",
    kind: "text",
    occurredAtUnixMs: 100,
    content: { operation: "append_text", text: "hello" },
    status: "streaming"
  }
}
```

Each host creates one
`createAgentActivityWorkspaceEventCoordinator` per workspace and passes
transport deliveries into it. The coordinator validates and cleans
`message_delta`, owns its optimistic projection over canonical
`sessionMessagesById`, and clears that projection after authoritative message
reads or Session removal. The generated `AgentActivityUpdatedEvent` input also
accepts:

- `turn_update`: updates the canonical durable turn projection
- `interaction_update`: updates the canonical durable interaction projection
- `session_reconcile_required`: asks the engine transport to reload the session
- `session_deleted`: removes the session through the engine tombstone flow

Events with a different `workspaceId` are ignored. Unknown event types are
ignored.

The coordinator owns inline-message continuity, Engine observation intents,
Session tombstones, discontinuity reconciliation, and reconnect hydration.
Desktop receives the full canonical event union. The paired-device live
protocol carries only delta, Turn, Interaction, and audit variants; tuttid
converts canonical message and reconcile-required events into scoped
discontinuities. It preserves `session_deleted` as a typed deletion delivery so
Mobile enters the same Engine tombstone flow as Desktop. Platform adapters
retain socket/DeviceLink lifecycle, diagnostics, Rail invalidation, and
navigation.

`eventStreamConnectionChanged` describes only event-stream continuity and
drives reconnect hydration. The host still owns `engine/connectionChanged`,
which describes command-transport reachability. Desktop may derive both from
one WebSocket connection. Mobile must derive Engine state from
application/service command reachability and coordinator state from
`stream_ready`/disconnect frames; it must not synthesize one from the other.

For realtime Turn observations, the Engine carries `live: true` on the
resulting `session/reconcile` command. Command adapters preserve that flag on
`session/detailSnapshotReceived`; failed commands retain it for the next retry.
This lets authoritative hydration replay the latest Turn only after Session
identity exists, with identical attention semantics on Desktop and Mobile.

## Typed Effect Execution

The Engine projects shared lifecycle command descriptions onto
`AgentSessionEffectPort`: `activateSession`, `sendInput`,
`updateSessionSettings`, `cancelTurn`, and `respondToInteraction`. Hosts
implement transport and result mapping without switching on those command
types. When a queued prompt includes a required settings patch, the Engine
waits for that exact settings write before sending; a failed write prevents the
send. Capability references, structured content, display prompt, guidance,
activation placement, Tutti-mode intent, and diagnostics survive the shared
projection. Goal-on-create and settings command/correlation identities are also
retained for external hosts that use them for goal setup or idempotency.

Prompt command ordering is an Engine implementation detail. Consumers implement
`AgentSessionEffectPort`; the package root does not expose the internal prompt
execution helper or its precondition port.

Host-only commands such as Desktop attention persistence or Mobile composer
option loading remain in an `EngineExtensionCommand` adapter. Timeout, abort,
observation, and command-result dispatch remain owned by the Engine effect
executor. Every typed effect receives the Engine command's `AbortSignal`; hosts
must propagate it through their transport. Prompt execution checks that signal
again after a required settings write and before send, so a timeout cannot
start a Turn in the precondition gap. The legacy full-command `execute` path is
compatibility-only for existing published-package consumers such as tsh.

## Message Merge Rules

Messages are keyed by `messageId` within a session.

- Higher `version` replaces lower `version`.
- If versions are equal, higher or equal numeric `id` replaces the existing
  message.
- Replacement merges payload fields instead of discarding existing payload keys.
- Final message order is `version`, then `id`, then `messageId`.

These rules let stale paged responses arrive after fresher live events without
overwriting the user's current view.

## Retained Streams

Use `retainSessionEvents()` when a UI surface needs live updates for a session:

```ts
const release = controller.retainSessionEvents({
  agentSessionId: "session-1",
  onError: reportStreamError
});

release();
```

Lifecycle behavior:

- Multiple consumers of the same session share one adapter subscription.
- Each `release` callback is idempotent.
- The adapter stream is aborted and unsubscribed after the last consumer
  releases it.
- If subscription setup fails, the retained stream is cleaned up so a later
  caller can retry.
- When `afterVersion` is omitted, the controller subscribes after the latest
  cached message version for that session.

## Needs Attention

`selectNeedsAttentionItems(snapshot)` returns pending user-action items sorted
newest first. `selectNeedsAttentionCount(snapshot)` returns its length.

The selector treats non-terminal messages as actionable when they look like:

- permission or approval requests
- direct user questions
- constraint requests
- waiting assistant/system messages that do not match a more specific category

Terminal statuses such as `completed`, `failed`, `answered`, and `resolved` are
not counted.
