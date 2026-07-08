# @tutti-os/agent-gui

AgentGUI renders workspace agent sessions, timelines, approvals, and composer
UI. It is a UI package, not a host transport or business-core package.

Before changing AgentGUI, AgentGuiNode, or the agent conversation module, read
[AgentGuiNode Architecture and Troubleshooting](../../../docs/architecture/agent-gui-node.md).
It records the source-of-truth rules, common chains, debugging playbooks, and
the self-evolution loop for durable lessons.

## Data Source

`AgentActivityRuntime` is the AgentGUI source for agent activity data.

Runtime-owned data includes:

- workspace activity snapshots
- session lists
- paged session messages
- retained live session events
- session event subscriptions
- session create, activate, unactivate, input, cancel, interactive submit,
  delete, pin, settings update, control-state read, composer-options read, and
  get session operations
- provider/session preparation hooks that directly gate activity flow, such as
  OpenClaw gateway warmup

`AgentHostApi` is still accepted for host capabilities that are not agent
activity data:

- workspace files and file references
- clipboard
- runtime metadata and diagnostics
- account/user lookup
- user-project selection
- local file picking/reading and batch export helpers

Production AgentGUI must receive `agentActivityRuntime` and must not use legacy
Host API methods as an agent data fallback. Compatibility helpers remain only
for projection boundaries, non-desktop legacy hosts, and tests.

## Boundary Rule

`AgentActivity*` types from `@tutti-os/agent-activity-core` are the canonical
frontend agent activity model.

`AgentHostWorkspaceAgent*` DTOs are allowed only in compatibility/projection
code that adapts legacy AgentGUI internals. New production read paths should use
`useAgentActivityRuntime()` or `useOptionalAgentActivityRuntime()` instead of
calling `workspaceAgents.list`, `workspaceAgents.listSessionMessages`,
`agentSessions.retainEventStream`, `agentSessions.subscribeEvents`, or
`agentSessions.getState` directly. Production writes should call runtime methods
instead of `agentSessions.activate`, `agentSessions.unactivate`,
`agentSessions.exec`, `agentSessions.cancel`, `agentSessions.submitInteractive`,
`agentSessions.updateSettings`, or `agentSessions.pinSession`.

Run this boundary check after changing AgentGUI data flow:

```sh
pnpm check:agent-activity-runtime-boundaries
```

## Provider Targets

`provider` remains the real provider identity, such as `codex`,
`claude-code`, or `nexight`. AgentGUI uses that identity for composer options,
settings, icons, probes, status, and provider-specific UI policy.

Hosts may pass `providerTargets` when a real provider has multiple launch
targets. A target has display metadata plus an opaque `ref`:

```ts
export interface AgentGUIProviderTargetRef {
  kind: string;
  provider: AgentGUIProvider;
  [key: string]: unknown;
}

export interface AgentGUIProviderTarget {
  targetId: string;
  provider: AgentGUIProvider;
  ref: AgentGUIProviderTargetRef;
  label: string;
  description?: string;
  ownerLabel?: string;
  disabled?: boolean;
  unavailableReason?: string;
}
```

AgentGUI does not interpret `ref.kind` and does not treat `targetId` or `ref`
as authority. It displays `target.label`, keeps provider logic keyed by the
real `target.provider`, and starts new sessions with the selected
`agentTargetId`. Trusted host code must re-authenticate the current
user/workspace and resolve any invocation plan before launching.

If `providerTargets` is omitted or empty, AgentGUI creates local targets such as
`local:codex` and `local:claude-code` from the static provider catalog for
display/backward compatibility. Those static catalog targets are not persisted
or sent as session creation authority.
