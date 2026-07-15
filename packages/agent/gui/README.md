# @tutti-os/agent-gui

AgentGUI renders workspace agent sessions, timelines, approvals, and composer
UI. It is a UI package, not a host transport or business-core package.

Before changing AgentGUI, AgentGuiNode, or the agent conversation module, read
[AgentGuiNode Architecture and Troubleshooting](../../../docs/architecture/agent-gui-node.md).
It defines daemon, workspace-engine, GUI-module, provider, and desktop-host
ownership.

## Data Source

The injected workspace `AgentSessionEngine`, reached through
`AgentActivityRuntime`, is AgentGUI's only source for canonical agent activity
data.

Runtime-owned data includes:

- canonical sessions, turns, interactions, and operation state
- prompt queue and correlated optimistic intents
- stable selector projections
- semantic session, turn, prompt, interaction, settings, and goal commands

Runtime-owned capability declarations are optional and default to enabled:

- `canCancel`: shows and enables Stop/cancel controls.
- `canSubmitInteractive`: shows approval, ask-user, and plan-decision
  interaction entries.
- `canGoalControl`: shows goal banner controls, `/goal`, and the goal badge.
- `canUploadAttachment`: enables prompt attachment paths. Pasted large text
  additionally requires the explicit `AgentActivityRuntime.stagePastedText`
  host method; AgentGUI does not infer that capability from generic file
  upload support. Ordinary `@` references and workspace-reference mentions
  remain available.

## Pasted Text Staging

AgentGUI classifies plain-text clipboard content before delegating structured
mention HTML. A trimmed payload of at least 5,000 characters is never inserted
into the prompt automatically. It becomes a pasted-text draft attachment and
is passed as raw text to `AgentActivityRuntime.stagePastedText`; the host owns
local persistence and returns `{ path, name, sizeBytes }`.

If the method is absent or staging fails, the attachment remains in an explicit
failed state and retains its in-memory text. AgentGUI must not silently put the
payload back into the input. The user can explicitly choose “Show in text
field” to do that. Generic `uploadPromptContent` remains the contract for
images and host-local files; it is not a pasted-text capability signal.

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

Host capabilities remain separate from activity data. `AgentHostApi` is still
accepted for host capabilities that are not agent activity data:

- workspace files and file references
- clipboard
- account/user lookup
- user-project selection
- local file picking/reading and batch export helpers

AgentGUI has no host-API activity fallback. A host must inject the runtime and
the grouped `AgentGUINodeProps` responsibility objects.

## Boundary Rule

`AgentActivity*` types from `@tutti-os/agent-activity-core` are the canonical
frontend agent activity model. Production reads use exported engine selectors;
production writes use engine commands. GUI modules must not read entity maps,
subscribe to daemon streams, or reconstruct session/turn lifecycle from
messages.

Runtime identity is explicit: each consumer resolves the injected engine and
verifies its `(workspaceId, origin)` identity. Module-global runtime slots and
hidden origin registries are forbidden.

Run this boundary check after changing AgentGUI data flow:

```sh
pnpm check:agent-activity-runtime-boundaries
```

## Node Contract

`AgentGUINodeProps` has eight required top-level responsibilities:
`identity`, `workspace`, `frame`, `state`, `runtimeRequests`,
`hostCapabilities`, `hostActions`, and `renderSlots`. Extend the owning object;
do not restore flat compatibility props.

## Reference Provenance Filtering

Reference provenance filtering is disabled by default. Collaboration hosts can
opt in by injecting the complete catalog through
`hostCapabilities.referenceProvenanceFilterCatalog`:

```tsx
<AgentGUI
  {...props}
  hostCapabilities={{
    referenceProvenanceFilterCatalog: {
      enabledDimensions: ["agent", "member"],
      agentOptions: [{ id: "agent-1", label: "Agent 1" }],
      memberOptions: [{ id: "member-1", label: "Member 1" }]
    }
  }}
/>
```

The catalog is host-owned: option IDs must be durable identities understood by
the host's injected reference/search providers. Active dimensions are passed
to those providers as query metadata and must be enforced before pagination.
Sources that cannot enforce an active dimension must fail closed instead of
returning unfiltered results.

`referenceProvenanceFilterEnabled` remains as the legacy Tutti personal-edition
switch. When enabled without an explicit catalog, AgentGUI derives only the
Agent options from the Agent directory and keeps `memberOptions` empty. Omitting
both properties keeps the filter off. An explicitly supplied catalog (including
`null`) takes precedence over the legacy switch.

## Home Suggestions

The five starter entries below the empty new-session composer are enabled by
default. External hosts can hide individual entries with the public
`AgentGUI.disabled` array:

```tsx
<AgentGUI disabled={["meet-tutti", "import-session"]} {...props} />
```

The supported stable IDs are `meet-tutti`, `task-breakdown`, `quality-review`,
`agent-interaction`, and `import-session`. Omitting `disabled` (or passing an
empty array) renders all five entries.

## Agent Directory

`AgentGUI` requires the host's `/agents` projection through its `agents` prop.
The array is the complete UI directory and its order is authoritative. AgentGUI
does not add provider catalog entries when the array is empty.

```ts
export interface AgentGUIAgent {
  agentTargetId: string;
  name: string;
  iconUrl: string;
  heroImageUrl?: string | null;
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

Runnable provider targets are host-supplied. If the target catalog is absent,
AgentGUI presents an explicit unavailable state; it does not synthesize local
targets from presentation metadata.

Agent names, primary icons, and optional home-carousel artwork come from
`agents[].name`, `agents[].iconUrl`, and `agents[].heroImageUrl`.
`owner.avatarUrl` is rendered separately as an ownership badge. Invalid entries
and duplicate `agentTargetId` values are discarded by
`normalizeAgentGUIAgents`, with the first occurrence preserving host order.

With one agent, AgentGUI hides the aggregate `All` entry and renders that agent
directly. With multiple agents, it shows `All` plus the host-ordered agent rail
and empty-home carousel. Hosts may customize the aggregate icon with
`allAgentsPresentation.iconUrl`.

Hosts adapting daemon-owned agent targets must resolve the target's descriptor
`iconKey` instead of assuming it equals the provider ID. The narrow
`@tutti-os/agent-gui/provider-icons` subpath exports
`resolveProviderIconAsset(iconKey, variant)` for that adapter seam. Unknown
keys return `null`; hosts should render a neutral icon rather than silently
substituting another provider's icon.

Hosts that need provider identity presentation may call
`resolveAgentGUIProviderIdentity(value)` from the narrow
`@tutti-os/agent-gui/provider-identity` subpath. Migrated providers resolve from
the generated descriptor catalog, which is checked against the daemon provider
registry and OpenAPI provider enums.

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

Pass the full `agentDirectory` lifecycle snapshot for directory hydration and
use `renderAgentsEmpty` for a host-specific loaded-empty state. Use
`renderAgentUnavailableState` or
`renderAgentReadinessState` for host-specific availability presentation, and
handle install/login/refresh requests through `onAgentAvailabilityAction`.

The old public `providerTargets`, `providerRailMode`, provider-target renderers,
and `defaultProviderTargetId` contract is intentionally unsupported. Workbench
state hydration performs a one-time read of legacy `providerTargetId` into
`agentTargetId`; new state writes contain only `agentTargetId`.
