# @tutti-os/agent-activity-core

Shared agent activity state, merge rules, and selectors for Tutti agent UIs.

This package owns the frontend-side session snapshot model used by surfaces such
as `@tutti-os/agent-gui` and the future message center. It does not know about
Electron, HTTP, SSE, or daemon DTOs. Product-specific code provides an
`AgentActivityAdapter`; the controller turns that adapter into a stable in-memory
snapshot.

## Package Boundary

`@tutti-os/agent-activity-core` is the shared model layer:

- defines sessions, messages, presences, snapshots, and event envelopes
- loads session lists and paged session messages through an adapter
- retains live session event streams with reference-counted subscription
  lifecycle
- merges persisted and live messages with version-aware conflict handling
- exposes selectors such as `selectNeedsAttentionCount`

It intentionally does not render UI, open network connections directly, persist
state, or translate daemon/backend contracts. Those responsibilities belong to a
host adapter such as the desktop renderer adapter.

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

  async listSessionMessages({ workspaceId, agentSessionId, afterVersion }) {
    return fetchMessages({ workspaceId, agentSessionId, afterVersion });
  },

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
  cancelSession: cancelAgentSession,
  respondPermission: respondToAgentPermission,
  deleteSession: deleteAgentSession
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

## Event Shape

Live streams emit `AgentActivitySessionEventEnvelope`:

```ts
{
  workspaceId: "workspace-1",
  agentSessionId: "session-1",
  eventType: "message_update",
  data: {
    messageId: "message-1",
    version: 12,
    role: "assistant",
    kind: "ask_user_question",
    status: "waiting",
    payload: { title: "Choose a plan" }
  }
}
```

Supported controller event types:

- `message_update`: upserts a message into `sessionMessagesById`
- `session_update`: upserts a session into `sessions`

Events with a different `workspaceId` are ignored. Unknown event types are
ignored.

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
