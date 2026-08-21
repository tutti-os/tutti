# @tutti-os/agent-gui

AgentGUI renders workspace agent sessions, timelines, approvals, and composer
UI. It is a UI package, not a host transport or business-core package.

## Product Error Presentation

AgentGUI does not own Account or Commerce UI. Product hosts render those
surfaces through `@tutti-os/commerce` and its `./react` entrypoint.

Hosts may pass `hostCapabilities.visibleErrorPresentationOverrides` to
customize structured product errors such as `insufficient_credits`. The
override contains only localized copy and an optional sanitized external
action; it does not expose membership state, credentials, or Commerce response
objects to AgentGUI. Raw provider error details remain available to diagnostics
and are rendered only behind an explicit disclosure, never in the product error
headline. Environment, authentication,
network, and runtime errors are not overridable and remain AgentGUI policy.

Hosts that render an Agent owned by somebody else must pass
`hostCapabilities.visibleErrorPresentationScope: "shared_caller"`. AgentGUI
then preserves structured failure reasons and diagnostic disclosure, replaces
Owner-remediable guidance with caller-safe contact guidance, and suppresses
current-device and current-account recovery actions. Omission defaults to
`"local_owner"` for backward compatibility. The scope is presentation-only;
it never changes a Turn, activity event, persistence, or provider error.
Hosts that inject an application i18n runtime must also provide
`agentHost.agentGui.visibleErrorSharedCallerHint` in every supported locale.

This is an intentional public API break. The former `accountMenuState`,
`commercePresentation`, `AgentGUIAccountMenu*`, and
`AgentGUIAccountRewardToast` surfaces were removed instead of being retained as
silent no-ops. Hosts must render account chrome through
`@tutti-os/commerce/react` and translate Commerce policy into
`visibleErrorPresentationOverrides`.

Before changing AgentGUI, AgentGuiNode, or the agent conversation module, read
[AgentGuiNode Architecture and Troubleshooting](../../../docs/architecture/agent-gui-node.md).
It defines daemon, workspace-engine, GUI-module, provider, and desktop-host
ownership.

## Data Source

The injected workspace `AgentSessionEngine`, reached through
`AgentGUIRuntime`, is AgentGUI's only source for canonical agent activity
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
  additionally requires the explicit `AgentGUIRuntime.stagePastedText`
  host method; AgentGUI does not infer that capability from generic file
  upload support. Ordinary `@` references and workspace-reference mentions
  remain available.

## Pasted Text Staging

AgentGUI classifies plain-text clipboard content before delegating structured
mention HTML. A trimmed payload of at least 5,000 characters is never inserted
into the prompt automatically. It becomes a pasted-text draft attachment and
is passed as raw text to `AgentGUIRuntime.stagePastedText`; the host owns
persistence and returns either a local `{ path, name, sizeBytes }` locator or
a remote `{ url, name, sizeBytes, assetId?, uri?, uploadStatus? }` prepared
attachment. Local text is sent as a read-file instruction; a remote locator is
sent as an ordinary prepared file, so shared hosts reuse their attachment path.
Its conversation display mention contains only the pasted-text preview, never
the remote URL or storage locator.

If the method is absent or staging fails, the attachment remains in an explicit
failed state and retains its in-memory text. AgentGUI must not silently put the
payload back into the input. The user can explicitly choose “Show in text
field” to do that. Generic `uploadPromptContent` remains the image-upload
contract; it is not a pasted-text or external-file capability signal.

## External File Preparation

OS clipboard and drop entries first use the optional synchronous workspace
`resolveExternalPromptEntries` host port. The host classifies every input as a
live `WorkspaceFileReference` or a snapshot that needs preparation. AgentGUI
inserts references directly as ordinary file/folder mentions, preserves mixed
input order, and sends only `prepare` entries to `prepareExternalPromptFiles`.
Without the resolver, every input uses preparation.

Both ports return one result per input `sourceIndex`. The resolver is
synchronous so paste/drop insertion position remains stable. Prepared files
require a provider-readable `path` or `url`; failures require a typed
`errorCode`. Hosts must isolate per-file failures and reject oversized inputs
before reading or persisting their bytes. A host that resolves path-backed
entries as references must also reject any such entry that unexpectedly reaches
preparation, preventing a resolver failure from creating a duplicate snapshot.

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

## Worktree Session Launch

New-Session worktree launch is an opt-in host contract. A host enables it with
`hostCapabilities.sessionWorktreeEnabled`, supplies the current workspace's
durable `sessionLaunchModesByProjectSectionKey` projection, handles
`hostActions.onSessionLaunchModePreferenceChange`, and implements
`AgentHostApi.workspace.resolveSessionWorktreeSupport`. Omitting any part fails
closed and preserves the existing local-checkout launch behavior, so published
AgentGUI consumers do not acquire the feature until they opt in.

AgentGUI exposes the selector only for a new Session whose exact selected Agent
Target is self-owned and whose selected registered project passes the host
probe. Shared or remote targets, existing Sessions, missing projects, and
unsupported repositories show no selector. The stored preference is not
rewritten when current support disappears: the effective launch falls back to
`local`, and the saved `worktree` choice becomes effective again if the same
workspace and project section later regain support. Opening an existing
Session never changes the launch preference.

The preference is launch intent, keyed by workspace id and canonical project
`sectionKey`; it is separate from a Session's durable `isolation` fact. A
worktree launch sends `isolation: "worktree"` through the semantic activation
path. Rail summaries may render the package worktree glyph from the resulting
canonical Session isolation metadata, next to relative time in the unhovered
row; they must not infer isolation from `cwd`.

AgentGUI has no host-API activity fallback. A host must inject the runtime and
the grouped `AgentGUINodeProps` responsibility objects.

## Side Presentation

Side remains a surface-owned, transient conversation. By default AgentGUI
renders it through the inline `AgentGUISideConversationPane`. A host that owns
an external panel system may create an
`AgentGUISideConversationPresentation`, pass it through
`hostCapabilities.sideConversationPresentation`, and render the published
`AgentGUISideConversationSurface` itself.

The presentation store carries only the exact source/Side identities, surface
props, and close intent. It does not own provider commands, runtime state, or
persistence. External hosts must key tabs by the exact identities, propagate
panel visibility through `isVisible` so focus is released while hidden, and
invoke `close` only for the currently matching projection. Omitting the bridge
preserves the inline behavior for existing hosts.

## Headless Conversation Message Controller

`@tutti-os/agent-gui/conversation-message-controller` is the renderer-neutral
query controller for one focused conversation. Desktop AgentGUI and Native
Mobile both use it for initial detail hydration, latest-message reconciliation,
and explicit older-page loading.

Initial and latest reads enter the workspace Engine as semantic Session
reconcile commands. Older-page reads use only the Engine's authoritative
message-window cursor, share one in-flight/retry/stale-request state machine,
and apply the mapped durable page back to that same Engine. A high mutable
message version without an authoritative window is never treated as evidence
of older history.

Hosts supply the mapped message transport and retain lifecycle concerns such as
Mobile foreground/background behavior, disconnected polling, DOM or Native
scrolling, and diagnostics enrichment. The controller does not own navigation,
rendering, localization, or transport authorization. Desktop selection owns
activation guards and Rail projection coordination, then requests initial or
forced message hydration through this controller; it must not add a parallel
messages-only Engine reconcile path.

## Reference Picker Error Recovery

Hosts may provide `workspace.resolveReferenceContentErrorAction` to map a
reference-source content error to a labeled recovery action. AgentGUI passes
the resolver to the shared `ReferenceSourcePicker`; the picker renders the
action in its centered error state and retries the failed browse or search when
the user activates it. Hosts should return an action only for errors they can
recover interactively, such as requesting filesystem authorization again.

## DOM-Free Conversation Projection

`@tutti-os/agent-gui/conversation-projection` is the renderer-neutral entry
for hosts that need the same canonical transcript semantics without importing
the DOM conversation components. Its focused Session projection accepts the
canonical activity snapshot, the selected Session id, and known Turns. It
derives the exact Session and message snapshots from that one activity snapshot
and hides AgentGUI's intermediate activity-card and timeline-item construction.
The host owns rendering, local disclosure, scrolling, i18n, and semantic
commands for pending Interactions.

The entry also exports `resolveAgentConversationNavigationAction`, whose
portable action union contains only external URLs and Agent Session mentions.
Workspace files, local assets, apps, issues, and custom mentions stay in
host-specific capability adapters. The broad Workspace resolver and this
portable resolver share only the host-neutral URL and Agent Session parsing
primitives. Alternate renderers must not parse `mention://` values or invent
fallback file paths locally.

Pending Engine Interactions are projected through
`projectAgentConversationPromptFromInteraction`. The resulting canonical prompt
preserves runtime approval and plan option ids; hosts render it and submit those
exact ids rather than guessing generic allow/deny actions. Missing presentation
copy remains empty so each renderer can supply localized fallback text.

Do not recreate this transformation from raw message kinds in another host.
The public projection is where AgentGUI canonicalizes message snapshots and
groups assistant messages, thinking, tool activity, processing, notices, and
turn summaries.

## DOM-Free Composer Projection

`@tutti-os/agent-gui/composer-projection` exposes the shared pure Composer
support decision and presented-settings projection. The workspace engine
continues to own target-keyed Composer option loads and semantic settings
commands. Alternate renderers receive canonical activity-core options and
session settings, then retain only their menu, sheet, and disclosure UI.

The daemon DTO mapper belongs to
`@tutti-os/agent-activity-tuttid-adapter`, so Desktop and Mobile do not keep
separate parser implementations for Composer capabilities or option catalogs.

## Performance Failure Events

`AgentGUIPerformanceEvent` failure settlements carry a bounded `errorCode` and
`failureStage` when the operation fails. `errorCode` comes from a stable
machine-readable error field and falls back to `unknown`; raw error messages
are never included. Composer option failures use `options_load`, Session
activation uses `session_activation`, Prompt admission uses `prompt_admission`,
and Turn failures use `turn_settlement`. Each settlement keeps its existing
`operationId`, so hosts can deduplicate repeated observations without using
provider names, timestamps, or error text.

## Quick Composer

`@tutti-os/agent-gui/quick-composer` renders the canonical DOM Composer for a
launcher that needs text, image drafts, and exact Agent Target selection without
the Rail or timeline. It is controlled by typed prompt content and returns the
same prompt envelope on submit. It intentionally owns no Session lifecycle or
Composer-options loading; the host must route submit through its existing
workspace `AgentSessionEngine`. Its embedded layout keeps attachments and long
drafts in normal flow; hosts must not wrap the timeline-oriented dock layout in
fixed-height launch surfaces.

Agent selection is fail-closed. The host passes the canonical `agentTargetId`
and a capability snapshot for every selectable target. Quick Composer resolves
only that exact identifier: an unknown, disabled, or capability-less target
keeps submit unavailable instead of falling back to the first target or
guessing a provider. Image drafts are accepted only when the selected target's
declared content types include images. The submit envelope returns the resolved
`agentTargetId`, content, and display prompt so the host cannot activate a
different target from the one the user saw.
The public target contract does not accept AgentGUI's legacy `targetId` or
internal `ref`; Quick Composer derives both internal fields from the canonical
`agentTargetId` before rendering the shared selector.

Hosts that need canonical `@` results pass a `RichTextMentionService`; hosts
that enable the `+` control pass `onRequestWorkspaceReferences`. Quick Composer
installs both through the same AgentGUI Composer boundaries used by the full
surface and never owns a second reference source. Fixed or frameless launchers
should pass `menuViewportTopInset` for title-bar chrome that portaled provider
and mention menus must avoid. A host with a definite height may set
`fillAvailableHeight`; a host that needs every bottom control on one baseline
may set `composerActionPlacement="footer"`. Both are optional presentation
contracts and do not change prompt or Session ownership. A host whose own
window chrome already defines the visual perimeter may set
`inputSurfaceVariant="borderless"` to suppress the redundant inner outline
without overriding AgentGUI implementation selectors.

Standalone hosts may inject an AgentGUI i18n runtime. Otherwise Quick Composer
uses the package defaults; hosts must not render translation keys or hardcode a
second copy of Composer-visible text.

A launcher that owns project selection passes a real `WorkspaceUserProjectApi`
as `userProjectApi`, together with `selectedProjectPath` and
`onProjectPathChange`. Quick Composer then renders the canonical project
selector in its footer and delegates catalog reads, selection preparation, and
project registration to that API. A directory picker alone does not enable the
selector and never becomes a synthetic registered-project catalog. The host
remains responsible for carrying the selected path through its normal
new-Session activation input.

## Standalone Conversation Participant Presentation

The `@tutti-os/agent-gui/agent-conversation` entrypoint exposes one optional,
host-owned participant presentation contract on `WorkspaceAgentSessionDetail`,
`AgentConversationFlow`, and `AgentTranscriptView`:

```tsx
<WorkspaceAgentSessionDetail
  participantPresentation={{
    enabled: true,
    status: "ready",
    user: { name: "Alice", avatarUrl: userAvatarUrl },
    agent: { name: "Codex", avatarUrl: agentAvatarUrl }
  }}
  {...props}
/>
```

Omitting the property or passing `{ enabled: false }` preserves the existing
transcript DOM and spacing. Pass `{ enabled: true, status: "loading" }` while
the host is resolving identities; existing messages stay visible and the
package renders fixed-size circular loading slots. In the `ready` state, each
participant requires a non-empty `name`; `avatarUrl` is optional and the shared
UI System `Avatar` falls back to the name's initial.

Participant headers are turn-scoped. Agent GUI renders at most one header for
each speaker in a presentation turn, even when thinking, tool progress, or
turn-work disclosure splits that turn into multiple message rows. A completed
collapsed turn anchors the Agent header to visible reply content instead of the
hidden work section.

The host owns identity lookup and lifecycle. Agent GUI owns placement, sizing,
loading treatment, image fallback, and left/right message alignment. The
contract is presentation-only and must not be copied into canonical Session,
Turn, Message, or workspace-engine state.

## Session Handoff Drafts

External AgentGUI hosts can use `createAgentSessionHandoffPrompt` to prefill a
destination Agent composer with the same canonical complete-session mention as
AgentGUI's built-in Handoff menu. The helper owns mention serialization and the
trailing rich-text caret space; hosts continue to own destination selection and
window launch behavior.

Hosts that copy a session reference without launching a handoff must use
`createAgentSessionMarkdownLink`. This is the same canonical serializer used by
AgentGUI's Copy as reference action. Pass `withAtPrefix: true` when the copied
value should paste back into Agent and room-chat composers as an `@` session
mention; unlike the handoff helper, it does not append a trailing caret space.

## Boundary Rule

`AgentActivity*` types from `@tutti-os/agent-activity-core` are the canonical
frontend agent activity model. Production reads use exported engine selectors;
production writes use engine commands. GUI modules must not read entity maps,
subscribe to daemon streams, or reconstruct session/turn lifecycle from
messages.

Runtime identity is explicit: each consumer resolves the injected engine and
verifies its `(workspaceId, origin)` identity. Module-global runtime slots and
hidden origin registries are forbidden.

The `@tutti-os/agent-gui/conversation-rail-runtime` subpath exposes the
host-neutral Rail query/mutation cohort through
`createAgentConversationRailRuntime` and its runtime/source types. Method-name
manifests and UI capability inspection remain package-internal; hosts use the
typed factory instead of importing test helpers. The sibling
`@tutti-os/agent-gui/conversation-rail-controller` subpath exposes the canonical
`createAgentGUIConversationRailQueryController` factory and controller
interface used by Desktop and Native Mobile. The headless implementation owns
Rail query scope, first-page and cursor pagination, cache and stale-request
handling, membership refresh, and canonical Engine ingestion. Hosts supply
transport and Session mapping, then retain only host lifecycle, availability,
polling, diagnostic context, and presentation policy. Do not instantiate the
internal controller, create a host-local second Rail state machine, or export
its internal query helpers as public API.
Its public snapshot is presentation-free; Desktop derives localized
conversation summaries from that snapshot plus Engine state in its adapter.
The factory owns resolved-query cache reuse per workspace Engine; cache access
is not a runtime or host capability and has no published package entrypoint.
In-flight first-page results are fenced to the attached controller generation
so stale mounts cannot mutate the Engine or cache.

The `@tutti-os/agent-gui/abortable-single-flight` subpath exposes the generic
`AbortableSingleFlight` lifecycle primitive for host adapters that need to
coalesce keyed abortable reads while keeping caller cancellation independent.
The primitive owns only request sharing and cancellation; cache, snapshot, and
event ownership remain with the host adapter.

Run this boundary check after changing AgentGUI data flow:

```sh
pnpm check:agent-activity-runtime-boundaries
```

## Node Contract

`AgentGUINodeProps` has eight required top-level responsibilities:
`identity`, `workspace`, `frame`, `state`, `runtimeRequests`,
`hostCapabilities`, `hostActions`, and `renderSlots`. Extend the owning object;
do not restore flat compatibility props.

Hosts may provide `renderSlots.agentTargetInfo` to enrich the exact Agent icon
in the provider Rail and Conversation Rail. The renderer receives
`{ target, surface }` and returns one React element, or `null` to retain the
built-in target-label fallback. AgentGUI owns Tooltip mechanics and calls the
renderer only while the content is mounted. Pass the same renderer plus an exact
`conversationAgentTarget` to `AgentGuiWorkbenchHeader` for the Header icon.
Conversation history resolves the current Host directory by canonical
`agentTargetId`; missing targets show no enriched Tooltip and target metadata
is never copied into Session state.

Workbench hosts capture Dock and minimize previews from the mounted AgentGUI
node. AgentGUI does not expose a second-tree preview renderer or preview-mode
contract.

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

The six starter entries below the empty new-session composer are enabled by
default. External hosts can hide individual entries with the public
`AgentGUI.disabled` array:

```tsx
<AgentGUI disabled={["meet-tutti", "import-session"]} {...props} />
```

The supported stable IDs are `meet-tutti`, `clone-github-repository`,
`task-breakdown`, `quality-review`, `agent-interaction`, and `import-session`.
Omitting `disabled` (or passing an empty array) renders all six entries.

## Tutti Mode capability

Tutti Mode UI (composer footer chip, composer badge activation, `/tutti`) is a
host-gated product capability under
`hostCapabilities.capabilityMenuState.tuttiMode.enabled`.

Hosts must set `enabled: true` to show those controls. Omitting `tuttiMode` or
setting `enabled: false` fails closed — the same rule as other unsupported host
capabilities. External hosts that share AgentGUI for Codex/Claude/VM sessions
should keep Tutti Mode disabled unless they intentionally productize it, and
should also hide Tutti branding home chips via `disabled` (for example
`meet-tutti`).

```tsx
<AgentGUI
  disabled={["meet-tutti", "import-session"]}
  hostCapabilities={{
    capabilityMenuState: { tuttiMode: { enabled: false } }
  }}
  {...props}
/>
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
  maskIconUrl?: string | null;
  heroImageUrl?: string | null;
  description?: string | null;
  ownerDeviceLabel?: string | null;
  owner?: {
    name?: string | null;
    avatarUrl?: string | null;
  } | null;
  ownership?: "self" | "shared" | null;
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

Agent names, primary icons, optional conversation-mask icons, and optional
home-carousel artwork come from `agents[].name`, `agents[].iconUrl`,
`agents[].maskIconUrl`, and `agents[].heroImageUrl`. Hosts must pass fully
resolved presentation URLs from their authoritative directory. All identity
surfaces use `iconUrl`; conversation rows use `maskIconUrl` where present.
`owner.avatarUrl` is rendered separately as an ownership badge.
`ownerDeviceLabel` is optional host-resolved presentation metadata rendered on
the exact Handoff target row. Invalid entries and duplicate `agentTargetId`
values are discarded by
`normalizeAgentGUIAgents`, with the first occurrence preserving host order.
Hosts set `agents[].ownership` to `"self"` or `"shared"` from their authoritative
directory or launch reference. Owner name and avatar are presentation metadata
and do not determine ownership.

With one agent, AgentGUI hides the aggregate `All` entry and renders that agent
directly. With multiple agents, it shows `All` plus the host-ordered agent rail
and empty-home carousel. Hosts may customize the aggregate icon with
`allAgentsPresentation.iconUrl`.

Daemon-owned system targets seed and refresh their `iconUrl` and `maskIconUrl`
from the target descriptor `iconKey`. AgentGUI consumers must not synthesize
built-in target icons from provider IDs or `iconKey`; stale or missing directory
presentation should be fixed in the source directory.

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

Hosts that launch handoffs across session-runtime boundaries may also pass
`handoffAgentDirectory`. Its ready entries populate only the active-conversation
Handoff menu; the conversation rail, session queries, and empty composer remain
owned by `agentDirectory`. When omitted, Handoff uses `agentDirectory`. Handoff
rows keep the Agent name as the primary identity and render ownership separately:
entries with `ownership: "self"` are labeled as the current user's Agent, while
entries with `ownership: "shared"` are labeled as shared and show the available
owner identity. Entries without explicit ownership remain unclassified; AgentGUI
does not infer ownership from `owner.name`, `owner.avatarUrl`, or other
presentation metadata.

Host-owned task or activity surfaces can render the same target picker with
`AgentHandoffMenu`. Pass the authoritative ready `AgentGUIAgentTarget` entries
and keep launch orchestration in the host's `onSelect` callback; the shared
component owns only menu disclosure, ownership presentation, and handoff-icon
motion.

The old public `providerTargets`, `providerRailMode`, provider-target renderers,
and `defaultProviderTargetId` contract is intentionally unsupported. Workbench
state hydration performs a one-time read of legacy `providerTargetId` into
`agentTargetId`; new state writes contain only `agentTargetId`.

Account and Commerce remain Host chrome. A Host may use
`renderSlots.agentConfigAccount` to replace the selected target's default
account/quota block and `hostActions.onAgentConfigMenuOpen` to refresh its
Host-owned account state. Both receive the same exact target context. Returning
`null` preserves the default provider account and quota presentation; the slot
must not start requests or own menu lifecycle.
