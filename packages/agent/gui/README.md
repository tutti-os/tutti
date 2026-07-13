# @tutti-os/agent-gui

AgentGUI renders workspace agent sessions, timelines, approvals, and composer
UI. It is a UI package, not a host transport or business-core package.

Transcript Markdown supports Mermaid diagrams in explicit fenced code blocks:

````markdown
```mermaid
flowchart TD
  A[Start] --> B[Finish]
```
````

AgentGUI keeps Mermaid source as a fallback when a diagram is still streaming
or cannot be rendered.

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

Runtime-owned capability declarations are optional and default to enabled:

- `canCancel`: shows and enables Stop/cancel controls.
- `canSubmitInteractive`: shows approval, ask-user, and plan-decision
  interaction entries.
- `canGoalControl`: shows goal banner controls, `/goal`, and the goal badge.
- `canUploadAttachment`: enables prompt attachment upload paths such as pasted
  images, pasted large text, and dropped or host-local files. Ordinary `@`
  references and workspace-reference mentions remain available.

Slash commands come from the runtime session command snapshot. AgentGUI keeps
legacy provider-default slash entries unless the host passes
`slashCommandFallbackMode="none"`, which makes the slash palette show only
runtime-advertised commands. The mode only controls whether AgentGUI synthesizes
provider fallback entries; owner-advertised built-in command names still keep
AgentGUI's local interaction semantics for a consistent composer experience.

If `reportDiagnostic` is omitted, non-production development builds emit AgentGUI
diagnostics to `console` by default for message page requests/resolutions,
render-state changes, and caught errors. Set
`devDiagnosticConsoleSink: false` on the runtime to disable that development
fallback. Production builds stay silent unless the host provides
`reportDiagnostic`.

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

## Agent Directory

`AgentGUI` requires the host's `/agents` projection through its `agents` prop.
The array is the complete UI directory and its order is authoritative. AgentGUI
does not add provider catalog entries when the array is empty.

```ts
export interface AgentGUIAgent {
  agentTargetId: string;
  name: string;
  iconUrl: string;
  description?: string | null;
  owner?: {
    name?: string | null;
    avatarUrl?: string | null;
  } | null;
  availability: {
    status:
      | "ready"
      | "checking"
      | "coming_soon"
      | "not_installed"
      | "auth_required"
      | "unavailable";
    reason?: string | null;
    pendingAction?: "install" | "login" | "refresh" | null;
  };
  provider: AgentGUIProvider;
}
```

`agentTargetId` is the sole entry identity used for selection, filtering,
composer option lookup, persisted node state, and new-session launch. Two agents
may share the same `provider` and remain distinct. `provider` is runtime metadata
for provider-native execution, composer policy, probes, and capabilities; it
must not be used to group, deduplicate, name, icon, or select agents.

Agent names and primary icons always come from `agents[].name` and
`agents[].iconUrl`. `owner.avatarUrl` is rendered separately as an ownership
badge. Invalid entries and duplicate `agentTargetId` values are discarded by
`normalizeAgentGUIAgents`, with the first occurrence preserving host order.

With one agent, AgentGUI hides the aggregate `All` entry and renders that agent
directly. With multiple agents, it shows `All` plus the host-ordered agent rail
and empty-home carousel. Hosts may customize the aggregate icon with
`allAgentsPresentation.iconUrl`.

Inside AgentGUI, normalized directory entries use the canonical
`AgentGUIAgentTarget` / `agentTargets` vocabulary. `provider` is execution
metadata, not target identity. Rail tiles, the single-agent empty state, and
the WebGL empty-home carousel all project the same agent-target avatar
presentation, including the owner badge; renderer-specific DOM and WebGL code
must not rebuild partial icon-only models.

Hosts serving `owner.avatarUrl` from another origin must enable anonymous CORS
for that asset. The WebGL carousel keeps a local programmatic owner marker when
the remote image cannot be decoded or uploaded safely, while DOM avatar
surfaces continue using the same shared presentation.

Use `agentsLoading` for directory hydration and `renderAgentsEmpty` for a
host-specific loaded-empty state. Use `renderAgentUnavailableState` or
`renderAgentReadinessState` for host-specific availability presentation, and
handle install/login/refresh requests through `onAgentAvailabilityAction`.

The old public `providerTargets`, `providerRailMode`, provider-target renderers,
and `defaultProviderTargetId` contract is intentionally unsupported. Workbench
state hydration performs a one-time read of legacy `providerTargetId` into
`agentTargetId`; new state writes contain only `agentTargetId`.
