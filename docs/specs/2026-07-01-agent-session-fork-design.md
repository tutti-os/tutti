# Agent Session Fork Design

Status: superseded by
[2026-07-27 Agent Session Fork Design](./2026-07-27-agent-session-fork-design.md)

Date: 2026-07-01

## Summary

Tutti should implement agent session fork as a first-class provider-backed
operation. The source of truth for a Codex fork is the Codex app-server
`thread/fork` RPC. Tutti then projects the forked provider thread into its own
durable Agent GUI activity store so the child conversation can be listed,
opened, continued, and traced back to its parent.

The standard implementation must not create a fork by only copying Agent GUI
messages. Message copying alone creates a UI-level clone, but it does not create
a new provider thread and does not guarantee that subsequent model turns use the
forked Codex context.

## Goals

- Support forking a Codex-backed Tutti agent session into a new child session.
- Preserve parent session state without mutation.
- Give the child session a new Tutti `agentSessionId`.
- Give the child session a new Codex `providerSessionId`, returned by
  `thread/fork`.
- Preserve the parent history up to the fork boundary.
- Allow full-session fork and fork from a specific completed turn.
- Persist fork lineage for UI display, future fork-tree queries, and debugging.
- Apply a deterministic default child title:
  `<parent title>(fork<num>)`.
- Keep the first implementation compatible with current Agent GUI activity
  snapshots and message pagination.

## Non-Goals

- Git branch or worktree creation during fork.
- Fork support for non-Codex providers in the first version.
- Cross-provider fork.
- Fork tree visualization beyond showing the direct parent relationship.
- Mutating, truncating, or rolling back the parent session.

## User-Facing Behavior

Agent GUI provides two actions:

- `Fork conversation`: forks the whole current conversation.
- `Fork from here`: forks through the selected completed turn.

After a successful fork, Agent GUI refreshes activity state and activates the
child session. The child header shows that it was forked from the parent session
and offers a link/action to open the parent.

When the selected turn is still running, `Fork from here` is disabled.

## Title Rules

When the request does not provide an explicit child title, tuttid generates the
title server-side:

```text
<parent title>(fork<num>)
```

Rules:

- `num` starts at `1`.
- The number increments across direct forks from the same parent session.
- If a generated title already exists in the workspace, tuttid increments until
  the title is unique.
- If the parent title is empty, tuttid first resolves the same fallback title
  used for session display, then appends the suffix.
- If the request provides an explicit title, tuttid uses it without applying the
  fork suffix.
- Forking an already-forked session appends to the current parent title. For
  example, `Build login(fork1)` forks to `Build login(fork1)(fork1)`.

## Backend API

Add:

```http
POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/fork
```

Request schema:

```json
{
  "requestId": "uuid-for-idempotency",
  "targetAgentSessionId": "optional-child-session-id",
  "lastTurnId": "optional-completed-turn-id",
  "title": "optional child title",
  "visible": true,
  "settings": {
    "model": "optional override",
    "reasoningEffort": "optional override",
    "permissionModeId": "optional override",
    "planMode": false,
    "browserUse": true,
    "computerUse": true
  }
}
```

Response schema:

```json
{
  "session": {
    "...": "WorkspaceAgentSession"
  },
  "fork": {
    "sourceAgentSessionId": "parent-tutti-session-id",
    "targetAgentSessionId": "child-tutti-session-id",
    "sourceProviderSessionId": "parent-codex-thread-id",
    "targetProviderSessionId": "child-codex-thread-id",
    "provider": "codex",
    "lastTurnId": "optional-completed-turn-id",
    "forkedAtUnixMs": 1782892800000
  }
}
```

The endpoint is idempotent by `(workspaceID, requestId)`. Repeating a completed
fork request returns the existing child session and lineage record.

## Runtime Contract

Extend the agent runtime controller with a fork operation:

```go
Fork(ctx context.Context, input RuntimeForkInput) (RuntimeForkResult, error)
```

Suggested service-level input:

```go
type RuntimeForkInput struct {
    WorkspaceID             string
    SourceAgentSessionID    string
    TargetAgentSessionID    string
    Provider                string
    SourceProviderSessionID string
    Cwd                     string
    Settings                ComposerSettings
    LastTurnID              string
    Title                   string
    Visible                 *bool
}
```

Suggested service-level result:

```go
type RuntimeForkResult struct {
    Session  RuntimeSession
    Messages []RuntimeMessage
    Fork     RuntimeForkLineage
}
```

`RuntimeMessage` should represent provider-derived child history in a form that
the tuttid service can persist into `workspace_agent_messages`. If the adapter
does not return messages, the service falls back to copying parent cached
messages through the fork boundary.

## Codex Provider Behavior

For the Codex provider, the adapter calls app-server `thread/fork`.

Mapping:

- Parent Tutti `providerSessionId` becomes Codex `threadId`.
- Optional Tutti `lastTurnId` becomes Codex `lastTurnId`.
- Effective model, model provider, cwd, runtime workspace roots, approval
  policy, sandbox or permissions profile, config overrides, base instructions,
  developer instructions, and ephemeral setting are forwarded the same way
  Codex TUI builds `ThreadForkParams`.
- Response `thread.id` becomes the child Tutti `providerSessionId`.
- Response thread metadata updates the child runtime session.

If `thread/fork` returns turns, the adapter should return them for persistence.
If the fork response excludes turns or the running Codex version omits them, the
adapter should read the child thread with turns before returning when supported.

Non-Codex providers return a structured unsupported-provider error in the first
version.

## Storage

Add a dedicated lineage table. `runtime_context_json` may cache display fields,
but lineage facts should not live only in JSON.

```sql
CREATE TABLE IF NOT EXISTS workspace_agent_session_forks (
  workspace_id TEXT NOT NULL,
  child_agent_session_id TEXT NOT NULL,
  parent_agent_session_id TEXT NOT NULL,
  child_provider_session_id TEXT NOT NULL DEFAULT '',
  parent_provider_session_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  fork_turn_id TEXT NOT NULL DEFAULT '',
  fork_request_id TEXT NOT NULL DEFAULT '',
  fork_request_fingerprint TEXT NOT NULL DEFAULT '',
  forked_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, child_agent_session_id),
  UNIQUE (workspace_id, fork_request_id),
  FOREIGN KEY (workspace_id, child_agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, parent_agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE
);
```

Add indexes for parent lookup:

```sql
CREATE INDEX IF NOT EXISTS idx_workspace_agent_session_forks_parent
  ON workspace_agent_session_forks(workspace_id, parent_agent_session_id);
```

The child `workspace_agent_sessions` row stores:

- new `agent_session_id`
- same provider
- child `provider_session_id`
- effective settings
- effective cwd
- generated or explicit title
- visible state
- status from runtime fork result
- runtime context with cached display metadata

Suggested cached runtime context keys:

```json
{
  "forkedFromAgentSessionId": "parent-tutti-session-id",
  "forkedFromProviderSessionId": "parent-codex-thread-id",
  "forkedFromTurnId": "optional-completed-turn-id",
  "forkParentTitle": "parent title",
  "forkedAtUnixMs": 1782892800000,
  "forkMessageSource": "provider-turns"
}
```

## Message Initialization

The standard path initializes child messages from provider history:

1. Call Codex `thread/fork` without `excludeTurns` where possible.
2. If the response contains turns, project those turns to
   `workspace_agent_messages`.
3. If the response does not contain turns, read the child thread with turns and
   project those turns.
4. If provider turns are unavailable, copy parent Tutti messages through the
   fork boundary as a fallback and set
   `runtimeContext.forkMessageSource = "parent-cache-fallback"`.

Fallback copy rules:

- Copy only messages from completed persisted turns.
- If `lastTurnId` is empty, copy all completed parent messages.
- If `lastTurnId` is present, copy through that turn inclusively.
- Do not copy active, in-progress, failed-in-progress, or locally optimistic
  overlay messages.
- Reuse message ids only under the child `agent_session_id`; the existing unique
  key includes `agent_session_id`.
- Recompute message versions for the child session so pagination cursors stay
  local to the child.

## Service Flow

The operation is a saga because provider fork and local SQLite persistence are
not one atomic transaction.

1. Normalize and validate `workspaceID`, source `agentSessionID`, and
   `requestId`.
2. Return an existing result if `(workspaceID, requestId)` has already completed.
3. Load the parent session and verify provider is `codex`.
4. Verify the parent has a non-empty `providerSessionId`.
5. Verify the parent session is idle (`ready` or `completed`). Reject a
   `working` parent before calling the provider so a whole-conversation fork
   cannot race an active turn.
6. Validate `lastTurnId` when present:
   - it must exist in parent messages or provider turns;
   - it must not identify an in-progress turn.
7. Resolve child `agentSessionId`.
8. Resolve child title with the default title rules.
9. Resolve effective settings and cwd.
10. Call `RuntimeController.Fork`.
11. Persist child `workspace_agent_sessions`.
12. Persist `workspace_agent_session_forks`.
13. Persist child messages from provider-derived history or fallback copy.
14. Publish activity/session events.
15. Return the child session and lineage response.

If provider fork succeeds but local persistence fails, tuttid returns failure
and logs the orphan provider thread id with enough context for cleanup or
diagnosis. It must not report a successful fork unless local child session and
lineage persistence completed.

## GUI Integration

Extend `AgentActivityRuntime` with:

```ts
forkSession(input: AgentActivityForkSessionInput): Promise<AgentActivityForkSessionResult>
```

Desktop adapter calls the new tuttid endpoint.

Agent GUI actions:

- Conversation menu calls `forkSession` without `lastTurnId`.
- Turn/message menu calls `forkSession` with the selected completed `turnId`.
- On success, reload or merge the activity snapshot and activate the child
  session.
- Header displays a compact parent indicator for forked sessions.

The GUI should not compute default fork titles. It may pass an explicit title
only when the user edits one.

## Errors

Use stable app error codes:

- `agent.fork_unsupported_provider`: provider has no fork implementation.
- `agent.fork_parent_not_found`: source session is missing.
- `agent.fork_provider_session_missing`: parent has no provider session id.
- `agent.fork_session_not_idle`: parent has an active turn.
- `agent.fork_turn_not_found`: `lastTurnId` was not found.
- `agent.fork_turn_in_progress`: `lastTurnId` identifies an active turn.
- `agent.fork_target_conflict`: requested child session id already exists.
- `agent.fork_request_conflict`: request id exists with different parameters.
- `agent.fork_provider_failed`: provider `thread/fork` failed.
- `agent.fork_persistence_failed`: provider fork succeeded but local persistence
  failed.

HTTP mapping:

- `400` for invalid input and missing/invalid `lastTurnId`.
- `404` for missing parent session.
- `409` for a non-idle parent, active turn, target conflict, or request conflict.
- `422` for unsupported provider.
- `502` for provider fork failure.
- `503` for unavailable runtime or storage dependencies.

## Tests

Backend unit tests:

- Codex adapter sends `thread/fork` with parent thread id.
- Codex adapter passes `lastTurnId`.
- Codex adapter maps response `thread.id` to child `providerSessionId`.
- Runtime controller rejects unsupported providers.
- Service creates child session, lineage row, and child messages.
- Service applies title rule `<parent title>(fork<num>)`.
- Service increments fork number for repeated direct forks.
- Service respects explicit child title.
- Service rejects a whole-conversation fork while the parent is working.
- Service rejects in-progress turn fork.
- Service handles idempotent request replay.
- Service rejects request id reuse with different parameters.
- Service reports provider success plus local persistence failure as failure.

Storage tests:

- Migration creates lineage table and parent index.
- Deleting a child session deletes its lineage row.
- Parent lookup returns all direct child forks.

Frontend tests:

- Conversation menu triggers fork without `lastTurnId`.
- Turn menu triggers fork with selected `turnId`.
- Running turn disables `Fork from here`.
- Successful fork activates the returned child session.
- Forked session header shows parent title/indicator.

## Rollout Plan

1. Add storage migration and repository methods for fork lineage.
2. Add runtime fork types and controller method.
3. Implement Codex adapter `thread/fork`.
4. Add tuttid service and API endpoint.
5. Generate OpenAPI clients.
6. Add desktop adapter/runtime method.
7. Add Agent GUI actions and parent indicator.
8. Add tests across runtime, service, API, storage, and GUI.

## Current Decisions And Future Extensions

- The first version logs orphan Codex thread ids when local persistence fails.
  A cleanup command can be added later, but it is not part of this delivery.
- The first version shows only the direct parent indicator in Agent GUI. A fork
  tree can be built later from `workspace_agent_session_forks`.
- The first version accepts Tutti canonical turn ids as `lastTurnId`. If Codex
  provider turn ids diverge from Tutti turn ids in a future protocol, tuttid
  should add an explicit mapping layer rather than accepting ambiguous ids.
