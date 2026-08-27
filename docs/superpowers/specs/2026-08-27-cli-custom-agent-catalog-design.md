# CLI Custom Agent Catalog Design

**Goal:** Expose GUI-created custom Agents to CLI discovery so Issue and Plan
orchestration can resolve and dispatch their exact `agentTargetId`, without
coupling `apps/cli` to SQLite or changing global Agent Target semantics.

## Decision

Add a daemon-internal discovery boundary that combines global enabled Agent
Targets with workspace-scoped custom Agents. The primary contract is that
`tutti agent list --json` includes custom Agent entries (using exact IDs such as
`workspace-agent:<uuid>`); a dedicated custom-Agent list command is an
acceptable equivalent only if Issue and Plan orchestration can consume its
returned IDs. The discovery result is queried synchronously from authoritative
services so a committed GUI change is immediately visible to CLI callers. A
custom Agent is included only when the CLI invocation has a resolved workspace
context; invocations without workspace context continue to return only global
Agent Targets.

The CLI remains a thin daemon client. It receives exact IDs and rendered
metadata from `tuttid` and never opens the SQLite database or interprets the
`workspace_agents` schema.

## Identity and Scope

- Built-in and extension targets retain their existing exact IDs.
- A custom Agent retains its `workspace-agent:<uuid>` ID from
  `workspace_agents.agent_id`.
- `harness_agent_target_id` identifies the underlying runtime only; it is not
  exposed as the launch identity.
- Custom Agents are queried by `workspaceID` and are never merged across
  workspaces.
- A missing or disabled harness keeps the custom Agent discoverable with an
  unavailable status, while launch validation remains fail-closed.
- The explicit desktop default remains authoritative and is not replaced by a
  custom Agent inferred from provider or list order.

## Data Flow

```text
CLI command
  -> tuttid command provider
  -> Agent Catalog
       -> AgentTargetService.List()
       -> WorkspaceAgentService.List(workspaceID), when workspace exists
  -> unified AgentEntry
```

`agent list`, `agent composer-options`, `agent start`, and `agent skill-bundle`
must use the same discovery/selector semantics. `agent list` without workspace
returns the existing global catalog. With workspace context it appends the
workspace custom Agents in stable order and preserves the global default ID.
The Issue and Plan orchestration paths must be able to take an ID returned by
discovery and pass it as `agentTargetId` without manually inlining the custom
Agent's role instructions.

## Error Handling

- An unknown or disabled exact ID fails before session creation and points the
  caller to `agent list --json`.
- A custom Agent whose harness is missing, disabled, or unavailable remains in
  discovery output with its exact ID and availability details.
- A command requiring custom-Agent resolution without workspace context returns
  a clear invalid-input error rather than querying an arbitrary workspace.
- Existing provider-based compatibility selectors remain adapters and must not
  guess between multiple matching custom Agents.

## Verification

The implementation must prove these observable contracts at the daemon CLI
boundary:

1. A workspace custom Agent appears in `agent list --json` (or the equivalent
   custom-Agent discovery command) only with matching workspace context.
2. Discovery returns its exact `workspace-agent:<uuid>` ID as the
   `agentTargetId` consumed by orchestration.
3. The discovered ID is accepted by `composer-options` and `agent start`.
4. Issue and Plan task creation can persist and dispatch that exact ID.
5. Two custom Agents sharing one harness remain distinct.
6. A custom Agent with a missing or disabled harness is listed as unavailable
   and cannot be started.
7. An Agent from another workspace is not visible or resolvable.
8. Global no-workspace discovery and default-target behavior remain unchanged.

The first implementation uses authoritative synchronous reads. Short-lived
availability caching may be added only after measuring a real bottleneck.
Outbox events and a materialized projection are explicitly deferred until
cross-consumer demand or measured query cost justifies their consistency and
rebuild machinery.
