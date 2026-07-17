# Agent GUI Node Architecture

Status: durable target architecture

Applies to:

- `services/tuttid` agent APIs, workflows, and durable state
- `packages/agent/daemon` provider runtimes and provider registry
- `packages/agent/activity-core` workspace agent engine
- `packages/agent/gui` Agent GUI presentation
- `apps/desktop` Agent GUI host integration

This document defines ownership and dependency direction. It does not track
refactor completion; implementation status belongs in the active refactor plan
and review handoff.

## System Shape

```text
provider runtime
  -> tuttid command/event boundary
  -> daemon entities + workflow saga/outbox
  -> workspace AgentSessionEngine
  -> selectors and commands
  -> Agent GUI vertical modules
  -> view components
```

Desktop supplies host capabilities and embeds the GUI. It is not a second agent
business core. Agent GUI renders engine projections and emits commands. It does
not reconstruct durable session or turn truth from panels, transcript rows, or
provider-specific payloads.

## Daemon Ownership

`services/tuttid` owns durable agent entities and workflows:

- session identity, metadata, settings, and resumability
- turn lifecycle, outcome, and exact-turn cancellation
- interactions, approvals, and interactive prompt responses
- prompt submission identity and idempotency
- goal state and long-running workflow state
- durable event ordering and recovery

Durable transcript messages carry two independent order values. `sequence` is
assigned from the durable message row identity when that row is first created
and never changes, so historical pulls, realtime updates, and Agent GUI
projections use it for presentation order. `version` is the mutable per-session
change cursor: updating an existing streaming message advances `version` but
must not move that message in the transcript. Lifecycle timestamps describe
when work started, occurred, or completed and are only compatibility fallbacks
when an older producer has no durable sequence.

Session and turn are separate entities. A session may exist without a running
turn and may contain many settled turns. Running, waiting, completed, failed,
and canceled are turn lifecycle states; they must not be copied onto the
session as a competing lifecycle field.

Conversation lists order a session by the latest user turn: each turn's time is
the earliest user message in that turn, and the session time is the maximum of
those turn times. The renderer uses the projected latest turn directly rather
than loading message history just to calculate this key. A session with no user
message uses its creation time.

Commands that cross process or persistence boundaries use a saga/outbox flow:

```text
validated command
  -> persist intent and outbox record atomically
  -> dispatch to provider runtime
  -> ingest correlated provider events
  -> reduce entity state
  -> mark or retry outbox work
```

Each command carries stable correlation identity. Submit uses a client submit
ID; turn commands identify the exact turn. Retries must be idempotent. Recovery
must resume persisted work rather than infer intent from UI state or the latest
transcript row.

OpenAPI contracts change before daemon HTTP request or response code. Generated
clients and event contracts are projections of that schema, not independent
models.

Goal control follows the same ownership rule but is not a Turn command. Goal is
a durable session-level entity with desired/observed state, a monotonic
revision, and independent control-operation records. A Goal operation may cause
zero or more provider-created Turns; it never reserves a Turn ID. Real Turns
carry immutable origin plus optional source Goal operation/revision. Provider
observations update only observed state, so a late snapshot cannot erase a
newer desired state or clear tombstone. Provider differences are normalized by
the daemon `GoalAdapter`; GUI and service code use the typed Goal API rather
than sending goal banner actions through the prompt pipeline.
Goal-control `session_audit` messages remain durable recovery and diagnostic
evidence, but Agent GUI excludes audits marked `goalControl` from the user
conversation. Goal state and controls are presented through the canonical Goal
projection instead of exposing internal `/goal` control commands as user
messages.

Codex Goal continuation provenance has two ordered paths. A
`thread/goal/updated` notification with `turnId` remains exact provider
evidence and takes precedence. Codex versions that omit that optional field use
an adapter-local, single-use continuation claim instead: a successful
`thread/goal/set` response seeds the first claim for its immutable durable Goal
operation/revision, and settlement of an adopted Goal Turn may seed the next
claim in the same chain. Goal control and ordinary submit setup share the
session lifecycle lock, so a concurrent user submit cannot open a competing
provider Turn while the initial claim is established. A newer Goal operation,
inactive Goal status, adapter restart, multiple simultaneous unowned Turns, or
any conflicting exact evidence invalidates the compatibility claim and fails
closed. The claim is never reconstructed from the mutable latest Goal snapshot
and is not durable across provider-process replacement.

Provider Goal payloads are normalized at the daemon adapter boundary before
they enter session state. In particular, Codex `timeUsedSeconds` and
`tokensUsed` become the canonical `durationMs` and `tokens` fields. Durable
storage, APIs, and renderer code consume only the canonical Goal contract; the
provider-authored payload remains local to provenance matching. Optimistic Goal
presentation does not start an elapsed timer. The timer becomes visible only
after canonical provider state confirms the Goal, using `durationMs` as its
baseline and ticking locally between authoritative updates.

## Workspace Engine Ownership

One `AgentSessionEngine` instance owns agent state for one workspace and runtime
origin. It is the only frontend owner of canonical sessions, turns,
interactions, pending intents, prompt queue state, and workflow operation state.

```text
daemon snapshot/events -> engine reducers -> canonical entity indexes
GUI command             -> engine command -> runtime adapter -> daemon
engine selectors        -> stable GUI projections
```

Consumers must not create parallel stores for canonical agent data. They must
not read reducer maps directly or derive lifecycle from transcript messages.
All reads go through exported selectors; all writes go through engine commands.
The engine reconciles optimistic intent with authoritative events by correlation
ID.

Historical pull and realtime push are distinct engine inputs. Workspace/session
list pulls dispatch `session/snapshotReceived`; these hydrate history without
creating unread completion attention. Realtime `message_update` events may fold
their normalized versioned mutable message snapshots inline only when the unseen
event versions continue from the cached high-water mark. A gap at that boundary
means a mutable message snapshot may have been missed: the bridge must leave the
cache at its pre-gap cursor and request an authoritative incremental pull. A
recovered event-stream connection must also incrementally reconcile every
session whose messages are already hydrated, so a missed final mutation does not
depend on a later event to expose the gap. Do not require the rows already
present in a current snapshot to be internally contiguous, because updating one
`messageId` replaces its earlier version. Realtime turn,
interaction, and legacy state invalidations perform an authoritative session
pull, then dispatch `session/upserted` followed by `turn/upserted` for the
realtime turn. The desktop bridge keeps the one-shot realtime provenance outside
reducer state while that pull is in flight. `AgentActivitySnapshot` is a
memoized projection of the engine state, not a separately mutable controller
snapshot.

The workspace list is root-only. After a successful workspace reconcile, the
engine requests a state detail reconcile for every active root session. Session
detail hydrates that root plus all nested child sessions into the same engine;
this is required before root-conversation consumers can project child activity
or pending interactions after restart. The command executor only performs these
requests; active-root selection and reconcile scope remain engine decisions.

Actionable interaction UI has one read path:

```text
durable Interaction(pending)
  -> interaction_update
  -> AgentSessionEngine pendingInteractions selector
  -> approval / question / exit-plan presentation
```

The conversation rail is part of this actionable interaction presentation. Its
Ask indicator must come from canonical pending interactions, aggregated from a
root session and its child sessions onto the root conversation. A `waiting`
Turn phase without a pending interaction represents background/delegated work
and keeps the working presentation; it must not imply that the user has an
answerable prompt.

Message Center presents one card per root conversation, not one card per child.
Its engine selector aggregates pending interactions and non-terminal activity
from the root and every descendant. Any descendant pending interaction makes
the root card waiting; any descendant still working prevents a terminal root
card. The card keeps root identity for conversation navigation, but each
actionable prompt carries its exact child `(agentSessionId, turnId, requestId)`
target. Inline card and decision-toast submissions dispatch against that exact
target.

The workspace shell and standalone Agent window share one decision-notification
controller and card presentation. When a new pending interaction arrives while
the current window is foregrounded and its Message Center is closed, that
window may surface the actionable card as a persistent top-right toast. Initial
pending interactions are recorded without replaying historical toasts, and a
resolved interaction dismisses its active toast. The workspace shell suppresses
that toast when the same AgentGUI session is already open, while the standalone
Agent window intentionally keeps the top-right card in addition to the inline
prompt. The standalone window does not emit a second OS notification; the
workspace shell remains the owner of the background-only OS face. Toast actions
dispatch the same canonical
`interaction/responseRequested` command as AgentGUI and Message Center instead
of deriving actionability or response identity from transcript messages.

AskUserQuestion uses one shared answer-flow controller in the conversation and
Message Center. Its option drafts, free-text drafts, question navigation,
completion rules, and `buildAskUserAnswerPayload` result are UI-local state
scoped to the canonical `requestId`; changing that request identity remounts the
flow and clears every draft. Full and compact layouts may differ in density,
and compact keeps the single-question single-select one-click path, but both
submit the same payload through the canonical
`interaction/responseRequested` command. The always-visible Open conversation
action is a context/fallback route, not the only way to answer multi-question,
multi-select, or free-text prompts.

Transcript messages are historical presentation only. A tool-call row with a
`waiting_input` status must not create an approval dialog, question composer,
exit-plan prompt, attention item, or pending-interaction view model. Session
snapshots also must not create or recover an Interaction. If canonical
`pendingInteractions` is empty, stale transcript rows have no actionability;
other independent presentation, including plan implementation confirmation,
continues under its existing priority rules.

Historical timeline projection must not expose selectors or row fields that
materialize transcript payloads as actionable approval or prompt objects.
Timeline-specific parsing may produce display-only card content, while request
identity, options, and response commands come only from canonical pending
Interaction projections.

Turn elapsed-time and work-disclosure presentation reads canonical
`sessionTurns`; transcript message timestamps are not a lifecycle fallback.
Only the Turn identified by the session's canonical `activeTurnId` may tick
locally from `startedAtUnixMs` throughout every non-settled phase. In particular,
an active Turn awaiting an approval, question, or plan response remains the same
Turn and continues displaying its wall-clock "processed" duration while
`waiting`; the wait is included when timing resumes and in the final total.
Once the Turn settles, `activeTurnId` clears and its duration freezes at
`settledAtUnixMs`, so time spent waiting for the user's next ordinary prompt is
not added to the completed Turn. That second-level state stays inside the
duration label so transcript rows do not re-render on every tick. A successfully
completed Turn may start with tool calls, thinking, progress, and file summaries
collapsed when the projection has a distinct final assistant text target
independent of copy availability. Work classification is an explicit allowlist:
thinking, tool groups, specific progress or turn-boundary messages, transient
processing, and file summaries may collapse. Ordinary assistant content and
every user message remain visible, including earlier assistant replies and
mid-Turn user guidance before a later final answer. The disclosure model
partitions that Turn in source order rather than globally separating user and
agent rows: only the initial contiguous user prompt stays above the duration
header, while the remaining visible and work segments retain their authoritative
chronology. Split presentation rows keep their canonical row identity and use
separate render keys.

Turn disclosure is a capability branch, not a transcript-wide container
replacement. Only a Turn with valid canonical timing enters the Turn-level
layout container, which owns its internal row spacing while the outer timeline
owns inter-Turn spacing. A group without canonical timing renders through the
legacy flat-row path, preserving direct-row DOM adjacency, CSS selectors, and
virtualized spacing. Failed, canceled, interrupted, visible-error,
generated-image, or final-text-free Turns fail open so important output is
never hidden. Manual disclosure state is UI-local, keyed by session and Turn,
and may survive conversation switches while the Agent panel remains mounted;
it is not persisted or written back to the engine.

Disclosure spacing that appears or disappears must live inside the measured
reveal height. Do not place a conditionally mounted reveal directly in a parent
`gap`: removing the zero-height node also removes an unanimated gap and creates
a terminal height jump. A reveal that has settled to `height: auto` must keep
tracking content resizes and lock its current rendered height before collapse,
so streaming or asynchronously rendered work cannot collapse from a stale
measurement. In virtualized transcripts, the virtualizer is the sole scroll
anchor owner; opt its measured subtree out of browser-native scroll anchoring
to avoid two independent corrections moving the whole timeline and then
snapping it back.

Generic processing fallback is decided only after transcript normalization has
removed diagnostic-only notices and merged presentation rows. Canonical live
Turn timing suppresses that fallback only when a surviving row with the exact
`activeTurnId` can host the duration header; otherwise projection appends a
processing row scoped to that active Turn. Rows from an older Turn must not
suppress the current fallback. When canonical active-Turn identity is absent,
the generic processing compatibility path retains the latest transcript Turn
only as row placement and suppression identity. It must not use transcript
timestamps or messages to infer lifecycle or enable elapsed-time disclosure.

Ordinary consecutive tool calls project into one stable transcript disclosure
starting with the first call. Working, waiting, completed, and failed updates
change the calls and accumulated count inside that disclosure; they must not
split, finalize, replace, expand, or collapse it. The disclosure identity is
scoped by session, turn, and first call so incremental calls preserve the same
UI state without leaking it across conversations. It starts collapsed, and
only an explicit user toggle changes whether it is expanded. The group header
reports the accumulated call count without claiming a lifecycle state; each
call row owns its working, completed, or failed presentation. Interactive
approval, question, plan-mode, task, and delegated-agent surfaces remain
independent boundaries rather than ordinary grouped tool calls.

Protocol-v2 host adapters must require `activeTurnId`,
`latestTurnInteractions`, and `pendingInteractions`. Missing fields are a
contract error at the desktop boundary, not an empty-list/default-value case.
The engine and GUI consume these fields without `?? []` compatibility reads.

The engine identity is explicit. A consumer resolves the injected engine for
its workspace and runtime origin; module-global runtime slots and hidden origin
registries are forbidden.
`agentDockLayout` remains in the daemon desktop-preferences wire contract for
older stored values, but the desktop host pins it to `unified`. Unified is the
only Agent dock presentation: it exposes one Agent dock entry, and every
AgentGUI launch result and persisted Workbench node uses
`agent-gui:unified` as its stable `dockEntryId`. Launches still create
multi-instance AgentGUI nodes, but `instanceId` is an opaque Workbench lifecycle
token (`agent-gui:instance:<nonce>`). It must never encode or be parsed for a
provider, target, session, or surface kind. `agentTargetId` is the canonical
node selection and launch identity; provider is execution metadata resolved
from that target or from the durable session. The unified entry may choose a
default ready target for its launch payload, but that selection must not
synthesize a provider or replace the target recorded on the node/session.
Legacy persisted Dock identities are normalized, and AgentGUI cache nodes with
no currently valid `agentTargetId` are removed, by daemon snapshot migrations
instead of renderer-side fallback matching.
Workspace Launchpad is a broad launcher surface, not a mirror of the dock
entry list; it should show one generic Agent tile that resolves to the default
or first ready provider instead of duplicating provider-specific Agent dock
entries.
Agent launches from Launchpad/All must still use the unified Agent dock entry
identity (`agent-gui:unified`) so the resulting AgentGUI node appears under the
same Dock icon as direct Dock launches.
The unified dock identity is a reserved aggregate identifier, not a provider
identifier. Neither Dock identity nor instance identity is a provider parser
surface. Provider-specific dock status must never override the unified entry's
visibility; an aggregate status, if needed, must be modeled explicitly instead
of synthesizing an `unified` provider.
Empty launches from the unified Agent dock entry should set dock-entry reuse so
the second dock click restores/focuses the existing AgentGUI node; draft
prefill launches always create a fresh opaque node, while explicit session
launches may reuse only a node whose current state names that exact session.
Agent target identity must not select a workbench instance: targets describe
node content, not canvas-container identity. These mutually exclusive reuse
rules keep generated drafts and session navigation from overwriting an
unrelated window.
The Dock popup's New window card is a distinct launch source and must bypass
dock-entry reuse for AgentGUI, otherwise it collapses into the normal
restore/focus behavior instead of opening a fresh Agent window.
Unified dock and launchpad chrome should keep the generic Agent title and
generic Agent artwork instead of provider-branded entries. Workbench Agent node
headers and standalone native Agent window headers both show the generic Agent
title while the conversation rail is expanded. When the
conversation rail is collapsed, the title area shows the active conversation's
agent icon and conversation title as soon as a local session id exists. The
engine-owned optimistic title bridges conversation-title persistence; the
localized untitled label, then the Agent directory name, are presentation-only
fallbacks and must never override an available conversation title. An empty
new-conversation home does not show this header identity. The standalone
window keeps engine subscription, identity projection, and header rendering in
its header vertical module rather than growing the window shell. The conversation
title remains the detail title while the rail is expanded and the identity used
by Dock previews; after submission, the expanded detail title area shows the
agent icon immediately even before conversation-title persistence. During that
gap, the pending activation record in `AgentSessionEngine` owns one optimistic
title projected from the submitted visible prompt; the rail and every header
read that same record. Optimistic projection and daemon persistence use the same
whitespace and Markdown-link-label normalization so engine reconciliation does
not visibly rewrite valid rich-prompt titles. In header and conversation-rail
titles, Agent handoff/session, Agent-target, and workspace-app mentions render
as normalized `@label` text without a second mention glyph; the active Agent's
identity icon remains separate, while task and file references may keep their
compact title markers. The localized untitled label is
used only when this projection is unavailable, while canonical `session.title`
remains empty until the daemon establishes it and then takes precedence. Runtime
owns the initial-title-established bit and persists it in private runtime
context; service submit paths consult that canonical runtime state instead of
inferring eligibility from transcript availability. Explicit rename/clear and
the first accepted initial-title compare-and-set establish the bit. Sessions
without the marker fail closed on resume so a later prompt cannot retitle a
legacy conversation. Confirming activation means the session exists; it does
not prove submitted initial content has reached the canonical turn index. Engine
consumer status therefore bridges a new activation to `working` only when that
activation submitted initial content, then derives status from its first
canonical turn. Empty new sessions become `idle` after confirmation. GUI
projections must not patch this confirmation gap locally.
Accepted submit intents are optimistic correlation records, not an independent
busy source after canonical turn ownership moves on. Composer send/loading
projections may treat an accepted submit as unconfirmed only while its accepted
turn is still the session's active turn; a settled, cleared, or superseded
active turn must let canonical session and turn lifecycle unlock the composer
even if the pending intent record is waiting for later cleanup.

AgentGuiNode may expose agent selection in multiple UI-local entry points,
including the conversation rail agent grid and the agent select next to the
composer add/reference control.
The composer agent select is a launch/default selection surface: it must
flow through the controller's home-composer agent-target selection action,
resolve an `AgentGUIAgent` by `agentTargetId`, return the node to the home composer when
switching targets, and preserve the real provider identity used by runtime
create/send commands. Once a session is active, the composer agent select is
display-only and must not switch the running session. The conversation rail
agent grid is a navigation surface: clicking an agent scopes the visible rail
list by its exact `agentTargetId`. If the active conversation belongs to that
target, it remains active. Otherwise the click restores the last conversation
that this AgentGUI node or standalone Agent window activated for that exact
target. This memory is keyed by `agentTargetId` in node-local state; it must not
come from a workspace-global recent conversation or group targets by provider.
If no remembered conversation exists, or canonical state proves that the
remembered session was deleted or belongs to another target, the click enters
that agent's empty home composer. A remembered bounded-history session may be
activated before its rail row is loaded, then reconciled through the normal
session-authoritative detail path.
The provider rail tab selection indicator has exactly one owner:
`conversationFilter`. `All` is selected only for the `all` scope, and an Agent
tile is selected only when the filter's `agentTargetId` exactly matches that
tile's trimmed canonical `agentTargetId`. Availability, `disabled`, the home
composer's `selectedAgentTarget`, and active or historical conversation detail
must not override that selection. They continue to own readiness, send/create
gates, unavailable detail, and historical presentation independently. Rail
scope actions fail closed when a compatibility target lacks a canonical
`agentTargetId`; `targetId` and provider identity are not rail selection
fallbacks.
Empty-home rail clicks may also sync the home composer launch target.
The conversation rail keeps one in-memory view scope for each exact target and
the all-target view. Returning to a visited scope restores its scroll offset,
collapsed project sections, and per-section visible item limits only after the
query controller confirms that the rendered memberships belong to that exact
scope. The rendered request scope is synchronous view intent, while the query
controller snapshot supplies resolved-scope evidence. Readiness must compare
those identities during render instead of waiting for passive controller
configuration; otherwise a layout effect can restore and record the new
scope's scroll position against the previous scope's DOM. A committed stale
membership snapshot for the resolved scope is ready for restoration while its
background revalidation is pending; only an initial load with no committed
membership blocks restoration. Search is a transient
navigation mode: each changed query starts at the top and exiting search
restores the underlying target scope without retaining one permanent view-state
entry per query string.
Scope restoration takes precedence over active-session reveal. A first visit
may reveal its active session, but `activeConversationId` is selection truth,
not an implicit DOM scroll command. Rail row clicks and provider session
restoration never scroll again; the clicked row is already visible and the
restored provider owns its remembered offset. Only explicit reveal intents,
currently external session opens and newly created sessions, may reveal a row
in an already settled scope. These view scopes and reveal intents belong to the
mounted AgentGUI node's React conversation-list
module. They are not persisted node data, engine state, query-controller data,
or a module-global store.
In an active session, the composer footer may replace the display-only provider
select with a handoff affordance. Handoff is a workbench launch, not an
in-session provider switch: AgentGUI serializes the active session as a single
`agent-session` mention in a draft prompt, passes the selected provider target
through the host launch callback, and the desktop workbench opens a new empty
composer for that target via the existing draft prefill activation path. The
mention's visible label must use the source conversation title without
prefixing the source agent or provider name, because the submitted draft also
becomes the new conversation's initial title. Source agent identity stays in
the mention metadata instead of being duplicated into title text. Composer and
transcript session mentions use the concrete source Agent icon. New mentions
persist the source `agentTargetId` in their URI, and readonly transcript
presentation resolves the icon from the current Agent directory without
serializing the icon URL. A pasted local session mention may derive that icon
from its `local:<provider>` Agent Target id; a non-local target that is not
resolvable in the Agent directory keeps the generic session glyph rather than
guessing another Agent.
The `agent-session` navigation path is session-authoritative: clicking a mention
resolves the canonical session by workspace and session ID, then launches with
that session's provider and Agent Target. It must not inherit the current
AgentGUI node's target or derive a provider from the unified dock identity. The
prefill activation provider is authoritative for the new workbench panel's
initial provider chrome, so choosing Codex from a Claude Code session must open
a Codex panel before the draft prefill effect runs. The prefilled handoff panel
must also scope the conversation rail to the selected target instead of opening
on `All`; the target-specific rail selection is part of the handoff activation
state, not a later user filter choice.
External draft-prefill launchers that start separate work, such as Issue
Manager task execution and task breakdown, must request a new AgentGUI window
and must not reuse an existing dock-entry node. Reusing the dock entry can focus
or restore the previous active conversation before the new draft composer is
visible.
Every renderer shell that exposes one of those launchers must register the
workspace-scoped AgentGUI launch coordinator locally. The OS workspace handler
launches a workbench node. The standalone Agent handler opens draft-prefill and
explicit new-window requests in another native Agent window, carrying the
target, provider, draft, auto-submit flag, and user-project path through the
typed window intent. The standalone route injects that immutable launch draft
as the AgentGUI body's first-render prefill bootstrap request; it must not depend
on a mount effect to copy and clear a synthetic workbench activation. An
existing-session request without a new-window flag activates that session in the
current standalone window. That activation clears the previous
`agentTargetId` when the request omits a target, so session-authoritative
navigation cannot inherit an unrelated managed-agent rail constraint.
Workspace App external bridges and App Center actions use the same coordinator
instead of maintaining a second Agent launch path. When the standalone shell
also embeds Issue Manager, it registers the workspace-scoped Issue Manager
launch coordinator locally and translates issue links into the standard
`open-workspace-issue` activation for its Tasks sidebar.
The handoff menu is a launch surface, so its options must come from ready entries
in the host-provided handoff Agent directory. `AgentGUI.handoffAgentDirectory`
is independent from the runtime-owned `agentDirectory`: a host that separates
local and shared session runtimes can keep the current rail bound to one runtime
while offering both runtimes as launch targets. Omitting the handoff directory
uses the runtime directory, preserving the single-runtime host contract. The
handoff catalog must not change rail contents, session queries, or empty-home
provider selection, and it must not synthesize a provider catalog or infer
runnable agents from provider metadata. Handoff row presentation keeps the
directory-owned Agent name unchanged and renders ownership as separate metadata:
the host projects authoritative `ownership: "self" | "shared"` from its Agent
directory or launch reference. Owner name, avatar, badge, and other presentation
fields must never determine ownership. Targets without explicit ownership remain
unclassified. Shared targets expose the available owner identity without
mutating launch identity or display names, so duplicate Agent names remain
distinguishable.
When provider selection happens from the empty-home composer or title control
while the rail is already scoped to a provider target in multi-provider scope,
it must update the rail conversation filter to the matching agent target so the
left rail selection follows the active empty composer target. When the rail is
in `All`, provider selection changes only the empty composer target and keeps
the aggregate rail selection intact.
Provider selection from either the empty-home title control or the composer
footer should also request focus for the composer input, matching provider rail
target clicks so users can continue typing immediately after switching agents.
The empty composer chrome and settings defaults must follow the selected agent
immediately, including host-provided name/artwork, model options,
and permission modes. Generic home composer overrides are single-target draft
state and must be cleared when the selected agent changes; provider-
or target-scoped defaults may still provide the next settings.
Provider permission tiers and provider workflow modes are separate contracts.
A provider's read-only tier must map to its actual non-writing execution mode,
not to a planning workflow that can advance into implementation. For Cursor,
the durable `read-only` tier maps to ACP `ask`, while the independent
`planMode` flag maps to ACP `plan`; leaving plan mode restores the runtime mode
derived from the durable permission tier. OpenCode keeps ACP `build` and `plan`
exclusively as workflow modes controlled by `planMode`. Its `read-only`, `ask`,
and `full-access` permission tiers resolve OpenCode ACP permission requests and
must never call `session/set_mode`. OpenCode's plan agent must retain its edit
denial even when the independent permission tier is `full-access`; one-shot
approval choices keep a later live switch to `read-only` enforceable. For
OpenCode processes launched by AgentGUI, the selected tier is authoritative:
the adapter merges unrelated `OPENCODE_CONFIG_CONTENT` fields but replaces its
permission policy and neutralizes `OPENCODE_PERMISSION` so external overrides
cannot collapse the permission/workflow boundary.
Host feature switches that disable an agent for new conversations should keep
the entry present with a non-ready `availability.status` when another surface
still needs to show it. Filter the entry out only for surfaces that should
completely hide it. All empty-home new-conversation affordances must read the
selected agent's availability so coming-soon entries remain inspectable but
cannot start sessions. Hosts may use `renderAgentUnavailableState` and
`renderAgentReadinessState` for product-specific presentation, with actions
routed through `onAgentAvailabilityAction`.
Agent-target mention directories follow the same discoverability rule. A host
may keep an unavailable shared target in the injected mention provider so room
membership and ownership grouping remain visible, but it must project the
non-ready status explicitly. The mention palette renders that target as
unavailable and excludes it from pointer and keyboard selection until it is
ready; absence from the mention directory is reserved for targets that are no
longer shared or otherwise intentionally hidden.
`disabled` is interaction state, not an availability classification. A disabled
target is coming soon only when its explicit availability is `coming_soon` (or
the host's explicit coming-soon catalog says so); unavailable, not-installed,
auth-required, and checking targets retain their own readiness state.
Daemon-managed extension targets use this same host-projected availability.
Their signed target name, icon URL, and open provider identity flow through the
host `agents` array; AgentGUI must not add extension keys, provider fallbacks,
or extension-specific artwork. A missing compatible local runtime projects as
`not-installed`, while historical sessions keep their recorded target and
remain outside the empty-home readiness gate.
When an empty composer has an `agentTargetId`, model, permission, reasoning,
and speed options are target-scoped. Do not fall back to provider-level options
for that target; a missing target-scoped option snapshot should remain a
loading/missing state until the target options arrive.

Target composer defaults have one durable owner and one mutation path:

```text
explicit rendered-menu selection
  -> optimistic home draft or active Session command
  -> preferences.agent.composer.defaults.patch.requested
  -> tuttid validates the Agent Target descriptor
  -> transaction reads latest agent_composer_defaults_by_agent_target_json
  -> merge only model / permissionModeId / reasoningEffort / speed
  -> preferences.agent.composer.defaults.changed(agentTargetId)
  -> clients invalidate and reload target-scoped composer options
```

The renderer must not merge this patch into a cached `DesktopPreferences` or
publish `preferences.desktop.update.requested`. The full preferences mutation
keeps the legacy defaults fields readable for migration and old clients, but it
does not write target defaults. The changed event carries only
`agentTargetId`; it is a reread signal, not a defaults snapshot, so duplicate or
out-of-order invalidations are harmless.

An Agent Extension model catalog can be workspace/cwd scoped even though the
target-default patch intentionally is not. After target-scoped composer options
observe a live catalog, tuttid records that authoritative catalog under the
exact provider and `agentTargetId`. Extension model patches validate against
the last-known-good union observed for that target across caller scopes.
Workspace/cwd display cache entries may expire, but target validation evidence
remains until explicit provider invalidation; catalogs from another target
never qualify. Do not attach the last renderer cwd to the patch: two windows
can use the same target in different projects. Create Session still revalidates
the remembered model against the actual workspace/cwd descriptor before
starting a visible runtime.

`composer-options` owns capability lists and `effectiveSettings`. For a new
home composer, those effective settings are the authoritative target defaults.
The local target draft is only a sparse optimistic overlay for values the user
explicitly selected. Workbench/node `composerOverrides` and desktop preference
snapshots must not inject or reconstruct durable defaults. Before the first
target options response, controls remain in their loading/unknown state.

The same optimistic rule covers `model`, `permissionModeId`,
`reasoningEffort`, and `speed` as one field set. A choice from the currently
rendered menu stays above a stale options response and unrelated settings
patches until authoritative state catches up. Options refresh may update
capabilities and effective values, but it must not sanitize a just-selected
value out of the local intent or persistence patch. Controlled selects may emit
a transient empty value while closing or restoring focus; that is presentation
state and is ignored for every persisted field. Final target/value validation
belongs to tuttid.

The mutation result correlates acknowledgement to the exact target, field, and
local generation. A coordinator may settle an older request as superseded, but
AgentGUI must not interpret that settlement as a daemon acknowledgement. On an
exact acknowledgement, AgentGUI records the generation as awaiting authority,
force-reloads target composer options without that generation's fields as
request overrides, and removes only the still-current generation after a
successful authoritative read. A newer choice for the same field therefore
survives an older acknowledgement, including an A-to-B-to-A sequence. A failed
mutation keeps the optimistic intent; a failed reload keeps the exact
acknowledged generation pending so any later successful target-authority read
can converge it. The target-only invalidation event has no mutation correlation
and must never clear an unacknowledged intent by itself.

Create Session sends only sparse explicit overrides. `Service.Create` reads the
latest defaults for the exact `agentTargetId`, fills fields without explicit
overrides, and then validates the final merged settings against that target's
descriptor. Agent Extension targets use the same rule; an invisible discovery
runtime may resolve a target-owned catalog, but unsupported settings must be
rejected before the visible Session runtime starts. This makes Dock, standalone
Agent windows, CLI, App Center, and other daemon callers share the same create
semantics without a renderer cache or provider-keyed fallback.

An explicit selection in an active Session has two independent effects: the
`AgentSessionEngine` updates current Session settings, and the target-defaults
patch remembers the value for future Sessions. Neither command rolls back the
other. A current-Session failure silently restores canonical Session settings
and is logged; a defaults failure keeps current behavior, retries with the
latest per-field intent, and produces only safe diagnostics. A provider may
return `settings_require_new_session` while the future-default patch succeeds.
Opening or restoring history only reads that Session's persisted settings and
never promotes them to defaults. Existing Full access confirmation remains the
gate before either explicit command is emitted.
Providers whose model catalog exists only after runtime session bootstrap must
declare hidden live-model probing and its cache scope in their provider
descriptor. The daemon may
start an invisible, no-prompt discovery session, cache the advertised catalog,
and clean up that session after discovery so a first-time empty composer can
choose a non-default model before creating a visible conversation. When visible
conversation creation settles, AgentGUI must force one target-scoped options
refresh: an earlier selected-model-only bootstrap response must not stay
valid merely because its request signature matches. This refresh goes through
`AgentActivityRuntime`; AgentGUI must not recover the catalog by reading private
session runtime context.
When a model catalog advertises model-specific reasoning profiles, the composer
must derive the reasoning options from the currently presented model and
re-resolve an unsupported prior effort to that model's advertised default.
Do not render the provider-level reasoning list when a profile exists for the
selected model. The presence of any non-empty model profile keeps the reasoning
dimension available across model switches even when the initially selected
model has no options. An advertised empty profile for the selected model is
authoritative: hide the reasoning control and do not reinsert a stale selected
or draft effort as a synthetic option.
Reasoning values are an extensible provider vocabulary. Known shared values may
use AgentGUI's canonical labels, while unrecognized values must preserve the
localized option label supplied by the composer-options contract instead of
rendering the raw protocol value or adding provider/model branches in the UI.
If restored node data has a stale `provider` that disagrees with a resolvable
`agentTargetId`, the target's provider wins for empty-composer settings and
launch preparation.
UI affordances that aggregate across providers, such as rail provider filters
and composer provider switching, are always part of the unified AgentGUI
surface and do not belong to durable AgentGUI node data.
Provider rail containers, tiles, and management dialogs are interactive
workbench chrome: they must explicitly release host/window drag regions with `nodrag` and
`-webkit-app-region: no-drag`, otherwise clicks near the window edge can be
captured as drag gestures before AgentGUI sees the provider filter action.
Agent rail ordering and visibility are also UI-local chrome state. Drag sorting
and the rail management dialog persist one device-local order and hidden-target
set in browser-local storage; they must not write those preferences into
controller state, session state, or durable AgentGUI node data. The management
dialog changes only presentation and never installs, removes, enables, or
disables a real agent target. The provider rail and empty-home new-conversation
carousel and agent selector consume the same ordered visible-target projection,
so manager changes update all new-conversation affordances immediately. If the
selected empty-home target becomes hidden, the home composer moves to the first
remaining visible target; active sessions keep their recorded target identity.
Targets with a canonical `working` or `waiting` conversation cannot be hidden;
the manager blocks the remove action and immediately shows a deduplicated,
localized explanation when the target enters the hidden drop zone, without
writing the local preference. Hiding the selected rail target otherwise returns
the rail filter to `All`. The manager
presents available and hidden targets as separate icon grids. A long press
enters a local edit mode for removal. Both grids are drop zones: same-grid drops
reorder, and cross-grid drops atomically change local visibility and order. The
pending drop position mirrors the provider rail by shifting the target tile
aside and showing the same brand-color insertion line; the previewed
before/after position is also the position committed on drop. At least one
target must remain available, so both the remove action and an
available-to-hidden drop enforce that invariant. These gestures still update
only the same local chrome preference. The manager keeps each target tile's
outer hit box layout-stable, shifts only its inner visual content, and renders a
separate insertion-line element. Cross-grid midpoint decisions use hysteresis
so a stationary pointer cannot make the target and insertion line oscillate.
Starting a drag must not exit edit mode: the manager pauses the edit wiggle only
while a drag is active, then resumes it after same-grid reorder or cross-grid
visibility changes. Blank-space clicks, Escape, and closing the dialog remain
the explicit edit-mode exit paths.
While edit mode is active, the first Escape leaves edit mode without dismissing
the manager; a second Escape closes the dialog. Both grids use the same compact
five-column icon layout.
Visibility controls stay hidden in the default state; entering edit mode shows
red remove controls for available targets and green restore controls for hidden
targets together. The aggregate `All` entry stays fixed above agents and cannot
be hidden or reordered.
Provider-scoped rail footer affordances, such as usage limits and environment
setup, follow the rail's active provider filter target in multi-provider scope;
when the rail filter is `All`, they should stay hidden because there is no
single provider target to inspect.
Runtime session usage is normalized once at the activity-core boundary,
including quota type and numeric/text fields. AgentGUI read hooks may memoize
that canonical projection, but views consume the typed quota array directly;
they must not rebuild or stabilize quota DTOs with render-time refs.
AgentGuiNode may also receive a neutral `renderSidebarFooter` slot for host or
product affordances that belong at the bottom of the far-left provider/sidebar
rail, below the system-settings control and not below the conversation-list
configuration footer. This slot must stay outside the provider tile scroll area
so the footer keeps a fixed bottom placeholder while overflowing provider tiles
scroll above it with a bottom fade. It must also stay outside the controller
view model and conversation rail query/controller state: pass it as a direct function
prop and give it only existing neutral context such as `currentUserId` and
`activeConversation`. Product concepts such as sharing, ownership,
availability, quota, or authorization live entirely inside the React node
supplied by the host.
Standalone Agent windows keep right-side tools as UI-local panel tabs. The
window chrome exposes one right-panel toggle plus quick actions for apps and
messages while the panel is closed; each quick action exposes its localized
tooltip, opens the right panel, and mounts/selects the corresponding tab. Once
open, the panel header owns the
active tab strip and its add menu for files, terminal, browser, tasks, apps,
and messages. If the panel opens without any mounted child tab, its body first
shows a compact picker for Files, Terminal, Browser, Tasks, Apps, and Messages;
selecting one of those entries creates and activates the corresponding tool tab. The empty picker is
not itself a tool tab, and the closed-panel quick actions stay hidden while it
is visible. Its default width is 60% of the Files panel default; selecting an
entry replaces that compact width with the chosen tool's normal panel width.
While the picker is visible, its sole header toggle remains right-anchored to
the same window edge as the collapsed sidebar control, so opening the empty
panel does not make the icon jump horizontally.
Opening a tool mounts it as a tab and selecting another tab only changes the
visible projection; this state is not durable AgentGUI session data.
The Files tool tab remains the file-navigation surface. Double-clicking a file
from a standalone Agent window delegates to the desktop host's system-default
file opener, matching Finder double-click behavior instead of mounting a second
preview implementation in the tool tabs. Directories continue to navigate
inside the Files tool. Its Open With submenu likewise omits Tutti's internal
file-viewer and in-app-browser actions while keeping system applications,
default-browser handling, and the system application picker. The regular
workspace window keeps its existing workbench file-preview contribution and
the full Open With menu.
Unified empty-home readiness is a host-projected, agent-scoped gate,
not a durable session rule. Desktop may subscribe to its
`agentProviderStatusService`, merge runtime status into `/agents` availability,
and pass install, login, or refresh callbacks into AgentGUI. AgentGUI resolves
the selected entry by exact `agentTargetId`; provider may supply runtime status
metadata but never selection fallback. A non-ready agent replaces only the
empty-home composer with a friendly gate; active/history conversations and
existing-session composer behavior remain outside this gate.
When the desktop status list returns an ambiguous startup result for a provider
whose runtime command is more authoritative than its lightweight status check
(for example Cursor), the desktop status service may run a provider-specific
runtime probe and fold a ready result back into the provider status snapshot
before projecting the empty-home readiness gate.
Startup provider detection should be progressive: desktop may publish the first
ready managed provider as soon as it is confirmed, then continue detecting the
remaining providers in the background. When the empty-home rail is still on
`All`, no user-selected composer target exists, and the current default target
is still gated, AgentGUI may move the home composer to that first ready target
so the user can start typing without waiting for every provider to finish
detection.
If the standalone route already identifies a required provider or target, its
provider-scoped status request is the foreground request. It must not wait for
an unrelated all-provider scan, and a later targeted request may run alongside
an older catalog scan. Merge concurrent responses by provider and reject stale
per-provider results so an older full response cannot regress newer readiness.
The remaining provider catalog continues as background work after the required
provider resolves.
Progressive detection snapshots are partial by design. A provider missing from
the current snapshot means "not checked yet", not "install or login required".
Desktop AgentGUI hosts that project managed-agent readiness for an already-open
provider panel must wait until that provider appears in the status snapshot
before replacing the composer with setup UI or disabling active-session sends.
Auth-required local providers should remain selectable; product surfaces may
label the setup affordance as `Connect`, but the host action should still
dispatch the provider's `login` operation when that is the daemon-reported
action.

Declarative Agent Extension setup is owned by the exact selected Target. One
Target-scoped controller owns its host watch, snapshot, dialog state, pending
action, auth selection, and failure notification; the empty-home gate and
config menu consume that controller instead of opening parallel polls. Target
changes reset transient UI state. On empty home, the visible-target projection
resolves the effective selected Target once; composer UI and setup controller
consume that same exact Target, including hidden-selected fallback. Desktop
explicitly projects generated daemon setup snapshots into the minimal Host UI
shape and drops workspace and action timestamp transport metadata. The Dialog
remains mounted through controlled close/ready transitions so document locks
are released correctly.

A ready setup dialog renders the normalized signed-in account and an explicit
re-authentication action. The auth-method selector appears only while
authentication is required; re-authentication reuses the account's method when
that method is still advertised by the runtime.

Setup gates only the empty new-conversation surface. It never replaces active
or historical conversations, never opens merely because Target selection
changed, and never branches on provider name. The daemon-authored plan,
install/auth lifecycle, persistence, trust checks, account projection, and ACP
auth invalidation rules are defined once in
[Agent Extensions](./agent-extensions.md#target-managed-runtime-setup).

UI-local state may include draft text, selected panel, rail layout, open menus,
scroll position, and temporary presentation focus. UI-local state must not own
session lifecycle, turn lifecycle, queue delivery, or durable workflow status.

## Agent GUI Module Shape

Conversation rail "open in new window" actions are internal workbench-window
launches, not Electron `BrowserWindow` launches. The action should stay inside
the current Tutti workspace surface: `DesktopAgentGUIWorkbenchBody` calls
`requestWorkspaceAgentGuiLaunch`, the workspace launch handler calls
`host.launchNode`, and AgentGUI opens the requested session through an
`agent-gui:open-session` activation. Normal session launches may reuse an
already-open node only when workbench node state says that node is currently
showing the requested session. An instance id from older snapshots is only a
legacy window identity hint, not proof of the node's current session or target.
If no current-session match exists, the launch creates a fresh opaque AgentGUI
container, writes the requested target into that node's state, and then
activates the durable session. AgentGUI must not maintain a parallel
target-to-instance index because multiple sessions for the same target are
valid and the Workbench host already owns live canvas-node lookup. The
explicit new-window action must pass `openInNewWindow` so the descriptor creates
a fresh opaque AgentGUI instance while still activating the same durable
session.
The detached Agent button in desktop chrome is a different window boundary: it
asks main to create an Electron `BrowserWindow` with the `view=agent` renderer
intent. That window is Agent-only, but it is not a separate app bundle or a
separate data owner. It reuses the workspace renderer services, preload host
capabilities, `tuttid` client, `WorkspaceAgentActivityService`, account state,
provider status, and project/file services for the same `workspaceId`.
The standalone Agent header reuses that button to duplicate its current native
window. It hands off the active session, agent target, provider, agents, and
provider-status snapshot, and explicitly keeps the source standalone window
visible. The duplicate reconstructs UI from the shared durable activity source;
it must not clone or fork AgentGUI session state in the renderer. Place the
duplicate 25 pixels to the right and 25 pixels below its source, clamped to the
active display work area, so the new window does not completely cover the
source window when the available work area permits.
When the conversation rail collapses, the standalone Agent header remains a
full-width window control surface and keeps its secondary tool actions anchored
to the right window edge. Content-width caps belong to the conversation body,
not to the header control row.
Standalone Agent windows mount the shared desktop AgentGUI surface through a
standalone adapter. They must not fabricate a Workbench node/context or mirror
Workbench runtime and snapshot setters. Their minimal window state is UI-local;
durable conversations, session activation, login, provider readiness, and
file/project data still flow through the shared desktop AgentGUI host input and
activity runtime.
Standalone-window tools are desktop host chrome, not AgentGUI state.
The desktop host owns tool identity, toolbar buttons and reminder badges,
Browser/Terminal grouping, panel placement, lazy mounting, and tool content
adapters. Browser, Files, Apps, and Message Center use the right sidebar; the
standalone Browser statically owns a desktop element-context module alongside
its panel adapter. That module runs a bounded selector inside only the
active BrowserNode webview, strips executable content, form values, and
secret-looking attributes or URL parameters, then archives the structured DOM
snapshot as a local prompt asset. The host sends a sequenced, host-neutral
composer append request to AgentGUI so the file card is merged into the current
home or session draft without replacing existing text, changing conversation,
or submitting. Workspace/OS Browser nodes do not load or expose this module.
The Terminal opens as a bottom tray below the conversation, matching the Codex
layout and preserving enough height for a usable shell. File panels start wide
enough for their embedded location, list, and detail columns. Browser and Apps
share the same roomy default width so switching between them does not move the
panel boundary. Message Center aligns its default host width with its standard
embedded content width so it neither clips card content nor leaves unused
right-side space. After the user manually resizes any right-sidebar tool, that
latest manual width becomes the shared preferred width for subsequent tool
switches; a Browser opened after Files therefore keeps the user's width instead
of restoring Browser's default. Browser and Terminal share one dropdown trigger
in the header:
the entire tool control opens the menu, and choosing an item opens that tool.
Do not split the control into a primary action and a separate menu-arrow action.
The standalone
right-sidebar tools form one exclusive selection: opening any one of Browser,
Files, Apps, or Message Center hides the previously active right-sidebar tool,
including any embedded Electron webview. Terminal visibility is orthogonal to
that selection and may coexist with any right-sidebar tool because its tray is
in the separate bottom region. The standalone
Agent renderer route uses `view=agent`, so the desktop preload must expose the
same browser and workspace-app APIs for both `view=workspace` and `view=agent`;
gating those APIs to only the workspace route leaves direct BrowserNode and app
webview panels with no host bridge. The standalone
host owns its outer resize handle and minimum Agent content width, while the
reusable file manager owns its two internal draggable column boundaries; all
resize state remains local to the visible window. It composes that chrome around the existing
`AgentGuiWorkbenchHeader` and `DesktopAgentGUIWorkbenchBody`; it must not add
tool commands, visibility state, or product-specific panel contracts to
AgentGUI runtime, controller, node state, or composer state. Panel state may be
kept mounted while hidden so switching tools does not discard local UI state,
but durable data continues to come from the existing desktop services.
Opening a right-sidebar tool captures the current Agent content width, then
uses the typed host-window width capability to append the panel beside that
content. Main grows the native content bounds toward the right edge of the
active display and shifts the window left only when the right-side work area is
insufficient. The renderer assigns native width added beyond the captured
baseline to the sidebar, so dragging the native right window edge grows the
whole app and the sidebar without reflowing the message flow. The sidebar's
full resolved width must always participate in the flex layout. When the
display cannot provide the preferred native growth, the Agent content narrows
and the sidebar remains adjacent; it must not become an absolutely positioned
overlay above the transcript. Width added from the panel's left separator is
also reserved by layout and does not change the native window bounds. Closing
the panel restores the captured baseline width.
Opening must be renderer-first: update the active panel immediately and defer
the host-window resize request until the next animation frame. Do not await
native IPC before showing the panel. The desktop host may coordinate the native
window and sidebar width transition so opening and closing remain smooth, but
intermediate native resize frames are host chrome and must not enter the shared
AgentGUI surface context. CSS follows the live window bounds; React commits the
final frame from the host's resize-completion event so the conversation subtree
does not rerender on every native resize tick.
When a tool switch resolves to the current native content width, the host-window
resize request must be skipped; a previously clamped native width must also be
treated as settled for the same target so tool switching does not cause a
redundant resize pulse.
Files, Browser, Apps, and other expensive first-use bodies mount after the
sidebar entrance, then remain mounted while hidden for instant later switches.
Respect `prefers-reduced-motion` by removing the native/sidebar transition,
inner entrance, and content-mount delay.
Lazy mounting also applies to module loading. The standalone shell may derive a
small reminder count from the activity engine, but it must not statically import
BrowserNode, TerminalNode, File Manager, App Center, or the full Message Center
presentation graph. Import each tool body when that tool first opens. Workspace
App polling and runtime preparation begin when Apps first opens or an explicit
app launch targets the window, not when the standalone Agent window mounts.
Header tool actions must use the workbench header's secondary accessory slot so
the session title and controls share one layout row. Do not absolutely position
those actions over the title; narrow windows must truncate the title before any
control can overlap it.
Right-sidebar panel chrome starts below the standalone workbench header. Keep
the panel title, expand action, and close action out of the global header row so
they cannot collide with Files, Tools, Apps, or Message Center launch buttons.
The outer right-sidebar container owns the shared panel stacking level for its
separator and panel-local popovers, while the panel body remains a normal
sibling of the message flow rather than relying on stacking to cover it.
Portaled conversation modals, including the image preview, must use the UI
System dialog stacking token above that panel layer so their backdrop covers
both the standalone header and right-side tool chrome. While such a modal is
open, Escape handling belongs at the window capture boundary because focus may
remain in host chrome outside the portaled dialog; remove that listener when the
modal closes or unmounts.
The Files panel uses the same roomy adjacent default width as Browser and Apps,
then keeps its wider resize range for the embedded location, list, and detail
columns. On the minimum native window width, preserving the standalone
header's combined provider/conversation rail boundary takes precedence over the
Files panel's nominal minimum width so host-owned rail controls are never
covered by tool-panel chrome. The panel may narrow below its nominal minimum
on a constrained display, but it remains in the same side-by-side layout.
Every right-side panel exposes a title-bar expand control that temporarily uses
the full width available beside the minimum Agent rail boundary without
changing the native window size. While expanded, the control switches to the
restore glyph and its next activation restores the panel's previous width.
Application updates remain desktop-global `AppUpdateService` state. In the
standalone Agent header, present that state as a compact non-drag control: an
available update downloads, downloading shows progress, and a downloaded update
offers restart-and-install. Do not keep an update-check failure permanently in
the focused Agent header.
Desktop renderer startup is route-split. OS workspace chrome and the standalone
Agent window are separate dynamic entries; neither route may statically import
the other route's body through a feature barrel. Workbench Agent contribution
registration keeps only its lightweight node and dock descriptor on the OS
cold path. The full `DesktopAgentGUIWorkbenchBody`, rich-text editor, mention
search controller, and AgentGUI presentation graph remain outside the common
desktop shell entry. Both the OS workspace route and standalone Agent route
statically own the body inside their already-lazy route chunks. This avoids a
second body-level import waterfall after either route begins rendering while
keeping non-workspace desktop routes outside the AgentGUI graph.
Before `createRoot().render`, the desktop renderer bootstrap dynamically loads
and creates exactly one workspace-window runtime for that Electron renderer
realm. React route components only consume that runtime through props and DI
context; render, Suspense retry, or route-body remount must not construct a
second service graph. The runtime owns one event-stream client and releases its
controllers, subscriptions, DI services, analytics leases, host listeners, and
event-stream transport through one idempotent `dispose()` on window teardown.
Every blocking boundary before the real AgentGUI controller mounts uses that
same startup-shell geometry: the route-level Suspense fallback, workspace
catalog hydration, and workbench host-session binding.
The reusable body geometry is owned by the narrow
`@tutti-os/agent-gui/startup-shell` entry. The primitive is runtime-source
agnostic: local/shared ownership, directory loading, and launch routing remain
host concerns. Desktop owns the optional standalone-window chrome around that
body; another host may compose the same primitive at its own loading boundary
without adding host identity to the AgentGUI presentation package.
The full-window variant keeps the header, provider rail, conversation-rail
skeleton, and empty-home hero composer visible; after the real header mounts,
the body-only variant preserves that new-conversation geometry without
duplicating chrome. The hero placeholder mirrors the real composer's input
shell, control footer, project row, and prompt-tips row so its height does not
jump when AgentGUI takes over. It also preserves the real centered-timeline
wrapper, the multi-agent carousel slot used before target resolution, and the
home-suggestion wrapping geometry; approximating only the inner card causes the
whole hero group to shift when AgentGUI takes over. Startup must not imply that
a conversation is already active by showing the bottom-docked history composer
or a message timeline.
The startup hero composer is visibly present but non-interactive until the real
controller owns draft and send state. Do not introduce a second temporary draft
owner just to make the fallback editable. Optional right-side
tool bodies show a local busy state during their intentional mount delay,
dynamic import, and runtime/session startup instead of exposing an empty panel.
Standalone-only settings, environment, import, and account surfaces are also
non-critical to the conversation first frame. Load their presentation modules
behind local Suspense boundaries; panel-host listeners may mount immediately
after the shell's first animation frame so they remain available before a user
can invoke them without extending the initial black-screen interval.
While that body is still suspended, keep the standalone header's
conversation-rail and right-panel toggles hidden; reveal them only after the
body commits so loading chrome cannot target unavailable content.
Startup optimizations such as mention browse warming must begin from the
mounted AgentGUI lifecycle, never from workspace contribution registration.
Local AgentGUI startup before the body module evaluates is module loading, not
workspace or session hydration. Reserve hydration terminology for injecting or
reconciling runtime state after the relevant controller exists.
File activation in the standalone Agent window must use the host-owned right
Files sidebar. Conversation links and workspace-reference preview requests open
that panel and pass a reveal intent so the reusable file manager selects and
previews the requested path. The standalone route registers this panel command
as its Canvas preview launcher; it must not create a workspace floating preview
above the conversation or send the primary open action directly to the
operating system. Do not show the workspace preview-unsupported notification
for this handled route.
The standalone Message Center must reuse
`WorkspaceAgentMessageCenterPanel` and build its model from that window's
`WorkspaceAgentActivityService` snapshot. Opening it may load bounded session
summaries for its cards; submitting a prompt must use the existing
`submitPlanDecision` service path, and opening a card must activate that
session in the current standalone Agent window rather than creating another
native window. It must use the panel's embedded presentation so the host-owned
title, expand, and close chrome remains visible; the default fixed drawer
presentation remains reserved for workspace overlays.
Its header trigger must reuse the OS Message Center status-pet asset while
`model.counts.working` is positive and show that working count in the top-right
badge; zero working sessions restore the static Message icon and omit the badge.
The workspace-owned activity service starts one canonical reconcile when its
engine is created, before Message Center opens, so a separately created Agent
window immediately reconciles already-running sessions. Panels and sidebars do
not start a second initial load; concurrent explicit loads share one in-flight
result. Outcome notification subscriptions must also start that workspace's
activity event stream. They remain in baseline mode until the first
authoritative workspace reconcile reaches `ready`, seed all historical settled
turn ids without notifying, and only then emit notifications for settled turns
backed by a live `turn_update`. A session-level reconcile can hydrate historical
settled turns after that bounded baseline; first appearance in the engine is not
notification causality. When an event arrives before the session is cached and
requires HTTP reconciliation, preserve the original `state_patch` for
session-event consumers; rebuilding it from session state can discard
`turn.outcome` or `turnId` and suppress the completed/failed foreground toast.
Browser and Terminal tool bodies must mount the existing OS node UI directly:
`BrowserNode` in the right panel and `TerminalNode` in the bottom tray. Do not
nest another `WorkbenchHost` inside the standalone shell; the nested canvas can
collapse during panel animation and report a near-zero terminal viewport even
while its PTY is healthy. The desktop terminal contribution exposes the same
feature and adapter runtime used by the OS workbench, so direct mounting still
retains the normal PTY, output hydration, link handling, close guard, and
termination paths. Agent mode must not create another browser lifecycle,
terminal implementation, or PTY adapter. A lightweight synthetic host record
exposes the directly mounted terminal session to native-window close-effect and
cleanup coordination without owning layout or snapshots. Both surfaces remain
mounted after first use so hiding and reopening a tool preserves its UI-local
session state. The standalone Browser must render `BrowserNode`'s shared header
so back, forward, reload, address entry, external-open, and overflow actions use
the same controller and runtime state as the webview. The Terminal tray's close
control only collapses the tray; it
must not terminate or unmount the active terminal session.

The standalone Agent renderer is not a durable Workbench snapshot writer. Its
`view=agent` composition root may read the workspace snapshot once to seed
product chrome such as wallpaper, but its repository is window-local after
that read: layout, stack, wallpaper, and onboarding saves update only that
window's memory and never call the workspace Workbench PUT endpoint. The OS
workspace renderer remains the single durable snapshot writer for a workspace.
This keeps the synthetic close-coordination host from accidentally becoming a
second layout owner while standalone windows coexist with the main workspace.
Electron main may create one of two native workspace shells. `OS` mode keeps
the existing workspace window and its `ReadyWorkspaceWorkbench`
desktop/window/dock surface, while `Agent` mode creates the frameless Agent
window and loads the explicit `view=agent` route. This is a main-process window
creation decision only: the preference must not enter AgentGUI state, and an
existing native window must not be made to impersonate the other window kind
by swapping renderer content. Desktop persists the selection through the
generic preference flag `workspace.standaloneAgentMode`; absence of that flag
means OS mode, while explicit `true` and `false` values retain the user's Agent
or OS selection respectively.
Settings destinations remain host-local presentation behavior. The standalone
Agent settings control opens the global panel on General, the Agent settings
control embedded in OS mode opens the Agent section, and the OS workspace's
top-right global settings control opens General.
Opening an existing session is session-authoritative. If the launch payload has
no `agentTargetId`, workbench node state must clear any previous target
constraint instead of inheriting it from the reused node. When a
stale target resolves to a different provider than the launched session node,
desktop activation must drop that target before persisting `lastActiveAgentSessionId`;
otherwise the node can open the requested session while the conversation rail
stays scoped to the old provider and cannot select the active row.
The selected-session state must also honor an explicit open-session request
even when that session is outside the currently loaded rail page or section.
Missing from the visible rail is not proof the session is gone. AgentGUI should
project the requested session metadata into a node-local transient rail row and
run the normal cwd/user-project grouping so the selected row remains visible in
the matching project group. This overlay must stay out of canonical pagination
state and be de-duplicated by conversation id when the real paginated row later
arrives; session detail/state load owns true not-found handling.
The selected summary and ordinary rail summaries must use the same
cwd/user-project projection. When both are available, the rail resolves the
selected id from its projected entity list before falling back to the
controller's active summary, then merges that one entity into the displayed
sections by id. This keeps provider-filter changes from moving the selected row
into an unrelated unscoped section.
Once a user selection becomes the active intent, rail pagination or bounded-list
absence must not demote it into requested/resolving fallback. Only an explicit
replacement, home transition, deletion, or authoritative not-found result may
clear that selection.
Restoring `lastActiveAgentSessionId` after a renderer or client restart follows
the same rule: activate that persisted intent, request the engine-owned session
state-and-messages reconcile, and keep its transient rail row outside canonical
pagination until the session arrives or reconcile proves it unavailable.
Selecting any rail row whose detail is not cached must enter the engine-owned
session reconcile lifecycle and request state plus messages as one semantic
load. Detail availability is explicit: `loading`, `ready`, `not_found`, or
`error`. The skeleton follows a blocking reconcile record. A completed message
reconcile establishes engine-owned detail hydration even when it returns zero
messages; later selection and background refresh keep that valid empty detail
`ready` instead of degrading it back to `loading`. Only an authoritative
tombstone/not-found result may show the unavailable state. Once authoritative
not-found wins, presentation must suppress any previously projected transcript
rows instead of mixing stale content with unavailable-state layout. An empty
message projection without the hydration fact is not evidence that loading
finished or that the session is gone.

Agent GUI is organized by vertical behavior rather than one controller with
horizontal helper piles. A vertical module owns its projection, commands,
UI-local state, and focused tests. Typical modules include:

- conversation navigation and session selection
- composer and prompt queue
- transcript and turn presentation
- approval and interactive prompt handling
- provider target selection and readiness presentation
- goal presentation and control
- files, mentions, and turn summaries

The node shell composes modules. It does not orchestrate their workflows.
Controller code may bind selectors and commands, but it must not become a
second state machine or a registry of panel-specific effects. When a controller
grows across multiple behaviors, extract a complete vertical module instead of
moving lines into generic `helpers`, `shared`, or `utils` files.

Business-code files stay at or below the repository line limit. After a
refactor, remove superseded stores, adapters, effects, and compatibility paths;
do not leave two active ownership models.

## Public Node Contract

`AgentGUINodeProps` exposes semantic responsibility objects only:

| Object             | Responsibility                                                    |
| ------------------ | ----------------------------------------------------------------- |
| `identity`         | node, workspace, user, and title identity                         |
| `workspace`        | workspace path, references, project selection, and agent settings |
| `frame`            | position, size, activation, embedding, and preview layout         |
| `state`            | persisted Agent GUI node data                                     |
| `runtimeRequests`  | focus, launch, prefill, and provider probe requests               |
| `hostCapabilities` | host-projected catalogs, readiness, menus, and icons              |
| `hostActions`      | host mutations and workbench/window actions                       |
| `renderSlots`      | narrow host presentation slots                                    |

These groups are required even when a group has no optional values. Do not add
flat compatibility props. Add a field to the object that owns its meaning, or
create a new responsibility object only when it represents a genuinely separate
boundary.

Render slots receive narrow neutral context. Product authorization, transport,
or workflow behavior must not be hidden inside a render slot.

## Provider Architecture

The daemon `providerregistry` is the source of truth for provider identity and
behavior descriptors. A descriptor declares typed strategies and capabilities
for runtime, status/auth, composer behavior, events, sidecars, external import,
desktop integration, and CLI integration.

Cross-provider consumers follow this shape:

```text
provider ID
  -> providerregistry descriptor
  -> typed strategy/capability selector
  -> provider-neutral consumer behavior
```

Consumers must not branch on Codex, Claude Code, Cursor, Hermes, Nexight,
OpenClaw, OpenCode, or Tutti Agent identity to select behavior. Provider-owned
wire adapters may translate their own protocol, but shared policy belongs in a
typed descriptor or selector. Unknown providers produce an explicit unsupported
result; they do not silently inherit another provider's behavior.
Reasoning-option ownership, configured-model override behavior, and native
skill config-directory suffixes are descriptor strategies as well. Composer
and model-catalog services dispatch on those typed strategies; they must not
recover the same policy from provider-name comparisons or path literals.

Generated GUI identity data is presentation metadata only. A provider target
is host-supplied launch authority with a real provider identity and opaque target
reference. Agent GUI displays and selects targets but does not invent runnable
targets when the host catalog is absent.

Standard ACP adapters normalize provider wire events before persistence. A tool
call keeps one stable canonical identity, such as `Bash`, `Edit`, `Read`, or
`TodoWrite`, from start through terminal updates even when the provider changes
its human-readable title to a command, path, or result summary. Provider
envelopes such as `rawInput`, `rawOutput`, and output metadata are projected into
the canonical tool payload consumed by shared renderers. Agent GUI may normalize
historical persisted envelopes for display compatibility, but it must not add
provider-specific rendering branches.

Provider command lifecycle banners, including context compaction, are canonical
`agent_system_notice` messages rather than ordinary assistant text. One stable
message ID carries the lifecycle from `running` to `completed`, `failed`, or
`canceled`, with `noticeCommand` and `noticeCommandStatus` as the presentation
contract. Terminal selection for that stable lifecycle is first-write-wins: an
adapter records an explicit or synthesized terminal state atomically and ignores
late provider terminal updates rather than rewriting an already published
outcome. The canonical message `semantics` field is authoritative; duplicated
payload fields are a compatibility fallback for historical timeline data. Agent
GUI maps the context-compaction lifecycle through one pure presentation resolver:
active compaction becomes `specific-progress`, while terminal compaction notices
become `turn-boundary`. Generic processing and transcript-divider layout consume
those roles instead of matching the provider, command name, or English copy.
Shared command presentation policy does not belong in the provider registry;
provider adapters only normalize their wire events into the canonical contract.
Agent GUI keeps notices outside assistant-text coalescing. It may normalize
historical `source=compact` messages and stable `compaction:` lifecycle records
with exact canonical titles into that contract. Legacy title inference requires
compact identity evidence; arbitrary notices with matching copy remain ordinary
content. Agent GUI removes an immediately following assistant echo only when it
exactly repeats the failed notice detail; distinct provider guidance remains
visible.

Conversation file links use the selected project root when one exists. For a
no-project session, the durable session cwd is the file-resolution root. This
keeps link navigation attached to session identity instead of requiring project
selection state. Every transcript file surface, including markdown links and
turn-summary projection/actions, must pass the selected project root as
`workspaceRoot` and the durable session cwd as `basePath`; do not substitute a
synthetic `/` root or drop the cwd when no project root is selected.

## Desktop Host Boundary

`apps/desktop` owns Electron/workbench integration and concrete host
capabilities:

- workspace window and node lifecycle
- provider status and login actions
- file/reference adapters and project selection
- desktop preferences, notifications, and app icons
- construction and injection of the workspace activity runtime

Desktop passes grouped Agent GUI props and runtime interfaces. It must not
mirror engine entities, implement provider policy switches, or derive session
truth to make a panel render correctly.

Agent GUI engagement reporting follows the same boundary:

- `AgentGUINodeView` owns DOM exposure observation and the UI-local panel visit.
  A visit ends when the panel becomes ineligible or its active session/target
  context changes; events from different session contexts never share a
  `panelVisitId`.
- Composer and rich-text modules report semantic focus and accepted user-content
  signals. Controlled draft hydration, prefill, and programmatic mention-trigger
  insertion are not user-content events.
- Workbench presentation visibility enters through `frame.isVisible`. Reusable
  Agent GUI code must not query desktop workbench class names or data attributes.
- The package emits a discriminated engagement event through
  `hostActions.onEngagementEvent`. Desktop owns product event names, surface
  labels, reporter construction, and analytics transport. Prompt text, file
  names, paths, mention URIs, and attachment payloads never cross this boundary.

Opening a conversation activates a durable session through the engine. Opening
it in another panel creates workbench presentation state around the same durable
session; it does not clone the session. Provider handoff starts a new session
with an explicit target and prompt reference rather than mutating the running
session's provider.

## No Panel Orchestration

Panels and components are presentation boundaries. They may:

- render selector output
- hold ephemeral interaction state
- dispatch typed actions
- report narrow layout or focus events

They may not:

- subscribe directly to daemon event streams
- own timers that advance durable workflows
- coordinate create/activate/send/cancel sequences
- reconcile optimistic and authoritative entity state
- inspect provider identity to select business behavior
- read another panel's internal store to decide workflow state

Multi-step behavior belongs in daemon workflows or engine commands. If a panel
needs several durable mutations, expose one semantic command rather than
sequencing transport calls in React effects.

## Submit And Startup Transactions

Provider readiness is application-scoped daemon state, not a session-create
precondition. `tuttid` caches each provider's resolved CLI/adapter, version, and
auth snapshot independently of status request shape; concurrent reads share one
probe, ordinary reads reuse the completed result, and explicit refresh or a
runtime auth failure invalidates it. Desktop windows mirror that snapshot and
must not force a full provider probe on every focus.

Creating a session performs only request-scoped validation, cwd/runtime
preparation, and the real provider handshake. It must not synchronously run CLI
status, auth-status, version, network, or hidden model-discovery probes first.
For Cursor, account-scoped model discovery may create one hidden ACP session and
preserve its last-known-good catalog, but visible session creation never waits
for that discovery: the visible session's own `session/new` can populate the
same catalog. Process spawn, `initialize`, and `session/new` failures are the
authoritative launch result and invalidate matching cached readiness data.

`clientSubmitId` is the daemon-owned idempotency key, not merely a diagnostic
field. Before invoking a provider, the daemon persists a submit claim scoped by
workspace, session, and client submit ID. A duplicate accepted claim returns
the existing turn; a prepared claim reports delivery as unknown/confirming and
must never invoke the provider again.

Creating a session with initial content is one transaction. Provider startup
may create provisional runtime state, but the Session is not published or
persisted until the first Turn is accepted. Validation or execution failure
rolls the provisional runtime and its pending command/config snapshots back;
it must not leave a turnless Session or a synthetic message without a Turn.

The session engine owns activation deadlines. It passes one cancellation signal
through the desktop command port and HTTP adapter. Adapters must not race the
engine with an independent timeout budget; command timeout, cancellation, and
uncertain-delivery reconciliation are one engine workflow.
Stop is also engine-owned during activation. The provider-neutral
`session/stopRequested` intent aborts the exact in-flight activation command and
keeps a workspace/session-scoped `awaitingTurn` cancel until the first canonical
Turn arrives. That transition then emits an exact `turn/cancel`; a bounded
expiry removes the detached operation so a later, unrelated Turn cannot be
canceled. Empty reconcile snapshots must preserve this detached operation.
An adapter may durably accept that exact-turn cancel before the Turn reaches a
terminal outcome. It returns the official `cancel_requested` result with the
same Turn projected in `settling` phase; the engine keeps cancellation in its
`accepted` operation state and the GUI continues to present stopping until an
authoritative settled Turn clears it. Acceptance must never be rewritten as
`turn_canceled` or `already_settled`, and a transport failure must remain a
failed command rather than manufacturing terminal state.
When request cancellation causes create to fail, daemon rollback uses a bounded
context detached from the canceled request so provisional runtime state is
still closed and removed.
The outer new-session activation deadline must also leave room for process spawn
and `initialize` before ACP `session/new` starts its own full 30-second timeout;
an activation timer that starts at the user's click must not cancel
`session/new` with only the leftover portion of that budget.

## Validation

Use focused tests while iterating, then the repository checks for the changed
surface. Command flow returns through the same runtime interface:

```text
controller action
  -> AgentActivityRuntime command
  -> WorkspaceAgentActivityService
  -> adapter / tuttid client
  -> authoritative session or message update
  -> runtime snapshot refresh
  -> projection rebuild
```

UI-latency bridges have explicit owners:

- create and submit records in `AgentSessionEngine.pendingIntents`
- optimistic prompt projections derived from pending-intent selectors
- transient active-conversation fallback while runtime data catches up
- controller-local detail paging, loading, and error state

Every pending intent declares its authoritative confirmation path.
Optimistic prompt messages must stay pending-intent projections even when they
are used to scope the selected detail window. Do not promote them into durable/detail
message bases: their local timestamp-derived versions can outrank lower
authoritative daemon versions and suppress the durable user prompt during merge.
Existing-session submit must record the optimistic user prompt before the
`sendInput` acknowledgement returns, then retarget or remove that prompt by
`clientSubmitId`; otherwise switching away during submit can leave only later
assistant stream events visible when the user returns.

### Turn Summary Undo/Reapply

The changed-files turn summary follows Codex-style patch semantics, but keeps
the implementation split across the existing Tutti ownership boundaries:

```text
agent fileChange/tool output
  -> AgentGUI turn summary projection stores executable patchBatches
  -> AgentTurnSummaryRow builds per-batch unified diffs
  -> AgentHost workspace.resolveGitPatchSupport
  -> tuttid GET /v1/workspaces/{workspaceID}/git-patch-support
  -> AgentHost workspace.applyGitPatch with cwd + diff + revert
  -> desktop tuttid client
  -> tuttid POST /v1/workspaces/{workspaceID}/git-patch
  -> services/tuttid Git patch service
  -> git apply / git apply -R against the Git repository resolved from cwd
```

The response-tail presentation and executable patch actions have separate
canonical inputs:

- `WorkspaceAgentSessionDetailResponse.turns[].fileChanges.files` owns each
  turn's changed-file list and create/modify/delete semantics. The detail
  response returns root-session turns in durable order; list responses keep
  only active/latest turn projections.
- completed tool-call `changes` payloads own executable `patchBatches`,
  including tool call id, cwd, path, change type, and patch content used by
  Undo/Reapply.

AgentGUI may associate executable patch batches with files already present in
the matching durable turn's `fileChanges`, but it must not reconstruct the
changed-file list from tool calls, provider metadata, or activity-card
`changedFiles`. The desktop reconcile bridge inserts detail turns into the
existing activity engine `turnsById` store, and AgentGUI projects each settled
turn's summary directly after that turn. Sessions written before this contract
was enforced are not backfilled in the conversation UI.

Claude SDK sidecars must not treat Edit/Write input text as authoritative patch
data. They should collect the `PostToolUse` `tool_response.structuredPatch`
hunks, convert them into file-level `changes[].diff` payloads, and only use
input-derived file metadata for optimistic display before the tool response
arrives. Provider diff metadata must be canonicalized at this adapter boundary
before it becomes durable activity data. In particular, unified-diff control
markers such as `\ No newline at end of file` must use Git's exact syntax;
provider display formatting must not flow unchanged into executable
`patchBatches`.

Provider adapters that receive successful write/edit/apply_patch tool calls
without a native turn-level diff event must normalize the executed tool output
into `fileChanges.files`, merge it with the current turn's canonical file set,
and emit a `turn.updated` patch carrying the accumulated `fileChanges`. The
shared runtime normalizer consumes provider semantics such as Cursor ACP
`kind=delete`, Codex `changes[].kind.type`, and Claude Code structured patches;
raw provider fields do not cross into AgentGUI business rules. The AgentGUI
response-tail summary reads only the matching durable turn's `fileChanges`
state from the session-detail turn collection.

Approval transport calls may wrap pending Edit/Write input, but they are
interaction plumbing rather than transcript content. Preserve that nested input
in durable activity for correlation and diagnostics only. Conversation
projection removes top-level and delegated-task calls identified by
`callType=approval` or `toolName=Approval` before they reach React. Those calls
must not contribute edit diff counts, changed-file summaries, or undo/reapply
patch batches. The executed file-change tool output remains the source of truth
for edit statistics and reversible patches. Actionable approval surfaces read
canonical Interaction state, so filtering working, completed, and failed
Approval tool rows must not remove a pending approval.

Claude SDK interactive tools must preserve `callType: "interactive"` on the
top-level durable tool payload, not only inside `metadata`, so historical
display-only prompt rows can be classified consistently. Actionable Agent GUI
and Message Center approvals and prompts come from canonical Interaction state,
not transcript tool rows. For `AskUserQuestion`, renderer payloads may keep
`answersByQuestionId` keyed by stable UI question ids, but the Claude SDK
permission callback must return `updatedInput.answers` keyed by the full
question text because current Claude SDK result rendering looks up answers by
question text. Completed transcript rows must also normalize the provider
response envelope: persisted answers may live under
`output.payload.answersByQuestionId` / `output.payload.answers` rather than on
`output` directly. The AskUserQuestion detail projection must read that
envelope before deciding that no answer exists, so a completed tool row cannot
remain visually stuck on its waiting state. Its specialized detail renderer
must show both the structured selected answer and a persisted provider
`output.text` result when present; specializing the question presentation must
not discard the tool result. Legacy Claude ACP `AskUserQuestion` failures may
be hidden only when the recorded failure says the tool is unavailable; waiting
or completed Claude SDK `AskUserQuestion` calls may remain in the Agent GUI
detail projection as display-only history without becoming an actionable prompt
source.

Runtime interactive prompts also travel through session state. Provider
adapters expose them as `SessionStateSnapshot.pendingInteractive`; runtime
state patches must preserve that field through `WorkspaceAgentStatePatch`,
`AgentActivityStatePatch`, and `AgentHostWorkspaceAgentStatePatch` so
AgentGuiNode can render prompts before any durable tool-call row completes.
This field is tri-state: omitted means "no change", an object means "show this
prompt", and explicit `null` means "clear the current prompt". Do not model it
as a persisted workspace session field or as a pointer-only JSON field that
cannot emit `null`.

Provider-native work is represented by subordinate `WorkspaceAgentSession`
entities, not by a summary inside root runtime context. The earliest Claude SDK
`Task` tool-use event creates a child session and submitted child turn. Later
`task_id` and `agent_id` values are provider aliases bound to that same child;
they must never select another child by display order or by "only running"
heuristics. Child messages, tools, and interactions retain the exact child
session and child turn as their canonical owner.

AgentGUI receives every nested child session from the root session detail read
and loads messages through each child's normal message endpoint. The workspace
engine remains the single frontend entity store. Pure projection attaches a
child lane to the delegation card whose call id equals the child's immutable
`parentToolCallId`, then recurses through `parentAgentSessionId` for nested
children. Lane status comes only from the child's canonical active/latest turn.

Claude SDK manual `/compact` turns must publish a visible compact completion
activity when the SDK emits only a `compact_boundary` system message. The
boundary still updates context usage, but it can arrive before the SDK echoes
the user message or after the result settles; AgentGUI needs the sidecar to
attach a durable `compact_completed` event to the compact command turn rather
than only the currently active turn.

Claude SDK Result success is the turn lifecycle terminal signal. Best-effort
context-usage and session-title refreshes run after the sidecar emits that
terminal event and must never delay it. A context snapshot is invalidated when
a newer snapshot request starts or the SDK echoes a later root user prompt, so
a slow control response cannot overwrite usage associated with newer work. A
delayed title refresh is likewise ignored after a later root prompt begins.

When Claude resumes root work after a child completes, the SDK continuation is
another provider turn attached to the same canonical root turn. The adapter
publishes its provider start and terminal facts, while `services/tuttid` keeps
the root turn active until that provider turn and every nested child turn are
terminal. AgentGUI must not turn a synthetic provider id into another
`WorkspaceAgentTurn`.

That continuation rule applies only while the canonical root remains live. A
user cancel revokes the provider execution generation before the root settles;
late background completion from that generation cannot reopen the root, create
a pending Interaction, or run another tool. A later explicit user prompt may
resume the durable provider session, but it owns a new canonical turn and a new
provider execution generation. AgentGUI continues to read canonical Turn and
Interaction entities; it does not hide late provider actions after execution.

Claude Goal status is presentation metadata, not a lifecycle authority. A
complete Goal may coexist with a waiting canonical root and running child.
AgentGUI derives its visible completion, composer availability, prompt queue,
and new-turn eligibility only from the `services/tuttid` root turn; it must not
unlock or create a turn because Goal became complete or because the Claude SDK
root call returned.

Do not persist the UI button state. A successful Undo only flips the local
button to Reapply for the current render. If the page reloads, the source of
truth is still the recorded diff plus the current worktree state; `git apply`
decides whether the operation can still apply cleanly.

The Undo/Reapply control uses an icon plus visible text. Before enabling the
control, AgentGUI resolves Git patch support for every cwd in the pending
batches. If any cwd is outside a Git repository, the control stays disabled and
uses an explanatory tooltip instead of letting the user click into a
`not-git-repo` failure. If the row cannot reconstruct executable patch data,
AgentGUI still renders the control disabled with a tooltip.

Patch batch cwd values may be runtime-projected paths such as `/workspace`.
AgentGUI must use those values to construct cwd-relative unified diffs, but map
them back to the host workspace root before calling Git support/apply APIs.
Although the daemon transport route is under `/v1/workspaces/{workspaceID}`,
turn-summary patch apply follows Codex App's host operation semantics: the
request supplies `cwd`, `diff`, and `revert`, and the daemon applies the patch
to the Git repository resolved from `cwd`. `workspaceID` is the desktop/tuttid
context for transport, eventing, and host integration; it is not a filesystem
boundary for this operation. The daemon Git patch service also treats a supplied
file path or not-yet-created target path as a path inside the candidate
repository by resolving from the nearest existing parent directory.

The Git mutation belongs in `services/tuttid`, not `apps/desktop` or
`@tutti-os/agent-gui`. The daemon creates a temporary `tutti-apply-*`
directory, writes `patch.diff`, optionally copies the Git index into that
directory for non-atomic unstaged `--3way` operations, runs `git apply --check`
with the same target, reverse, binary, directory, and temporary-index options,
then executes `git apply` or `git apply -R` only after preflight succeeds. A
syntax failure returns `invalid-patch`; a valid patch that no longer matches the
worktree returns `patch-does-not-apply`. The daemon removes the temporary
directory on every exit path.
When reversing an added-file patch, the daemon has one narrow fallback for
less-structured summary diffs: if Git rejects the patch, the target is still
untracked, and the current file content only differs from the patch by trailing
newlines, it removes the file directly. Real content drift must continue to
fail instead of being deleted.

Undo uses reverse batch order. Reapply uses original batch order. A non-success
batch stops the remaining batches and is not automatically rolled back. This is
intentional: summary undo is a reverse patch against the current worktree, not a
snapshot restore.

Patch failures are surfaced through the host-provided short toast capability.
The desktop host wires that capability to the existing `Toast.Error` facade;
AgentGUI shared components should not call the sonner `toast.error` entrypoint
directly except as a last-resort fallback when no host toast capability exists.
The summary card does not keep an inline failure row or durable error state
because the source of truth remains the recorded diff plus the current worktree
state. The desktop and daemon record the same `agent-git-patch` diagnostic
family with JSON payloads, including the action, result, error code, paths, and
Git stderr. Diagnostics record a diff hash and byte count rather than raw file
content.

Codex invalidates Git query caches after this operation. Tutti currently has no
equivalent renderer Git cache group. The AgentGUI row emits a lightweight
`tutti-agent-git-patch-applied` browser event after a result that changed files
so desktop surfaces can attach targeted refresh behavior later, but this event
is not durable state and should not become the source of truth.

## User-Facing Data Flows

Use these flows when debugging AgentGUI behavior. They are intentionally written
from the user's action back to the authoritative data source.

### External History Import

```text
desktop ZIP picker or local-history source selection
  -> ExternalAgentSessionImportWizard
  -> WorkspaceAgentActivityService scanExternalSessionImports
  -> tuttid external-import scan endpoint
  -> local JSONL scanner or Claude data-export ZIP parser
  -> selectable import session summaries
  -> WorkspaceAgentActivityService importExternalSessions
  -> tuttid external-import import endpoint
  -> ActivityProjection persisted sessions/messages
  -> desktop activity load + user-project refresh
  -> AgentActivityRuntime snapshot
  -> AgentGUI rail and transcript
```

The daemon owns archive validation and conversation parsing. Desktop passes the
absolute path selected through the native picker, and both scan and import must
carry the same `archivePath`; import reopens and revalidates the archive rather
than trusting scan-time state. The wizard must bind a completed scan to its
normalized local/archive source identity and invalidate it before a source
change or failed rescan, so sessions from one scan cannot be submitted with a
different archive path. Claude exports are read directly from the exact root
`conversations.json` ZIP entry. Preflight the ZIP central directory and bound
conversation JSON depth, container counts, token counts, and retained messages
before expanding untrusted data. Do not extract the archive, execute tool
payloads, fetch citation URLs, or treat referenced files as locally available.

Claude export `message.text` is not a safe visible-body source: rich messages
can include hidden thinking and tool material there. Import ordered
`content[type=text]` blocks into visible transcript text; only legacy user
messages with no structured content may fall back to `message.text`, and
assistant messages never may. Ignore control blocks,
and retain file-only messages as unavailable references without claiming that
the ZIP contains their payloads. Stable source message UUIDs make repeat imports
idempotent even when a later export inserts earlier messages. Claude exports may
contain mutually exclusive edit/retry branches. Build the parent-message graph
and import the deterministic latest leaf's root-to-leaf path; never flatten
sibling branches into one transcript. Namespace the imported session with a
fingerprint of the selected sibling choices: ordinary appends stay in the same
session, while a later export that selects a different retry branch lands in a
separate session instead of accumulating incompatible messages. Preserve the
branch fingerprint and chosen leaf UUID in message payloads so that branch
selection remains auditable.

claude.ai exports do not carry a coding-project cwd or a Claude Code runtime
session id. Persist them in the no-project Chats section with
`runtimeContext.imported`, `externalImportNoProject`, and a false
`externalImportResumeSupported` marker. They may use the Claude Code target for
presentation, but AgentGUI must keep the imported history read-only and route
continued work through the existing "continue in a new conversation" flow.

For a project-backed external import, the exact project selection matched by
the import service is authoritative rail-classification input. It must reach
the activity store with the session report before the API registers successful
projects in the user-project inventory; otherwise an already registered parent
project can capture a nested session permanently. The store accepts this hint
only for imported, project-backed sessions and verifies that the selected path
contains the imported cwd. Ordinary runtime-session membership remains
immutable. Re-importing the same historical session may repair only a Chats or
ancestor-project assignment to that explicit descendant selection; it must not
reclassify from the current user-project inventory or move a correctly assigned
child session back to a parent.

### Conversation List Loading

```text
AgentGUI / AgentGuiNode mount
  -> useAgentActivitySnapshot(workspaceId)
  -> AgentActivityRuntime.load(workspaceId)
  -> WorkspaceAgentActivityService.load
  -> AgentSessionEngine workspace/reconcileRequested
  -> desktopAgentActivityAdapter.listSessions
  -> tuttid ListWorkspaceAgentSessions
  -> agent.Service.ListPage
  -> live RuntimeController sessions + persisted ActivityProjection sessions
  -> AgentSessionEngine session/snapshotReceived (historical)
  -> memoized AgentActivitySnapshot projection
  -> conversation-list selector/projection
  -> rail and active-session fallback selection
```

The session list is not owned by AgentGuiNode. AgentGuiNode may keep query,
selection, pending create/delete/submit overlays, and read-state UI metadata.
The session rows themselves come from the runtime snapshot and are refreshed
through `load`, event reconciliation, or explicit session fetches.
Deleting the selected conversation commits `activeConversationId=null` and the
home intent before the delete command runs. It must not auto-select an adjacent
row, including a row that later fills the deleted page slot. Deleting a
non-selected conversation preserves the current selection. If the command
fails after the home transition, report the failure without restoring or
selecting another conversation.
The desktop adapter should keep broad session-list loads bounded before they
enter `AgentActivityRuntime`; large workspaces can accumulate hundreds or
thousands of historical agent sessions, and pushing all of them through the
runtime snapshot forces AgentGuiNode to repeatedly project and reconcile data
the user is unlikely to inspect in the rail.
AgentGUI rail sections are loaded from the daemon section contract, not inferred
from conversation `cwd` values. The runtime exposes `listSessionSections` for
section first pages and `listSessionSectionPage` for Show more; both are backed
by `GET /v1/workspaces/{workspaceID}/agent-session-sections` and
`GET /v1/workspaces/{workspaceID}/agent-session-sections/page`. Project
sections come from current `userProjects` and use the stable
`project:/canonical/path` `sectionKey`; the Chats section uses
`conversations`. This inventory is the durable registered-project list; rail
loading must not probe project paths or implicitly remove unavailable folders.
The daemon-owned `user_projects.sort_order` is the single global project order,
partitioned by the required public `pinnedAtUnixMs` field: pinned projects come
first, followed by ordinary projects. `sort_order` never crosses the daemon
contract. Pin moves a project to the front of the pinned partition and updates
`pinnedAtUnixMs` plus `updatedAtUnixMs`; unpin clears `pinnedAtUnixMs` and moves
the project to the front of the ordinary partition. Same-state pin requests are
strictly idempotent and publish no event. New or re-added projects enter at the
front of the ordinary partition, repeated use updates compatibility timestamps
without moving or changing pin state, and delete/move transactions rewrite one
continuous order. Move is valid only within the source project's partition;
`beforeProjectId=null` means that partition's end.
Every renderer window mirrors the complete ordered snapshot in its one
workspace-user-project service store. A drop updates that store optimistically,
then `user.project.updated` broadcasts the committed complete snapshot to every
window; project selectors, file-manager locations, AgentGUI, and workspace-app
bridges consume that same store rather than keeping another persistent order.
The required pin field makes this the version 2 event contract; publishers and
consumers must use that version rather than accepting a missing-field fallback.
Pin/unpin uses the same optimistic snapshot and response reconciliation flow.
An event received while a move or pin mutation is in flight is held until the
response is reconciled, and a conflicting held snapshot triggers one
authoritative refresh. The same renderer service snapshot owns
`isMutationPending` for pin, move, project removal, creation, and association.
Every AgentGUI rail in that renderer subscribes to this flag and disables those
project mutations for the full mutation lifetime; per-Rail drag state is only
transient interaction state, not the shared mutation lock. Pin and move failures
deliberately retain the current window's optimistic order until a later
authoritative event or reload and produce diagnostics without user-visible
error UI.
Path availability and explicit removal belong to the user-project domain. The
daemon pages sessions by `rail_section_key`, so AgentGUI
must render returned section props and use backend `hasMore`/`nextCursor`
rather than cwd grouping, root filters, excluded project paths, or local
Show more heuristics. Page responses upsert their session entities into the
workspace engine; the rail query cache stores only ordered session ids,
section metadata, cursors, and totals. A pure projection joins those ids back
to engine entities. Do not keep a second summary cache or manually patch
section rows from conversation summaries. Every daemon session carries its
required persisted `railSectionKey`. An active session outside loaded pages and
backend search results enter a section only when that key exactly equals the
section key; pinned state remains independent. AgentGUI must not manufacture a
session membership fallback or infer membership from cwd and resolved
user-project paths. Empty project and Conversations section chrome remains
visible from the current section inventory even when no exact membership rows
exist or the initial membership request fails; preserving that chrome must not
place any session into it. The daemon assigns the key before Create succeeds
and treats it as immutable session identity metadata; later cwd observations do
not move the session to another rail section. The sole correction path is the
explicit external-import selection repair described above. Removing a project
removes that rail section from the section list; re-adding the same path reveals
historical sessions with the same section key.
The daemon first-page reader is a required production repository seam, not an
optional fast path with a per-section fallback. Its SQLite query must be driven
by the requested section keys: ordinary branches use the rail-section page
index, and pinned rows use a separate pinned-page index branch. Do not scan the
workspace session history and test section membership row by row; workspaces
retain historical sessions for removed projects that are not part of the
current rail. Count, sort, and first-page trimming operate on narrow session-id
rows; load full session entities only after that trimming. The query shape must
not add one compound-select arm per requested section or inherit SQLite's
compound-select term limit as a Rail project-count limit.
Daemon rail reads use the shared SQLite read-only pool rather than the daemon's
single write connection. Section pages and their turn/interaction hydration may
therefore read committed WAL snapshots while an unrelated write transaction is
in progress. Do not route these independent reads back through the write pool;
queries that require read-after-write atomicity must instead remain inside the
owning write transaction.
When `agentTargetId` narrows the provider rail, use an exact target predicate
and target-scoped ordinary/pinned composite indexes. An optional
`(? = '' OR agent_target_id = ?)` predicate on an unscoped index only filters
after scanning every provider row in the section and is not an acceptable
provider-switch query plan.
Rail search is a separate UI-local query over
`GET /v1/workspaces/{workspaceID}/agent-sessions`. Its `searchQuery` and active
`agentTargetId` are applied by the daemon before cursor pagination, so results
cover every visible session in the workspace rather than only the loaded rail
sections. Each returned session is upserted into the same workspace engine;
the search controller stores only result ids, cursor, and request state, then
the rail joins those ids to canonical entities. It must not recreate the old
conversation-summary cache. An initial backend-search failure renders a
localized retry action; retry reissues the current target-scoped query instead
of presenting the failure as an empty result. Search and agent-target filtering
retain every registered user-project title even when its filtered session items
are empty, so the durable project order remains visible and draggable. Rail
composition is always pinned sessions, pinned project sections, ordinary
project sections, then Chats. Pinned projects remain ordinary project-section
models and keep their existing empty state. A conversation pinned independently
appears only in the pinned-session region and is excluded from its project body;
pinned-session Show more stays before pinned projects. The single pinned title
is visible when either kind of pinned content exists, while the Projects title
and add-project entry remain visible even when every project is pinned. Hosts
without `listSessionsPage`, including
preview-only hosts, may fall back to local title filtering of loaded rows.
Ordinary section pages and backend search pages share one deterministic order:
`latestTurn.startedAtUnixMs DESC`, falling back to
`session.createdAtUnixMs DESC`, then `session.id ASC`. Their cursors encode
that resolved conversation sort time plus session id. Renderer canonical
projection and active-row overlays must consume the same resolved sort key;
`session.updatedAtUnixMs` and `latestTurn.updatedAtUnixMs` are entity freshness,
not conversation-list order.
Every section page and pinned page also carries `totalCount` for the full
target-filtered scope before cursor pagination. Ordinary section pages exclude
pinned sessions because those rows belong only to the dedicated pinned page;
filtering pinned rows after section pagination corrupts page size and totals.
If a refresh of an already-resolved section scope fails, keep its membership,
cursor, and totals; only an unresolved or newly selected scope may resolve to an
empty failure state.
Section-query `pending` has two presentation meanings. An unresolved first page
is blocking and may reveal the delayed rail skeleton. A same-scope membership
refresh is non-blocking: keep the resolved membership visible and interactive
until authoritative daemon pages replace it. Pin and delete enter the workspace
engine as typed mutation intents. Their reducers own pending, success, failure,
and unknown outcomes, emit one semantic external command, and commit returned
sessions or deletion tombstones through follow-up intents in the same engine
drain. AgentGUI and desktop facades may await the mutation selector for local
cleanup or reporting, but they must not execute the transport command or patch
canonical entities themselves.
The rail query controller compares canonical before/after membership and reloads
only affected first pages: ordinary delete reloads its section, pinned delete
reloads pinned, and pin/unpin reloads both pinned and the session's ordinary
section. Rename does not reload section pages; an active backend search is
reissued because title changes can alter its membership. Canonical entity and
page membership clocks meet at one composite rail snapshot seam: the controller
publishes derived engine conversations together with daemon membership. While
targeted reads are pending, it retains the prior immutable composite snapshot;
after all reads resolve, it ingests returned entities and publishes the complete
next snapshot once. The view must not subscribe to the engine separately or keep
stale sections. A targeted failure keeps the committed snapshot and locks
membership-sensitive actions until an authoritative scoped refresh succeeds.
This derived committed snapshot is not a writable session cache; canonical
entities remain engine-owned and query state still stores only ids, cursor, and
totals. The controller never reads engine mutation history. Attach compares the
current canonical membership with its last observed records and invalidates
interrupted draft query work before bootstrap; canonical changes completed while
the panel is detached must be revalidated without preserving an old lock.
Targeted revalidation must not fall back to `listSessionSections` or a
workspace activity `load`. A
scope change may also keep the previous page visible to avoid destructive
layout churn, but actions whose section or target scope could be stale remain
locked until the new scope resolves. Derive these meanings inside the dedicated
rail query controller from its current and resolved scope keys; do not manually
move rows or make the view reinterpret raw request state.
The active conversation is a
display overlay, not a pageable row: it may render beside the first five rows,
but it must not consume the local visible-item limit or advance the cursor.
Pending-activation rows follow the same rule and stay excluded from pageable
item counts until runtime reconciliation makes them canonical sessions.
Show more compares distinct rendered ids, including that overlay, with
`totalCount` before using `hasMore`/`nextCursor`. This prevents both false
controls when five page rows plus the active overlay already cover all six
sessions and no-op first clicks when the next local slot is the already-visible
active session.
Section-level actions must use the same backend section contract when their
scope is "everything in this section." For example, project batch delete cannot
derive its target set solely from the currently rendered `section.items`, because
those rows may only be the first page. Batch deletion uses a two-step snapshot
flow: AgentGUI requests deletion candidate IDs by `sectionKey`, optional exact
`agentTargetId`, and `excludePinned=true`; the confirmation count is the
returned `sessionIds.length`; confirmation then sends that immutable ID list to
the exact batch-delete endpoint. The delete command must not re-resolve section,
target, or pinned membership. Sessions added after candidate selection are not
deleted, while a selected session that is pinned or moved before confirmation
is still deleted under the chosen snapshot semantics.
Pinned conversations are returned beside those sections as a separate pinned
page on the `listSessionSections` bootstrap response. AgentGUI may render that
page as a local `pinned` group, but pinned is not a daemon section kind and
must continue to be derived from session `pinnedAtUnixMs`. Pinned Show more
uses the dedicated pinned page runtime method instead of the section page
endpoint, because pinned has no daemon `sectionKey`. Ordinary project and Chats
section pages must exclude pinned sessions before pagination and `hasMore`
calculation, so the pinned page and ordinary section pages are mutually
exclusive. Section action disabled state therefore uses only the ordinary
section's `items` and `hasMore`; pinned rows never make an otherwise empty
ordinary section deletable.
Rail row actions that need row details must use the row from the displayed
section model, not re-resolve it from the activity snapshot. Section pages can
include historical sessions that are visible in the rail before they appear in
the current snapshot, so actions such as rename must carry the displayed
conversation through to their dialog or local interaction state.
When the provider rail is scoped to a specific agent target, AgentGUI must pass
that `agentTargetId` to both section endpoints. The daemon applies that filter
before `LIMIT` and `hasMore` calculation; frontend filtering after an unscoped
page is not equivalent and can leave sections with fewer visible rows but a
stale Show more affordance.
AgentGUI must not refetch section first pages merely because a user activates a
conversation, the active detail provider changes, or an existing conversation
summary receives detail/status/time updates. Those updates should refresh
already-rendered row props locally while preserving backend section membership.
Section pages may contain historical sessions outside a bounded workspace list
response. Their entities still enter the engine's normalized session store;
later bounded snapshots merge monotonically and explicit removal events own
deletion, so omission cannot evict a page-loaded or selected entity. Detail
reconciliation of one of those entities is not new rail membership and must
preserve every loaded section page and cursor. Entity-list order or count must
not serve directly as a section-query invalidation key; rail invalidation must
account for membership already owned by loaded section pages.
Workspace historical reconciliation is entity hydration, not a rail membership
mutation. While `workspaceReconcile.status` is `loading`, the query controller
must only advance its membership comparison baseline; it must not invalidate or
target-refresh section pages for `session/snapshotReceived`. The initial section
response owns bootstrap membership and must upsert returned entities into the
workspace engine before publishing membership ids. Once reconciliation is ready,
later canonical membership mutations continue through the targeted refresh path.
The aggregate first-page section query is reserved for workspace, rail filter,
or user-project inventory changes. Its user-project cache identity is based on
the project set, not array order: a pure project reorder must not refetch section
pages or enter loading because `userProjects` owns templates, labels, and order,
while `sessionSections` owns only membership, counts, and pagination. Session
membership changes use only the
affected section/pinned first-page endpoints; Show more continues to use the
same page endpoints with its cursor.
Pending activation becoming canonical is one of those session membership
changes, even while that session remains active. The rail query controller must
retain the session id as reconciliation metadata, refetch its exact section
first page, and let the pure display projection join and sort the canonical
engine entity until a successful daemon response replaces the membership cache.
Active selection alone must never suppress this invalidation; historical
active-detail hydration without pending-activation provenance remains an entity
update and must preserve loaded pages and cursors.
During rail-filter refetches, keep the previously rendered section chrome in
place for short reloads. Provider/agent switching should not briefly unmount
the project rail header or replace a populated rail with an empty/skeleton
rail; if the new first page takes longer than the rail skeleton delay, show the
skeleton so the user sees loading feedback. Only workspace changes may clear
the section cache immediately. The desktop runtime shares bounded first-page
query entries across AgentGUI controller mounts, keyed by workspace and exact
rail scope. A fresh entry is restored without transport; a stale entry remains
visible while one in-flight request is shared by every consumer. Cache entries
contain membership, cursor, total, and section metadata only; canonical sessions
remain in the workspace engine. Local Show more/Show less expansion belongs to
the workspace-plus-filter query scope, not the backend section id alone. Reset
its visible-item limit in the filter-change render so stale section chrome
cannot flash pagination controls from the previous provider scope. Keep the
previous section page metadata paired with that stale chrome until the new
first page resolves; clearing `hasMore` independently makes the pagination row
disappear and reappear. Disable paging actions while the replacement request is
pending so a stale cursor cannot enter the new provider scope.
The rail query controller owns this interaction lock and exposes a live query
method for row and portaled-menu actions. Views must not mirror the pending flag
through value refs or manufacture a stable callback around such refs; deferred
actions query the controller at execution time so an already-open menu cannot
cross a newly entered replacement state.
Conversation-list read-state metadata is notification-style UI state. Historical
imports that carry `runtimeContext.imported === true` should remain visible in
the rail, but they must not seed unread completion lamps as though they just
finished locally. Preserve the imported marker through conversation summaries
and summary-stabilization equality before deriving unread completion state.
Active-conversation ownership is a visibility/registration signal, not always a
new read action. Mark unread completions as read when an owner changes to a
different active conversation or when the user explicitly selects the
conversation, but do not clear a manual unread override when the same owner
re-registers the same active conversation during focus, query, or render
catch-up.
If the conversation-list query cannot be constructed because workspace,
current-user, or provider identity is missing, clear the active conversation
selection and persisted active hint. Do not treat that state as a runtime
refresh gap. Temporary runtime/list catch-up should instead be represented by
an explicit pending create, transient conversation, or detail overlay that can
reconcile back to `AgentActivityRuntime`.

### Existing Session Detail Loading

```text
activeConversationId changes
  -> session detail transport and controller paging state
  -> AgentActivityRuntime.listSessionMessages
  -> WorkspaceAgentActivityService.listSessionMessages
  -> desktopAgentActivityAdapter.listSessionMessages
  -> tuttid ListWorkspaceAgentSessionMessages
  -> ActivityProjection.ListSessionMessages
  -> AgentSessionEngine message/snapshotReceived
  -> memoized AgentActivitySnapshot projection
  -> transcript projection
  -> AgentGUINodeView / AgentConversationFlow
```

Detail loading is separate from list loading. A conversation can appear in the
rail before its messages are loaded. The detail panel reads the explicit
message-loading state owned by `useAgentSessionControllerState`; it does not
infer loading from the send button state.
The root session detail response also contains a flat collection of every
nested child session. Desktop reconcile upserts the root and all children into
the same workspace engine, then loads each session's messages through the
existing per-session message endpoint. Root-only list selectors keep children
out of the rail and Message Center counts; the full snapshot still retains
children for transcript lanes and exact child interactions.
Older-history prefetch is opportunistic UI behavior. If a page load for a
specific `(agentSessionId, beforeVersion)` cursor fails, AgentGuiNode should
record that failed cursor and suppress automatic retries until the detail page
is reloaded or a different oldest durable version is reached. Do not let scroll
position and `isLoadingOlderMessages=false` form an immediate retry loop against
the same failing backend page.
Older-page request coordination is an explicit controller state machine keyed
by session and cursor. Its phases are `in_flight`, `exhausted`, and `failed`;
reset invalidates an outstanding request, stale results cannot merge or clear a
newer loading flag, and cursor advance starts a new request. Do not represent
these transitions as parallel render refs or independent maps.

The selected detail window is a UI-local page cache, not proof that the full
durable transcript has loaded. If live updates or snapshot reconciliation seed a
detail window before the selected session's initial message page resolves, do
not treat that window as a complete cache just because it has renderable rows.
Either force the initial `listSessionMessages(order="desc")` page load, or mark
the window as having older history so top-of-transcript prefetch can request the
missing page. This is especially important when the oldest loaded durable
version is greater than the first persisted version: otherwise the visible top
row can be a later assistant/tool message even while the scroll container is
already at the top.

### First Prompt In A New Conversation

```text
composer submit with no activeConversationId
  -> startConversation
  -> normalize prompt content and optional displayPrompt
  -> set local first-create busy state
  -> mark conversation-list create pending
  -> create optimistic conversation id + user message
  -> enter optimistic conversation detail
  -> activation.activate(mode="new")
  -> AgentActivityRuntime.activateSession
  -> WorkspaceAgentActivityService.activateSession
  -> desktopAgentActivityAdapter.createSession
  -> tuttid CreateWorkspaceAgentSession
  -> agent.Service.Create
  -> provider install/check + prepareRuntime
  -> RuntimeController.Start
  -> RuntimeController.Exec when initialContent exists
  -> activation succeeds
  -> replace transient summary with durable conversation
  -> reconcile optimistic user message
  -> clear the submitted home draft if it was not edited in flight
  -> ActivityProjection receives runtime reports
  -> agent.activity.updated events
  -> AgentSessionEngine intents and canonical state update
  -> projection + UI refresh
```

For normal first-message creation, the controller creates an optimistic
conversation id and enters that conversation surface immediately while
activation is pending. The optimistic session is not durable yet, so any
ordinary follow-up submit targeting `startingConversationIdRef.current` must
enter the workspace engine's prompt queue instead of calling `sendInput`
directly.
Pending new-session activation is request- and session-scoped, not a
workspace-wide creation lock. A workspace may have multiple pending new
activations, and conversation state retains every optimistic session.
The engine's `pendingIntents` is the only owner. The conversation-list selector
projects each missing session once and marks its row as a pending-activation
projection. A pending intent has no persisted `railSectionKey`, so it remains
outside formal rail sections until the canonical daemon session arrives; the
frontend must not guess a section from its cwd. Runtime section pagination
caches canonical session ids only. Pending rows must never be written into
section pages, cursors, or membership invalidation.
The pending row itself does not invalidate membership. Its transition to a
canonical engine session does, and the query controller may keep only that
session id—not a duplicate summary—as temporary reconciliation metadata.
Starting another draft, switching provider targets, or returning to the home
composer must not unactivate an earlier pending new session. The submit action
selects its own optimistic session explicitly; later activation confirmation,
failure, or list reconciliation must never select another session or steal
focus from the user's current draft/conversation.
Submitting the first prompt transfers its normalized content into the pending
activation record. The submit/composer module—not activation or selection—owns
clearing the matching target-level home draft, so a later New action starts
empty. The same module reconstructs the home draft after activation failure,
only when the user has not already typed a replacement home draft.
The composer model owns one submission projection that separates normalized
provider-facing `content` from the optional user-visible `displayPrompt`.
Provider-facing prompt syntax rewrites, including descriptor-authoritative skill
trigger aliases, must preserve the pre-rewrite visible text as `displayPrompt`
when the two representations differ. Existing explicit display prompts for rich
mentions and persisted pasted text take precedence. Ordinary prompts whose
visible and runtime text are identical omit the field.
The pending prompt envelope preserves normalized `content` plus that optional
`displayPrompt` used for presentation. Materialized `runtimeContent` exists only
on the requested intent and transport command; it must not replace presentation
content in the pending record. Activation and existing-session submit share this
contract. Their optimistic user messages use the authoritative payload shape:
`content`, optional `displayPrompt`, and `text` resolved from `displayPrompt`
before content-derived text. The optimistic title and daemon initial-title
derivation consume the same visible representation; the canonical session title
then replaces the optimistic projection after persistence.
Provider adapters must carry the materialized prompt in the provider's input
field only. Auxiliary request metadata must not duplicate unbounded prompt
content; provider-specific wire metadata remains adapter-owned and limited to
the provider contract.
Timeline admission must treat renderable structured prompt content as a user
message even when that derived text is empty. In particular, an image-only
pending prompt projects through the same canonical user-message path and
renders its image grid before the durable twin arrives; the GUI must not invent
an `[Image]` text placeholder. Empty-text structured prompts use stable submit
or event identity for duplicate suppression instead of sharing an empty-text
key. Image presentation identity derives from the stable message identity and
content position, never from a transport locator such as a prompt-asset path or
durable attachment ID; locator promotion must not remount an already rendered
image.
After activation succeeds, the controller attaches the durable conversation and
reconciles the optimistic user message before loading runtime projection. For
Claude Code,
`desktopAgentActivityAdapter.createSession` may promote a pre-warmed hidden draft
session before calling `sendWorkspaceAgentSessionInput`. Create-time-only launch
options must opt out of that promotion path because the hidden draft has already
created and prepared its runtime.

### Sending To An Existing Conversation

```text
composer submit with activeConversationId
  -> executePrompt
  -> normalize prompt content and optional displayPrompt
  -> mark conversation-list submit pending
  -> patch local conversation status to working
  -> apply local state patch currentPhase=working
  -> AgentActivityRuntime.sendInput
  -> WorkspaceAgentActivityService.sendInput
  -> optimistic working session upsert
  -> desktopAgentActivityAdapter.sendInput
  -> tuttid SendWorkspaceAgentSessionInput
  -> agent.Service.SendInput
  -> validate/prepare prompt content
  -> RuntimeController.Exec
  -> build submitted Turn transition in runtime memory
  -> ActivityReporter synchronously commits session + submitted Turn
  -> publish agent.activity.updated and start provider execution
  -> service reads back the exact durable Turn by returned turnId
  -> authoritative session + exact Turn returned
  -> snapshot/projection/UI refresh
```

The local working patch is a latency bridge only. A successful Turn-producing
response is a durable acceptance acknowledgement: `turnId` and `turn` are both
required and identify the exact submitted Turn. Runtime must not publish the
submitted transition, start provider execution, or return success before the
atomic session/Turn report commits. If that report fails, it rolls back the
in-memory active Turn and provisional Session state. Goal control remains a
separate Turn-less response branch. The renderer may keep a defensive contract
guard, but must not repair a missing Turn with polling, delay, or a synthetic
entity.

When an existing conversation is busy, normal composer submits enter the
workspace engine's prompt queue so the next turn can run after the current one
settles. `Cmd+Enter` on macOS, `Ctrl+Enter` on other platforms, and “send now”
on an existing queued prompt all express the same higher-level intent: deliver
this prompt before waiting for the current turn to finish normally. The engine
resolves that intent from the canonical session capabilities, never from the
provider name:

- `activeTurnGuidance = true`: send the queued prompt with `guidance = true`.
  Codex app-server maps this to `turn/steer`; Claude SDK maps it to the sidecar
  `guide` request. The current turn remains active. The accepted submit claim,
  returned turn identity, and durable user-message event all reference that
  exact active turn; native guidance must not allocate a second synthetic turn.
  The authoritative message keeps the guidance submit's `clientSubmitId` so the
  engine can reconcile and remove its optimistic prompt without losing the
  visible user message after the turn settles or the transcript reloads. A
  guidance message is a mid-turn transcript event, not another opening prompt:
  the conversation projection must interleave it with assistant, thinking, and
  tool rows by authoritative sequence (falling back to occurrence time) while
  keeping the same canonical `turnId`.
- otherwise, `interrupt = true`: keep the prompt in the frontend queue, cancel
  the exact active turn, and send the prompt as a normal prompt only after a
  validated cancel result or an authoritative settled-turn update.

The submit-and-send-now transition is atomic inside `AgentSessionEngine`. The
controller must not first send a normal prompt and then try to promote it, and
the daemon must not own a second prompt queue. `Shift+Enter` remains the
multiline composer shortcut and must not submit either a normal prompt or a
send-now intent.
Active composer state must prefer a live `AgentActivityRuntime` turn lifecycle
over the selected session view/control state. `getState` and legacy state patch
paths can temporarily report a settled or available control state while the
runtime snapshot still has `turnLifecycle.activeTurnId` with a live phase. In
that split state, AgentGuiNode must keep the transcript/loading projection busy,
set normal `canSubmit` false, and let ordinary composer sends enter the local
queue. Only an explicit send-now action may select native guidance or
exact-turn cancel-then-send. Legacy `idle` turn patches clear `activeTurnId`;
they must not leave a stale active-turn block behind.

The submit target is not just a render detail. A detail-page composer must not
fall back to `startConversation` because a UI-local active conversation ref is
temporarily empty. If the view is not on the home composer, resolve the existing
session from the durable active-session hint and route through the existing
send path, or block/recover explicitly with diagnostics. Only an intentional
home-composer submit should create a new agent session.

### Resume Or Re-Attach Existing Session

```text
open existing conversation / retry activation / external launch
  -> activeConversationId selection
  -> activation.activate(mode="existing")
  -> AgentActivityRuntime.activateSession
  -> WorkspaceAgentActivityService.activateSession
  -> getSession from runtime/tuttid/persisted projection
  -> activation status already_attached or failed
  -> ensureSessionSynchronized / listSessionMessages
  -> reconcile stale persisted turn when needed
  -> snapshot/projection/UI refresh
```

Resume is not a new AgentGUI data source. It re-attaches UI to an existing
session identity and then reloads state/messages. If the session is marked
non-resumable or the provider returns a non-retryable resume error, the retry
path must stop instead of creating a shadow session.

### Agent Execution And Return Path

```text
tuttid agent.Service.Create or SendInput
  -> RuntimeController.Start / Exec
  -> submitted Turn durable-acceptance barrier
  -> provider adapter process or ACP connection
  -> provider emits lifecycle, phase, tool, message, prompt, and final events
  -> ActivityProjection.ReportSessionState / ReportSessionMessages
  -> SQLite agent activity tables
  -> AgentActivityPublisher.PublishAgentActivityUpdated
  -> event stream topic agent.activity.updated
  -> desktop WorkspaceAgentActivityService event handler
  -> inline message intent or authoritative session reconcile
  -> AgentSessionEngine listener notification
  -> memoized AgentActivitySnapshot projection
  -> AgentGUI projection and render
```

The provider/runtime reports are the durable return path. AgentGUI should not
parse provider stdout, terminal text, or runtime internals directly. It consumes
normalized sessions, messages, state patches, and message pages through
`AgentActivityRuntime`.
If a provider exposes final assistant text through a side-channel such as a
Claude SDK message rather than an ACP `agent_message_chunk`, the daemon adapter
must normalize that text into the same persisted message projection. AgentGUI
must not read provider transcript files or SDK-specific logs to recover missing
final output.
Tool output follows the same rule. Provider adapters may preserve raw fields
such as `stdout`, `output`, `content`, or SDK content blocks for diagnostics and
specialized renderers, but the daemon message projection must populate
canonical `output.text` when visible tool output exists. AgentGUI renderers
should prefer canonical fields and treat provider-specific output shapes only as
legacy persisted-message fallbacks.
Prompt image input is also part of the normalized runtime contract. Daemon
adapters that advertise `imageInput` must forward the structured prompt content
blocks to their runtime boundary; SDK sidecars may keep a text `prompt` fallback
for short-term IPC compatibility, but image execution must use the structured
`content` blocks instead of reconstructing input from display text. AgentGUI
enables prompt image drafts only when the provider/session capability advertises
`imageInput`. Providers that opt in to model-level image gating, currently
OpenCode and Cursor, must also have the selected model option carry
`supportsImageInput: true`; unknown model image capability is treated as
unsupported until the daemon resolves it from Models.dev or provider-specific
rules. Providers that have not opted in, such as Claude Code, must not be
blocked by a missing model-level field. Desktop prompt images must remain
structured image blocks and are not file mentions. Pasted images may start as
base64 UI draft data, but the
desktop runtime archives them through the host file capability before daemon
submission, then sends the managed desktop-local `path` as the image source.
Conversation previews for these path-backed images must use
`AgentActivityRuntime.readPromptAsset` to read the managed local asset; do not
keep base64 data in submitted prompt content just to render optimistic messages.
The daemon copies that source into the session prompt attachment store and
persists the normalized `attachmentId`. The managed source path must live under
the daemon state root's `agent-prompt-assets` directory, and the daemon must
re-check the resolved source path, symlink target, file type, and size before
copying it into the session attachment store.
Image validation is intentionally two-phase. The preflight that runs before
attachment persistence may accept a managed `path` as an ingress source so it
can check provider image capability without writing files. That does not make
the path valid provider content. After the daemon copies and hydrates the
source, `Controller.Exec` applies the strict runtime validator to the resulting
`data`, `url`, or `attachmentId` representation. Keep runtime execution strict,
and do not move attachment persistence ahead of capability preflight merely to
make path-backed drafts pass validation; unsupported providers must still fail
without creating session attachment files.
Shared callers may instead supply a URL-backed image block when they already
uploaded the image. That source must be an absolute HTTPS URL without embedded
userinfo and must retain a supported PNG, JPEG, or WebP MIME type. `data` and
`url` are mutually exclusive; ambiguous blocks are rejected. URL-backed images
bypass the prompt attachment store and owner-side hydration. Until uploaded
images carry a stable read identity end to end, user-message activity content
retains the HTTPS URL so reloaded transcripts can render the resource directly;
diagnostics must still record only safe shape flags and never log prompt bytes
or the URL itself. UI-local composer drafts and optimistic overlays retain the
same URL for preview and submission; they must not convert it to base64 or
persist it as a local prompt attachment.
Provider transport adapters may materialize that HTTPS resource into inline
image data only at their final request boundary when the upstream protocol does
not accept remote image URLs. Codex app-server, standard ACP, and the Claude SDK
sidecar currently do this immediately before their turn/prompt request; the
AgentGUI draft, submitted content, and durable activity payload remain
URL-backed. When a provider gains native remote-image support, remove the
compatibility conversion only from that provider adapter rather than changing
the shared composer contract.
When `uploadPromptContent` returns an image, the composer upload continuation
must accept every normalized image reference shape: `url`, `attachmentId`,
`path`, or `data`. A URL-backed result replaces the pre-upload base64 runtime
source with the trimmed URL while retaining the original `previewUrl` only for
UI rendering. Submitted-draft reconciliation must compare normalized URLs so
an in-flight edit to a URL-backed image cannot be mistaken for the submitted
draft and cleared. Validate this handoff with the focused `AgentComposer` and
`useAgentGUINodeController` test suites listed under Boundary Checks.
Composer diagnostics expose this chain without recording prompt bytes or signed
URLs: `agent.gui.composer.image_upload.requested`, `.resolved`, and `.failed`
report upload availability and safe reference-shape flags, while
`agent.gui.composer.submit_state_changed` reports the exact send-button blocker
such as `submit_disabled`, `image_uploading`, or `image_upload_failed`. These
composer events use the same development console fallback as controller
diagnostics when the host runtime implements uploads but omits
`reportDiagnostic`.
Claude Code runtime options follow the same parity rule. The legacy ACP adapter
and the Claude SDK adapter must derive system prompt append text, Tutti detail
mode instructions, plan-mode instructions, plugin directory, custom model args,
disallowed tools, and the Claude Code built-in tool preset from one daemon-side
builder before they cross their runtime boundary. SDK sidecars should map that
structured payload into SDK `query` options; they should not rediscover plugin
dirs, infer tool availability from UI labels, or keep a separate prompt/options
contract from the ACP path.

### Event Reconcile And UI Refresh

```text
agent.activity.updated
  -> continuous message_update versions batch mutable snapshots inline
  -> a version gap or recovered connection triggers authoritative message reconcile
  -> turn_update / interaction_update triggers authoritative session reconcile
  -> legacy state_patch triggers authoritative state reconcile
  -> live reconcile dispatches session/upserted then turn/upserted
  -> historical pull dispatches session/snapshotReceived
  -> engine projection updates the runtime snapshot
  -> conversation list projection updates rail
  -> detail controller reconciles UI-local paging/loading state
  -> shared transcript projection updates rows/cards
  -> AgentGUINodeView renders the new view model
```

Only continuous versioned `message_update` payloads use the inline fast path.
Turn, interaction, and state changes reconcile through the authoritative session
endpoint so `activeTurnId`, pending interactions, and turn provenance stay
consistent. UI code should debug both the event payload and the reconcile fetch
before treating a missing transcript row as a rendering-only bug.

Live display-only clocks in transcript rows, such as running sub-agent elapsed
time, are UI-local interaction state. Do not derive a running timer solely from
`latestActivityAt - startedAt`: `latestActivityAt` only changes when a durable
activity event arrives, so quiet but still-running work will appear frozen.
Running rows that need wall-clock elapsed text should own a local tick, while
completed, failed, or canceled rows should render a fixed terminal duration
from terminal/latest activity timestamps.

When a session status bug mentions "still processing", "queued", or a disabled
composer after a turn finishes, inspect the full runtime tuple:
`status`, `currentPhase`, and `turnLifecycle.phase`. The Agent Activity snapshot
may carry lifecycle status such as `active` while the visible state is derived
from `currentPhase` or turn lifecycle. Projection layers that bridge into legacy
Host DTOs must normalize the tuple together, or `active/idle` and
`active/working` sessions will render as the wrong conversation state.
Daemon terminal turn reports must settle the tuple atomically: clear
`turn.activeTurnId` and `turnLifecycle.activeTurnId`, set
`turnLifecycle.phase` to `settled`, set `currentPhase` to `idle`, and replace an
`active_turn` submit block with `submitAvailability.state = "available"`.
Message Center and AgentGUI should keep AgentActivityRuntime as the source of
truth instead of guessing that a completed turn with stale active-turn fields is
safe to treat as finished.

`submitAvailability` on the wire is host authority, while
`deriveSubmitAvailability` is a compatibility guard for missing or stale
derived block reasons. Consumers that make decisions (queued-prompt drain,
composer busy) should call `resolveSubmitAvailability` from
`@tutti-os/agent-activity-core`: an explicit wire `available` stays available,
unknown wire block reasons stay blocked, and locally derived `active_turn`,
`waiting`, or `background_agent` blocks fill the remaining gaps. A settled
turn lifecycle is terminal even if an older runtime forgot to clear
`activeTurnId`; hosts should still clear it when settling a turn. The Go/TS
derivations are pinned to each other by the parity tables in
`packages/agent/daemon/runtime/submit_availability_parity_test.go` and
`packages/agent/activity-core/src/selectors.test.ts`.
When a runtime snapshot regresses after a terminal turn, first inspect
`agent.activity.reconcile.trace` for the exact source that upserted the older
session state. Reconcile fixes should target that owner and ordering path; do
not add broad UI-side stale-active-turn exceptions that hide an upstream state
or reconciliation bug.

When the visible symptom is a sticky error badge on a rail row, dock preview, or
message-center trigger, also inspect the latest loaded turn messages. A
session-level `failed` status can be historical after a later turn starts or
completes. Outer status badges should keep authoritative non-error lifecycle
states, but when the outer projection is `failed`, they should let the latest
turn's message status clear or confirm that failure. Keep unrecoverable
activation/resume failures session-scoped; keep ordinary historical turn
failures on the transcript row that produced them. A terminal
`AgentActivityTurn.error` is authoritative even when the provider emitted no
assistant error message. The shared transcript projection must attach that
error to the exact `turnId`: reuse an existing structured visible-error
message, upgrade a matching plain assistant failure, or create one view-only
error row keyed by `(agentSessionId, turnId)`. That fallback row is derived
state, not a durable message or a replacement session-level `lastError`.
Engine selectors for session operation errors must never fall back to active or
latest Turn errors. Likewise, a successful create/attach response remains an
attached session even when its initial or historical Turn failed; activation
failure must come from the activation operation itself, not from Turn outcome.

### Message Parsing And Rendering

```text
AgentActivityMessage payloads
  -> AgentSessionEngine merge/dedupe by message identity/version
  -> sessionMessagesById snapshot bucket
  -> shared/agentConversation/projection
  -> transcript rows, tool calls, plans, approvals, interactive prompts
  -> AgentConversationFlow inside AgentGUINodeView

AgentActivityTurn.error
  -> shared transcript projection, reconciled with message errors by turnId
  -> one fallback visible-error row on the owning Turn when messages lack one
```

Message parsing belongs in shared projection/model helpers. React components
should render projected rows and fire actions. They should not own provider
message semantics, merge keys, prompt status resolution, or durable message
dedupe.

Transcript `message_update` events that reach `AgentActivityRuntime` are a
normalized runtime contract. Each transcript message must already carry a
stable `messageId`, positive `version`/`seq`, stable `turnId`, and positive
`occurredAtUnixMs`. Provider, adapter, desktop, or daemon ingestion layers must
derive missing turn/time data from real active-turn, submit-context, lifecycle,
or storage timestamps before AgentGUI sees the event. If a transcript message
has no reliable `turnId`, the boundary must reject it instead of synthesizing a
`message:<messageId>`, `seq:<seq>`, or similar ownership fallback. AgentGUI
must not retarget optimistic prompts from turnless or untimestamped live
messages.

Codex app-server child-thread rows belong to a subordinate child session and
must stay out of the root transcript. AgentGUI projects that session only under
the delegation card named by its immutable parent tool-call relation. Spawn-card
success means only that delegation started successfully; child terminal state
comes from the child's canonical turn. Wait/close tool output and transcript
markers are display data, not lifecycle authority.

### Layer Ownership Summary

| Layer                                    | Owns                                                                                                                | Must not own                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tuttid` agent service                   | provider runtime start, exec, resume/cancel, validation, persistence reports                                        | AgentGUI view state                                                                        |
| `ActivityProjection`                     | persisted session/message projection and `agent.activity.updated` publication                                       | React projection or local UI overlays                                                      |
| desktop `WorkspaceAgentActivityService`  | activity facade, canonical engine/controller access, mutation/reconcile coordination                                | transcript rendering semantics or large query/import adapters                              |
| desktop activity query/import operations | normalized daemon query projection and external-session import refresh workflow                                     | engine/controller ownership or independent activity state                                  |
| `AgentActivityRuntime`                   | AgentGUI-facing source of durable activity data and commands                                                        | independent session/message storage                                                        |
| workspace `AgentSessionEngine`           | canonical frontend session/turn/interaction entities, pending intents, ephemeral prompt queues, correlated commands | daemon persistence or provider transport implementation                                    |
| AgentGuiNode vertical controllers        | selection, drafts, UI-local paging/loading/error state, and typed engine intent dispatch                            | authoritative session/message state, pending intents, queued prompts, or provider strategy |
| shared projection/model helpers          | deterministic conversion from snapshots/messages to view models                                                     | provider transport calls                                                                   |
| React views                              | DOM interaction and rendering from `viewModel`/`actions`                                                            | fetching or mutating durable activity directly                                             |

The standalone Agent window follows the same composition rule: the sidebar
shell owns panel selection, width, and mount timing; file/app/message routing,
BrowserNode lifecycle, and TerminalNode lifecycle live in focused panel
components. Extracting those panels must not move Message Center session state
or terminal/browser runtime state into the shell.

## User-Visible Interaction Contracts

Use this section when the bug report is phrased as a visual symptom: "why is
this selected", "why is this loading", "why did the row move", "why is the send
button disabled", or "why is an approval still visible". Every visible AgentGUI
state should map to one owner and one clearing condition.

### Rail And Conversation List

```text
runtime snapshot sessions
  -> conversation list query/search/project filters
  + engine pending-intent projections
  + daemon section membership ids/cursors/totals
  -> pure rail display overlays
  -> activeConversationId highlight
  -> row status, title, project, timestamp, badges
```

User-visible rules:

- The rail row list is projected from canonical engine sessions plus
  daemon-owned section membership ids and engine-owned pending intents. The
  controller query owns requests and ID-only pagination state; the pane owns
  only search, collapse, and visible-item UI state. Pending rows are
  presentation values, not a second list store or pagination-cache membership.
  Do not fetch or mutate durable session state from a row component.
- The selected row is controlled by `activeConversationId`, not by latest
  runtime update time.
- Search and project grouping are list-query concerns. Desktop search is a
  backend, target-scoped, cursor-paged query across all visible sessions; its
  results are engine entities joined through ID-only query state. These queries
  may hide a session from the rail, but must not delete or unactivate it.
- Conversation search matches only the user-visible session title. Session ids,
  providers, and working directories are routing or runtime metadata and must
  not produce title-search results.
- Conversation target filters are also list-query concerns. The All rail filter
  applies no `agentTargetId` constraint; provider target rail filters such as
  Codex and Claude Code match sessions by `session.agentTargetId`, not by
  `session.provider`. Filter normalization and list projection helpers must not
  mutate workbench node `provider`, provider target fields, composer drafts,
  desktop default provider, or composer-default preferences. All-filter clicks
  must only clear the `agentTargetId` constraint. Provider target rail clicks
  may update the home composer launch target only when there is no active
  conversation; active conversations keep owning their displayed target until
  the target-filtered list initializes. If that target list is empty, AgentGUI
  should unactivate the current conversation and show the selected target's
  new-conversation empty composer. React view components must not dispatch
  separate filter and home-composer target actions for one rail click.
  Apply them only for multi-provider conversation scopes. Single-provider
  panels should let the node provider constrain the query and collapse target
  filter actions back to All in the controller.
- A pending create row can appear before the daemon-created session is
  authoritative. It must be replaced by the authoritative session or removed on
  create failure.
- Working/error/attention badges should come from session status, pending
  interactive/approval projection, or explicit local pending state. Do not infer
  them from row text.
- Error badges are current-state indicators, not session-history indicators. If
  a session still reports `failed` but loaded messages show a newer successful
  or running turn, list/dock/message-center projections should follow that
  newer turn instead of keeping the whole session red forever.

### Conversation Titles Across Surfaces

```text
runtime snapshot session
  -> canonical session.title from the daemon
  -> rail row / detail header / workbench header / dock popup / toast title
```

User-visible rules:

- `session.title` is canonical plain text. New empty sessions keep it empty;
  provider/Agent Target names are not conversation titles. The first accepted
  user submit establishes it through an exact compare-and-set against the title
  observed by the submit service, in the same controller event/report batch as
  the submitted turn. Localized `Untitled conversation` is presentation only.
- Normal first submit creates the session and executes its initial prompt in one
  daemon request. Independent empty-session creation remains available for
  prewarming/recovery; clients must not emulate first submit as create-then-send.
- SQLite migration may recognize historical provider/Agent Target placeholders,
  backfill them from the earliest visible user message, or clear message-less
  placeholders without changing session timestamps. This classifier is
  migration-only; live submit must not guess whether a target name is a title.
- CLI, message-center, notification, Dock, and desktop identity surfaces consume
  `session.title` directly. The active workbench detail header has one
  presentation-only exception for a first prompt containing task, session, app,
  file, or Agent references: it may render that canonical prompt as readonly
  mention chips plus adjacent prompt text only while its normalized,
  length-capped title still equals `session.title`. The AgentGUI conversation
  rail continues to render the provider icon and canonical plain title, and may
  insert exactly one monochrome marker for the leading supported reference kind.
  When that marker is present, it replaces the structural meaning of the
  canonical title's first `@`, so the rail-only title presentation omits that
  one prefix without mutating the stored title.
  Browser-element and other custom mentions do not produce this marker. The
  rail derives the marker from a stable selector containing only each session's
  first user prompt, or from a pending new-session activation. Assistant
  streaming must preserve the selector result identity without copying or
  sorting complete histories. Separately, browser-element mentions never appear
  in the conversation rail title: while the canonical title still matches the
  first prompt, the rail removes every browser-element mention and keeps only
  the remaining user text. The detail/workbench header instead renders the
  registered browser-element card beside that text, without exposing its raw
  `@img`/DOM-tag title label. The header titlebar itself remains present, and the
  stored `session.title` is unchanged. Explicit renames and title clears stop the
  projection. Other title consumers must not reconstruct titles from transcript
  messages, parse Markdown again, or add mention prefixes. The detail rich-title
  projection remains one clipped line and must not wrap into a taller titlebar.
- Live runtime snapshot data is the source for workbench and dock titles. Do
  not persist or restore `lastActiveConversationTitle` from workbench node
  state.
- Workbench headers and dock identity projections must subscribe to the same
  workspace `AgentSessionEngine` used by AgentGUI. A render-time
  `engine.getSnapshot()` read is not a reactive binding: session metadata such
  as `title` does not change Workbench node state and therefore does not bump
  its external-state revision. Use the shared engine selector and title
  projection so rail, detail header, workbench header, and dock refresh from
  one canonical update.
- User rename flows must mutate the persisted runtime session title through
  `AgentActivityRuntime.renameSession` and then upsert the returned
  authoritative session into the runtime snapshot. Do not update only the rail
  list, otherwise the rail row, active detail header, workbench title, and dock
  surfaces can diverge.
- Provider adapters must not synthesize prompt-derived title events. Initial
  title derivation belongs to the shared service/runtime submit boundary.

### Detail Pane And Transcript

```text
activeConversationId
  -> session view state
  -> message loading / detail error / live state
  -> sessionMessagesById snapshot bucket
  -> shared transcript projection
  -> skeleton, empty state, transcript rows, prompt cards
```

User-visible rules:

- Transcript message bodies and copy payloads retain their rich-text
  serialization. Compact presentation derived from those messages, including
  the user-message locator, activity summaries, and tooltips, converts rich
  links to human-readable labels in the frontend projection without mutating
  the source message. This display formatter is separate from session-title
  canonicalization: new and migrated `session.title` values remain daemon-owned
  plain text and must not depend on renderer parsing.
- A row can be selected while its transcript is still loading. Treat rail
  selection and detail message loading as separate states.
- Transcript rows are projected data. Rendering components should not parse
  provider-specific payloads ad hoc.
- The "processing" row in the transcript represents turn/progress projection.
  It is not the same state as the new-session activation loading button.
- Detail errors should be tied to the active session and cleared when a new
  active session is selected or a retry begins.
- Auto-scroll, bottom anchoring, and pending-row placement are visual behaviors
  layered on top of projected rows; they must not affect message merge/dedupe.
- Selecting a different conversation starts its detail timeline at the bottom.
  Scroll-position preservation applies only while the same conversation remains
  active, including streaming updates and older-history prepends.
- A newly selected conversation remains bottom-locked across skeleton, content,
  and virtual measurement geometry changes. Release that lock only for upward
  user scroll intent; layout-driven `scroll` events are not reader navigation.
- Keep the transcript virtualizer bound to the stable detail viewport while
  switching between short and long conversations. Clearing that binding for a
  short transcript forces a fallback render and a second height correction on
  the next long transcript.
- Reveal a selected-detail skeleton only after 300 ms. A coherent target
  timeline still commits immediately when it becomes available; fast local
  loads briefly retain the previous timeline instead of flashing a skeleton.
- The retained timeline is a non-interactive transition frame. Lock detail
  interaction, including composer submission, until the selected conversation
  timeline is coherent; do not rewrite engine submit/queue capabilities for
  this presentation-only interval.
- While that previous timeline remains visible, it also retains scroll
  ownership. Changing the rail's active conversation alone must not bottom-dock
  or otherwise mutate the retained timeline. Scroll ownership transfers to the
  selected conversation only when its skeleton or coherent timeline commits.
- Deferred bottom-anchor callbacks must revalidate the current conversation and
  near-bottom anchor when they execute. The user or a newer layout commit may
  move away from the bottom before an older animation frame runs, and that stale
  frame must not pull the transcript back to the bottom.
- Virtualized transcripts use end anchoring while measuring turn heights. A
  measurement correction must preserve a timeline that was already at the end;
  it must not surface as user scroll intent and disable later bottom docking.
- Complexity alone must not virtualize fewer than eight turn groups. With no
  meaningful off-screen window to elide, virtualization only replaces natural
  first-layout height with an estimate and adds a corrective layout pass.
- Transcript messages render as Markdown on their first visible render. Long
  messages must not expose raw Markdown source or a message-level loading
  placeholder before replacing it with formatted content; that intermediate
  layout changes row height and destabilizes timeline anchoring.
- Read-only user messages must also render their rich-text content on the first
  client commit. An empty editor shell followed by TipTap initialization changes
  every affected turn height after the virtualizer has measured it.
- A local composer submit is an explicit user navigation intent: after a normal
  or guidance prompt submit, the detail timeline should force one bottom scroll
  so the user's newly submitted message is visible even if the reader was
  previously in the middle of history. Streaming updates without a local submit
  should still respect the usual stick-to-bottom threshold.

### Composer And Send Button

```text
composer draft + activeConversationId
  -> provider/composer settings/options
  -> prompt content normalization and upload state
  -> can submit / disabled reason / sending state
  -> startConversation or executePrompt
```

An unsent composer message is one UI-local `AgentComposerDraftContent` block
array with exactly one leading text block. Text (including mention/skill
syntax), images, regular files, and pasted text belong to that same atomic
value; pasted text is a discriminated file block whose `kind` is
`pasted-text` and whose in-memory text field is always present. Attachment ids
and upload progress/errors remain UI metadata on their corresponding blocks.
Only the submit boundary converts this array to the existing
`AgentPromptContentBlock[]` runtime contract, so queue, runtime, daemon, and
persistence protocols do not own a second draft representation.

Draft content identity is independent from provider, model, and the other
composer settings. On the home composer, content is cached under one shared
scope (`home`) for every selected project, including no project. An existing
conversation uses `session:<agentSessionId>`. Switching providers or projects
on home therefore preserves the whole message; returning home from a session
restores the shared home draft instead of the session draft. Provider/target
default settings, session settings, optimistic setting updates, model
inheritance, validation, and fallback keep their existing ownership and keys;
project identity must not be added to those setting caches or to the home draft
scope.

Attachment upload work also owns the draft scope where it started. If the user
switches sessions (or leaves home for a session) before an image or pasted-text
upload settles, the completion or failure updates the latest draft in the
original scope by block id; it must not read attachment projections from, or
write results into, the newly selected scope. Switching projects on home does
not change draft scope. Derived attachment arrays used by the composer are
memoized from the atomic content value and synchronized together so rerenders
cannot overwrite an optimistic attachment update with an older projection.

Each composer submit records a lightweight snapshot of the source scope and its
full content array, correlated by `clientSubmitId`; existing-session sends also
record the destination session because a recovered submit can send a home draft
to a previously active session. A successful first-message activation clears
its home scope; an accepted/confirmed existing-session send, including a queued
or recovered send, clears its recorded source scope. Failure or an uncertain
state retains the draft. Before clearing, the controller compares the complete
current array with the snapshot, including attachment upload metadata, so edits
made while a request is pending are retained as one new message. Terminal
results, immediate engine rejection, and conversation deletion discard
snapshots that can no longer resolve. Non-composer control sends must not
participate in this draft cleanup.

Goal set, pause, resume, and clear operations must use the runtime goal-control
API rather than `executePrompt`. A goal control is thread metadata, not a user
turn: it must not create a transcript message, pending submit, or pseudo turn.
When a provider adapter must carry clear through a native command turn, it must
retain that internally generated turn identity and suppress the turn's native
assistant/thinking acknowledgement before durable transcript projection. This
filter is semantic and turn-correlated: do not match provider copy such as
`Goal cleared:`, hide it only in the renderer, or reparent it into the turn
that clear interrupted. Goal/session updates and internal terminal handling
still flow normally.
Clearing a goal may leave the current turn running; the composer stop control
and transcript processing row therefore continue to derive from that canonical
active turn. Successful clear feedback is a transient localized toast, not a
durable timeline item. AgentGUI-scoped feedback must use a viewport positioned
relative to the detail content container, so conversation-rail width does not
shift its visual center. Its colors must use the UI System themed surface,
foreground, and border tokens rather than the intentionally inverted neutral
toast tokens, so light mode stays light and dark mode stays dark.

User-visible rules:

- Home composer submit with no active conversation starts activation. Detail
  composer submit with an active conversation sends input. First-message
  activation immediately enters an optimistic conversation so the submitted
  message is visible while the backend session is being created. Failure
  removes that optimistic conversation and restores the submitted home draft.
- New-conversation entry points that return the user to the home composer,
  including workbench header or external workbench events, should also issue a
  composer focus request so the empty input is ready for typing immediately.
  Their navigation affordances remain available while another session is being
  created; agent-target availability may block submit, but another session's
  activation or turn lifecycle must not block opening a new draft.
- Treat active-session refs as controller caches, not the source of truth for
  whether a submit is new or existing. React effect cleanup, projection reloads,
  and conversation-list refreshes may temporarily disturb UI-local refs; they
  must not retarget the user's prompt to a newly created session.
- The send button spinner is local submit/approval response state. For
  first-message activation, the spinner and optimistic transcript are the
  normal pending indicators. The "connecting conversation" state belongs to
  existing-session activation/recovery. The transcript processing row is
  runtime turn state.
- Model, permission, plan mode, reasoning, speed, project, branch, prompt image,
  file mention, and skill/capability controls must read from composer settings
  and provider options. They should not be reconstructed from transcript rows.
- Reasoning options are model capabilities, not provider-wide constants. The
  daemon model catalog must preserve each model's advertised effort values and
  default, pre-session composer options must use the selected model's catalog
  entry, and active sessions must prefer the runtime's current model-specific
  options. Compatibility projections that only know persisted settings must not
  synthesize a full reasoning catalog. Composer-option cache freshness must
  include the requested settings as well as target and cwd, and an active model
  change must reload options with the active session settings. ACP owns option
  values and ordering; the relevant locale catalog owns user-visible labels and
  descriptions, including when live runtime options are the fresher source.
  When a provider does not advertise configurable reasoning (for example
  Cursor, which embeds effort inside parameterized model ids), the composer
  must clear draft/default `reasoningEffort` for that target and must not
  render a stale effort label next to the model trigger.
- Shift+Tab plan mode is a provider capability, not a frontend allowlist. The
  daemon's typed pre-session composer capabilities and typed live session
  capabilities must both advertise `planMode` before AgentGUI enables the
  toggle for a provider.
- The slash palette opens immediately when an initial composer capability
  request is in flight, even before selectable entries exist. The capability
  section renders a non-selectable loading row driven by the activity snapshot
  request lifecycle; it must not infer loading from an empty catalog.
- Browser/computer capability controls come from daemon composer options and
  live runtime capabilities. `computerUse` must not be advertised or injected
  unless the daemon can reach the local `cua-driver` and its read-only
  `permissions status --json` reports Accessibility and Screen Recording are
  granted. Installed/authorization UI is the setup surface and should guide
  missing macOS grants in order. It may try CuaDriver's grant command, but must
  keep that call single-flight and bounded by a timeout because macOS may not
  re-show TCC prompts after a denial. When prompts are unavailable, the UI should
  open the matching System Settings privacy pane and poll read-only status until
  the permission state changes. Runtime tool startup must fail fast on missing
  permission state instead of triggering CuaDriver authorization prompts. Treat
  `screen_recording=true` with `screen_recording_capturable=false` as a CuaDriver
  capture-availability problem, not as a promptable Screen Recording grant.
  Permission setup is a user-driven, linear five-step wizard (install → grant
  Accessibility → grant Screen Recording → check again → done). Guiding the
  user's own actions is primary; status reads are auxiliary (per-step chips
  and the initial-step guess) and must never gate navigation, because every
  status source is unreliable in some window: `AXIsProcessTrusted` is cached
  per-process (a fresh Accessibility grant stays invisible to the running
  daemon), Screen Recording capturability freezes per-process, and toggling
  Screen Recording kills the daemon outright. The grant command
  fires-and-forgets only behind the user's explicit "Open Settings" click —
  its only job is registering CuaDriver in the privacy panes and raising the
  TCC prompt when macOS still shows one, and because the CLI may open windows
  of its own it must never run on step entry; it is never awaited and never
  becomes a blocking operation. The "check
  again" step reconciles unconditionally: it always restarts the daemon
  (`cua-driver stop`, relaunch the app bundle via `open -g -a` so the daemon
  keeps its own TCC identity, then short-poll read-only status), which clears
  every staleness at once, and passes `force` so a still-confirming grant
  cannot make it hang. The restart itself must never call the grant command —
  grant waits on TCC confirmation and would hang a fresh install; prompting
  stays exclusive to the single-flight grant flow. Completing an install
  advances the wizard straight into the first grant step. Status reads
  in the Electron main process are coalesced so overlapping polls share one
  subprocess, and the renderer re-checks on window focus/visibility and keeps
  polling while the permission dialog is open and unauthorized.
- User composer defaults are owned by desktop preferences. AgentGUI may request
  a defaults write from the home/new composer path or after an explicit user
  selection in an active session, through an explicit host callback.
- Lab-mode AgentGUI affordances are desktop-preference driven through generic
  feature flags. AgentGUI must not receive experiment-specific props or create
  git worktrees itself; new experiments should add a desktop feature-flag
  catalog entry and keep any product-specific behavior in the owning desktop or
  daemon layer.
- Home/new composer defaults, overrides, options, and draft settings are keyed
  by a directory-resolved `agentTargetId`. They have no provider-keyed fallback,
  so two targets under the same provider cannot share model, permission,
  reasoning, speed, or draft state by accident.
- Active session settings are session state. Opening or restoring an active
  session must not promote its settings into user defaults. An explicit model,
  permission, reasoning, or speed selection updates both the session and that
  target's defaults so the next new conversation inherits the user's choice.
- Workbench node `composerOverrides` are UI-local home/new composer draft state,
  not an authoritative source for desktop preferences.
- Draft clearing happens only after the submitted content still matches the
  current draft. Do not clear a draft that the user edited while a send was in
  flight.
- Display prompt is for user-facing echo/title when content is collapsed or
  bundled. Expanded prompt blocks remain the runtime command input.

### Provider Environment Setup

Provider setup state follows the same service/store/controller/view split as
other desktop feature orchestration:

- `@tutti-os/agent-gui` owns the pure setup flow and i18n-agnostic view model in
  `shared/agentEnv`.
- The public `agent-env` subpath remains React-free so desktop Node tests and
  orchestration can consume setup logic. Shared Dialog/step presentation is
  exported separately through `agent-env-ui`.
- Desktop owns `agentEnvWizardStore`, `agentEnvWizardController`, and
  `useAgentEnvWizard`; these subscribe to the provider-status service, dedupe
  per-open automatic actions, and coordinate anomaly reporting and progressive
  reveal.
- `AgentEnvPanel` subscribes and renders. It must not duplicate readiness
  detection, installation, login, or reporting workflows in React effects.
- Agent Target runtime setup failure notifications follow the same boundary: a
  React-free notification controller detects the current action's
  running-to-failed transition and emits one semantic event; the component only
  localizes that event and forwards it to the host toast capability. Historical
  failed actions initialize controller state without replaying a toast.

The provider-status service remains the source of truth for installed,
authenticated, network, and active-action state. Wizard-local state is
ephemeral presentation state and resets with the panel lifecycle.

### Busy Queued Prompts

Busy-session queued prompts are AgentGUI-owned ephemeral interaction state. They
live in the workspace `AgentSessionEngine` prompt-queue reducer, not in
Workbench node snapshots, daemon session/message persistence, UI-local query
caches, or a second server-side queue. Queue identity is the
engine workspace identity plus `agentSessionId`, so every AgentGUI surface using
the same injected workspace engine observes the same queue.

Queued prompts are session-scoped user intent, not active-detail UI state.
React controllers may dispatch typed queue intents and render selectors, but
must not decide provider strategy, call provider transports, or maintain a
parallel queue. The engine claims one head prompt with an in-flight command ID;
command result correlation and uncertain-delivery state prevent duplicate sends
when acknowledgements, timeouts, and authoritative activity events race.

Drain readiness comes only from canonical session/turn entities. A normal queue
head sends when availability becomes `available`. A send-now prompt is resolved
from runtime capabilities: native active-turn guidance may send while the exact
turn remains blocked; cancel-then-send records the selected prompt as
`sendNextPromptId`, issues an exact `turn/cancel`, and sends a normal prompt only
after the cancel result validates or the canonical turn settles. Metadata-only
session patches and locally inferred idle states cannot unlock the queue.

`sessionLifecycleReducer` is the only reducer that interprets session, turn,
and interaction lifecycle. The prompt-queue reducer must not derive readiness
from raw `session/snapshotReceived` or `session/upserted` payloads, retain a
snapshot-derived availability field on queue records, or maintain a parallel
timestamp/activity clock. `rootEngineReducer` performs command validation and
send-now strategy precomputation against the old state, reduces lifecycle
first, then passes the post-lifecycle canonical session/turn/interaction view
into the queue reducer. After the queue applies its own intent transition, it
drains each affected session deterministically from that canonical view.

A successful queued send first writes its validated authoritative session and
exact turn into canonical lifecycle. The queue keeps only the exact turn id
needed as a delivery barrier; it does not copy turn phase or availability. If a
timed-out send is confirmed by a durable message before lifecycle reconcile,
the confirmation must carry a non-null exact `turnId`. The queue removes the
uncertain delivery only after recording that barrier, and no later prompt may
drain until canonical lifecycle contains the same turn in `settled` phase. A
confirmation without an exact turn id leaves delivery uncertain and cannot
authorize an inferred-idle resend.

A pending submit confirmation deadline is not a queue-wait deadline. While the
same `clientSubmitId` still has a queue-owned delivery that has not failed or
entered uncertain delivery, expiry rolls the confirmation window forward
instead of marking the submit failed. An explicit `queue/sendPrompt` failure
still fails the submit immediately, while a timed-out delivery keeps its
uncertain reconciliation and terminal expiry behavior.

A user stop is an intent, not just a turn cancel: `interruptCurrentTurn`
dispatches one provider-neutral `session/stopRequested` intent. The engine
atomically suspends the session's prompt queue (`suspendReason: "user_stop"`),
aborts any matching activation command, and requests or awaits exact-turn
cancel. The drainer therefore cannot fire the next queued prompt the moment the
session becomes available. Only an explicit user send lifts the hold — composer
submit resumes the queue, and a send-now intent clears the suspension in the
queue core. The send-now cancel path never suspends: intent is captured at its
source, never inferred from the cancel outcome.

Queue suspension must also remain visible in the presentation projection.
AgentGUI controllers map the queue record's `suspendReason` to the internal
`queueStatus` (`active` or `paused_by_user`) and carry it through the composer
view model. React queue components render that projection directly; they must
not infer a paused queue from cancel request state or turn settlement. A paused
queue keeps its count, expansion, edit, delete, and send-now controls available,
and returns to the ordinary queued label as soon as the queue core resumes it.

Reducer transitions that resume and then enqueue are compositional: the final
state and every command from both stages must be preserved. In particular, a
normal submit after a user stop sends the existing FIFO head and appends the new
prompt at the tail; it must not retain an `inFlight` claim after dropping the
corresponding `queue/sendPrompt` command. Send-now continues to use its atomic
promotion transition so it clears suspension, preserves priority semantics, and
emits only one delivery command.

Preview-mode AgentGUI surfaces are read-only for this runtime: they may render an
existing queue if injected into the same context, but they must not enqueue,
send now, edit, or delete queued prompts.

Collapsed queued-prompt summaries own truncation disclosure for the whole row.
Mention chips inside a queued summary keep their presentation and link behavior
but do not use independent hover highlighting or open mention tooltips. When the
rendered row actually overflows, one row-level tooltip shows the complete prompt
as plain text; rows that fit do not show that tooltip.

Queued prompt previews must treat prompt image blocks as the same send contract
used by the composer and runtime: an image may be inline `data`, a staged
`path`, or an HTTPS `url`. Do not cast queued images to data-only blocks or build
thumbnail URLs from `image.data` without checking it. URL-backed queued images
must preserve the structured URL through edit and submission and may use it
directly for preview; they must not hydrate it through the prompt-asset reader.
Path-backed queued prompt thumbnails should use the activity runtime
prompt-asset reader when workspace/session context is available, and otherwise
avoid rendering a broken image while keeping the queued content unchanged for
sending.
Their async reader has an explicit request owner keyed by runtime,
workspace, session, queue item, attachment/path, MIME type, name, and URL/data
identity. Context changes cancel the old logical request, and late results must
not update the current preview. DOM callback refs and element connectivity are
not request lifecycle or cancellation primitives.

### Approval And Ask-User Prompts

```text
runtime message/state projection
  -> pendingApproval / pendingInteractivePrompt
  -> inline card + bottom dock attention
  -> submitInteractive or plan-decision sendInput
  -> runtime event update
  -> answered/superseded prompt filtered from UI
```

User-visible rules:

- Approval/ask-user cards are attention surfaces, not composer drafts.
- The same prompt may appear inline and in a bottom dock. Both surfaces must
  share request identity and submitting state.
- For a child prompt, identity is the exact
  `(agentSessionId, turnId, requestId)` tuple. AgentGUI may aggregate the prompt
  into the selected root conversation, but submission must target the child
  tuple; the runtime uses the root session only to locate the shared live
  provider connection.
- Answering a prompt should clear or supersede every visible surface for that
  request ID after the runtime update lands.
- Plan approval decisions can translate into settings updates and/or
  follow-up `sendInput`; do not assume every approval uses only
  `submitInteractive`.

### Loading State Taxonomy

| Visible state                  | Primary owner                       | Starts when                                                                            | Clears when                                                                    |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Rail skeleton or empty loading | conversation rail query controller  | runtime list load starts                                                               | list load resolves or errors                                                   |
| Selected detail skeleton       | session detail transport/controller | active session messages load starts                                                    | `listSessionMessages` resolves or active session changes                       |
| Home first-create busy         | active session activation record    | home `startConversation` begins                                                        | that new-session activation succeeds, fails, or is abandoned as stale          |
| "Connecting conversation"      | existing-session activation         | existing session open/retry calls `activate`                                           | activation succeeds, fails, or is abandoned as stale                           |
| Transcript processing row      | transcript/session projection       | runtime reports working/turn phase                                                     | runtime reports ready/completed/failed or newer message projection replaces it |
| Send button spinner            | controller local submit state       | `executePrompt` or approval submit begins                                              | command promise settles                                                        |
| Composer settings loading      | composer options/settings model     | provider options load starts or settings source missing                                | options/settings resolve or fallback state is applied                          |
| Provider setup notice          | desktop provider status adapter     | captured provider status says the active provider is not ready after a settled recheck | captured status says provider is ready or user fixes setup                     |
| Approval response spinner      | controller approval submit state    | prompt/approval option submit begins                                                   | runtime command settles and prompt projection updates                          |

When a loading state is wrong, first identify which row in this table is
visible. Then debug that owner and clearing condition. Avoid moving a spinner
between surfaces to hide a state-source mismatch.
Desktop restore must not project "not ready" from an uncaptured provider-status
snapshot. Provider setup readiness owns only the empty new-conversation surface,
where it gates creating a session for the selected target. An active session is
owned by its canonical runtime/session recovery state; provider catalog probes
must not block its composer or render a setup notice. Desktop may refresh stale
provider status for the empty surface, but that catalog reconciliation must not
become a second active-session readiness model.

### Error, Retry, And Recovery

```text
runtime/command error
  -> controller reports diagnostic
  -> detail error or failed conversation projection
  -> retry path if resumable/retryable
  -> activation or message reload
```

User-visible rules:

- Failed new-session activation may keep a visible failed conversation so the
  user can understand where their prompt went.
- Non-resumable sessions or non-retryable resume errors should not offer a
  retry path that silently creates another session.
- Deleted or filtered sessions should clear selection only through the
  selection fallback path; do not let a hidden row leave a stale detail pane.
  User-confirmed deletion of the active session must commit that fallback
  selection before dispatching the runtime deletion that tombstones the old
  session. Do not suppress authoritative `not_found` presentation to hide a
  selection/tombstone ordering bug.
- Event-stream disconnect should not erase current transcript state. It should
  make live freshness uncertain until reconciliation succeeds.

### Visual Debug Checklist

For every AgentGUI visual bug, answer these before editing:

1. Which surface is wrong: rail, detail transcript, composer, approval/prompt,
   bottom dock, settings menu, project selector, or provider status?
2. Is the visible state from authoritative runtime data, projection, or a
   local overlay?
3. What starts the visible state, and what exact event/promise/fetch clears it?
4. Does the visual state survive selection changes, search filters, and stale
   async results correctly?
5. Which neighboring surface should update at the same time?

## UI Rendering Chain

The node UI is intentionally split into a shell, controller, view model, and
view:

```text
AgentGUI
  -> AgentGUINode
     - node chrome
     - labels/i18n assembly
     - rail layout and workbench frame props
     - provider status presentation props
  -> useAgentGUINodeController
     - subscribes to runtime snapshot
     - owns selected conversation and UI-local state
     - calls runtime commands
     - returns { viewModel, actions }
  -> AgentGUINodeView
     - renders rail, timeline, composer, menus, approval/prompt surfaces
     - owns DOM/UI-only state such as picker open state and resize interaction
  -> shared/agentConversation/components
     - renders transcript rows, tool calls, tasks, plans, approvals
```

`AgentGUINodeView` may use host capabilities for UI affordances such as file
references, workspace reference picker actions, and link actions. It must not
become a durable activity data source.

## Folder Guide

Use this map before editing:

| Path                                                                                                        | Layer                                 | Notes                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/activity-core/src/**`                                                                       | Durable activity core                 | Host-agnostic adapter/controller/types. No React, Electron, or desktop clients.                                                                                            |
| `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts` | Desktop activity facade               | Owns engine access, mutation/reconcile coordination, event handling, and local optimistic service behavior; focused query/import collaborators own those daemon workflows. |
| `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`      | Runtime adapter                       | Wraps the desktop service into the `AgentActivityRuntime` interface and adds analytics/diagnostics.                                                                        |
| `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx`                | Desktop product adapter               | Assembles workbench state, desktop preferences, provider status, mention providers, file references, and passes props into `AgentGUI`.                                     |
| `packages/agent/gui/AgentGUI.tsx`                                                                           | Package entry UI                      | Thin provider composition: i18n, tooltip, runtime/host providers, `AgentGUINode`.                                                                                          |
| `packages/agent/gui/agentActivityRuntime.tsx`                                                               | AgentGUI runtime interface            | Public React/context interface for durable activity data and commands.                                                                                                     |
| `packages/agent/gui/agentActivityHost.tsx` and `host/agentHostApi.ts`                                       | Host capability interface             | Files, clipboard, account/user projects, workspace helpers, probes, persistence. Legacy session APIs are not production data sources.                                      |
| `packages/agent/gui/workbench/**`                                                                           | Host-agnostic workbench integration   | Dock entries, launch descriptor, provider mapping, workbench node state helpers. Desktop still owns product-specific body rendering.                                       |
| `packages/agent/gui/agent-gui/agentGuiNode/controller/**`                                                   | Node controller implementation        | UI orchestration, command sequencing, and rail section query lifecycle. Prefer focused helper files over growing the main hook.                                            |
| `packages/agent/gui/agent-gui/agentGuiNode/model/**`                                                        | Node model and policy                 | Pure status, provider, settings, draft, slash command, layout, project resolution, and conversation projection helpers.                                                    |
| `packages/agent/gui/agent-gui/agentGuiNode/agentRichText/**`                                                | Composer document layer               | Tiptap document, mentions, tokens, IME, prompt images, serialization helpers.                                                                                              |
| `packages/agent/gui/agent-gui/agentGuiNode/AgentGUINodeView.tsx`                                            | Node view                             | Renders the rail/detail/composer and owns DOM-only state. Keep data fetching out.                                                                                          |
| `packages/agent/gui/app/renderer/i18n/locales/*.agentGui.ts`                                                | AgentGUI locale vertical              | Owns the complete `agentHost.agentGui` dictionary per locale and composes smaller provider/runtime/slash fragments internally.                                             |
| `packages/agent/gui/shared/agentConversation/**`                                                            | Transcript module                     | Reusable contracts, projection, rules, and rendering components shared by AgentGuiNode, Message Center, and standalone conversation rendering.                             |
| `packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/**`                   | AgentGUI conversation-list projection | Engine selector boundary despite the legacy path name. Projects canonical sessions plus engine-owned pending intents; owns no durable or local pending store.              |
| `packages/agent/gui/contexts/workspace/presentation/renderer/agentSessions/**`                              | Session detail paging hooks           | UI-local older-page transport, loading, and error state; canonical messages and optimistic prompts remain engine projections.                                              |
| `packages/agent/gui/agent-message-center/**`                                                                | Message center surface                | Consumes activity/prompt projections to show attention items outside the full node.                                                                                        |
| `packages/agent/gui/agent-conversation/**`                                                                  | Standalone transcript export          | Reuses the same detail-to-conversation projection and transcript components without the full node.                                                                         |

## Layering Invariants

- Durable session and message state comes from `AgentActivityRuntime`, not
  component-local state.
- Host-specific transport, preload, `tuttid`, analytics, desktop preferences,
  and provider installation/login behavior stay in `apps/desktop`.
- `AgentHostApi` remains a host capability interface, not a second activity
  runtime.
- Projection helpers should be pure whenever possible; they convert snapshots,
  messages, timeline items, or session state into view models.
- UI-local hooks and controllers may cache paging and presentation concerns.
  Optimistic session/prompt intent remains in the engine and declares a
  deterministic reconciliation path.
- React views should render `viewModel` and call `actions`; controller or model
  helpers own sequencing and derived state.
- Package exports should stay narrow. Do not export an internal helper only
  because another package or test finds it convenient.

## Source Of Truth

### Agent Activity Data

`AgentActivityRuntime` is the AgentGUI source for activity data and production
commands. It owns or delegates:

- session list snapshots
- paged session messages
- live event retention and synchronization
- create, activate, unactivate, send input, cancel, interactive response,
  delete, pin, settings update, and composer option operations
- diagnostics through `reportDiagnostic`

Runtime capability declarations are also part of this contract. Missing
capability keys default to enabled for backwards compatibility. Hosts can set
`capabilities.canCancel`, `canSubmitInteractive`, `canGoalControl`, or
`canUploadAttachment` to `false` to hide and no-op the corresponding AgentGUI
UI affordance. `canUploadAttachment` applies to prompt attachment paths and
must not hide ordinary `@` references or workspace-reference mention
selection. Large pasted text also requires the explicit optional
`AgentActivityRuntime.stagePastedText` operation; generic file upload support
is not sufficient evidence that a host can persist in-memory text.
When `reportDiagnostic` is omitted, development builds use a low-cost console
sink for AgentGUI diagnostics such as composer upload/submit state, message page
requests/resolutions, render-state changes, and caught errors. Hosts can set
`devDiagnosticConsoleSink: false` to keep a development runtime silent;
production remains silent by default.

Production AgentGUI code should not call legacy `AgentHostApi.workspaceAgents`
or `AgentHostApi.agentSessions` as a list, timeline, message, or write source.
Use the runtime hooks and commands instead.

### Host Capabilities

`AgentHostApi` remains valid for host capabilities that are not the agent
activity data source:

- workspace file references
- clipboard
- runtime metadata and diagnostics outside the activity runtime
- account or user-project lookup
- local file picking, local file reading, and batch export helpers

### Agent Directory

AgentGUI distinguishes directory identity, launch authority, and runtime
provider metadata. The host must project its `/agents` snapshot into the public
`agents: AgentGUIAgent[]` prop. That array is the complete ordered UI directory:
AgentGUI must not synthesize provider-catalog entries, reorder by provider, or
replace a loaded-empty array with local defaults.

`agentTargetId` is the sole AgentGUI identity for selection, conversation
filtering, composer-option caches, workbench node state, and new-session
launches. The daemon resolves it against `agent_targets` and derives the
execution provider and runtime target reference from trusted target state.
Target-backed create requests may omit `provider`; if a request supplies both
`agentTargetId` and `provider`, the daemon rejects mismatches. Client-supplied
target-reference data must not override the daemon-derived launch data when
`agentTargetId` is present.

`provider` remains runtime metadata for provider-native composer behavior,
probes, capability checks, telemetry, and execution policy. It is not a UI
identity. AgentGUI must not group, deduplicate, name, icon, select, or cache
directory entries by provider. Multiple agents may share one provider and must
remain independently selectable by `agentTargetId`.

`agentTargetId` is a foreign key into the local target directory, not an opaque
identity supplied by a session. Session ingestion preserves an id only when it
resolves in `agent_targets`; a registered alias may be rewritten to its local
canonical id as defense in depth, while a definitive miss is cleared and the
original value is retained only in diagnostic runtime context. Shared-agent
owner-domain ids must be translated by the host projection layer before they
reach the caller's daemon. The daemon must not infer identity from
`providerTargetRef`, provider, or other session-carried metadata.

AgentGUI resolves active-session identity through the same directory. While the
directory is loading the composer stays neutral; after loading, an unresolved
target produces a session-scoped missing-agent state with a disabled composer
and read-only history. A legacy provider-only session resolves through the
registered `local:<provider>` target. This is still a directory lookup, not a
provider fallback.

Target-bearing launch and prefill requests follow the same foreign-key rule:
wait while the directory is loading, then require an exact `agentTargetId`
match. A missing explicit id must not fall back to a sibling that happens to use
the same provider or to the first directory entry.

The host directory port publishes an explicit `idle | loading | ready | error`
lifecycle. `ready` may contain an authoritative empty `agents: []`; `error`
retains the last successful directory while exposing the failure, and the
directory service—not a shell focus effect or React component—owns retry and
refresh policy. Workbench dock payload resolution, new-launch validation, body
rendering, and detached-window handoff must read the same live port snapshot.
They must not combine static `agents/agentsLoading` inputs with a second dynamic
resolver.

The public `AgentGUI` wrapper accepts that lifecycle snapshot as its single
directory input. Normalized `agentTargets`, their loading flag, provider-rail
mode/presentation, and the internal rail-empty slot are private node inputs and
must not remain writable alongside the public directory.

Detached-window bootstrap transport serializes the complete directory
snapshot, including lifecycle, capture time, presentation entries, and trusted
target presentations. The new window hydrates its local canonical directory
service before first paint, subscribes to that service, and refreshes the same
owner. It must not copy the bootstrap array into React state or infer loading
from `agents.length`/a missing timestamp. A failed or loading snapshot therefore
remains distinguishable from an authoritative ready-empty directory across the
window boundary.

The public directory entry owns its presentation and availability:

- keep `agents[].name` as the Agent name and `owner.name` as a separate owner
  identity; AgentGUI composes their localized shared-Agent label at render time
  so constrained lists can truncate only the owner while preserving the Agent
  name suffix
- render `agents[].iconUrl` as the primary identity and `owner.avatarUrl`
  separately as an ownership badge, including on the selected center item in
  the new-session carousel
- preserve host array order; normalization keeps the first valid occurrence of
  each `agentTargetId`
- use `availability.status` for ready, checking, coming-soon, install, login,
  and unavailable presentation
- show no aggregate `All` entry when exactly one agent exists
- show `All` plus the host-ordered rail and home carousel when multiple agents
  exist
- keep the multi-agent home carousel mounted when the selected agent changes;
  move the selected directory-owned node into the center without reordering the
  host array, including when the selected target enters or leaves a readiness
  gate; keep the carousel canvas outside the ready/gated body branch so its
  scroll position and animation are not reset; pin the overlaid carousel layer
  to the rendered placeholder slot and resynchronize it when the hero body
  resizes or the ready/gated subtree changes, so wrapped titles and growing
  composers cannot move beneath the records; size the WebGL canvas from integer
  layout dimensions instead of transformed bounds, and dissolve records beyond
  the immediate neighbours to avoid fractional edge seams; rotate the centered
  record by default, temporarily give playback to the record under the pointer,
  return playback to the current center when hover leaves, preserve each
  record's stopped angle when playback moves elsewhere, and fade records
  progressively by distance from the center while keeping the next outer record
  partially visible on each side; target
  changes should prime the wheel spring with an immediate directional impulse
  and avoid duplicate WebGL submissions from playback and wheel animation; use
  a shallow lit cylinder beneath the icon texture when rendering the record so
  thickness, rim reflection, and side perspective remain part of the same
  mounted Three.js scene instead of pre-rendered replacement assets; keep
  one-shot redraw and spring animation RAF handles separate so a pending resize
  or texture render cannot suppress a new interaction, let the spring frame own
  the single pose/render pass during movement, share record geometry, and cull
  repeated records outside the visible center range; start pointer-driven
  carousel movement on primary `pointerdown`, then suppress the matching click
  activation so the spring begins on press without double-selecting the target;
  selection updates the title, composer, and controls below the carousel;
  respect reduced motion by suppressing record playback animation; keep the
  empty-home content on a fixed top anchor so readiness and composer height
  changes grow downward instead of vertically re-centering the whole hero
- persist and pass only `agentTargetId` for target selection and launch
- use `agentTargetId` as the opaque activity-core composer `targetKey`; never
  derive a cache key from provider

The package-internal normalized target vocabulary is
`AgentGUIAgentTarget` / `agentTargets`. Do not reintroduce
`AgentGUIProviderTarget` or `providerTargets`: provider is execution metadata,
while `agentTargetId` is selection and launch identity. Agent avatar chrome is
projected once from an agent target into a shared avatar presentation containing
the resolved icon, label, and optional owner badge. The DOM rail, single-agent
empty state, and WebGL empty-home carousel consume that same presentation;
renderer adapters may differ, but they must not create parallel icon-only
models that can silently discard badge or identity fields.
Conversation rail rows render icons through a monochrome CSS mask. Built-in
providers therefore use their mask-safe flat catalog artwork before consulting
the Target presentation; using a square colorful Target asset there collapses
to a solid block. When an open extension provider has no built-in flat asset,
the row resolves the signed Target `iconUrl` through the conversation's
`agentTargetId`. Open providers must not require a renderer icon catalog entry.
One carousel image-load owner fetches and decodes icon, vinyl-cover, and badge
images for a complete item generation. Remote badge images must be requested
with anonymous CORS before assigning `src`, and the asset host must return an
origin-clean response. Replacing or unmounting a generation cancels all of its
pending image callbacks and clears unfinished sources. The Three.js scene must
receive decoded images and must never create a fallback `Image` loader of its
own; it owns only GPU texture/material/geometry lifetime. It keeps an
asset-independent visible owner marker until texture upload succeeds, so any
load, decode, conversion, or upload failure leaves the fallback visible. Scene
disposal releases textures, materials, and geometry after the component has
detached the scene from its decoded-image generation.

New-session surfaces, including the composer, batch runner, App Center, and
issue-manager launchers, must fail or disable launch when no `agentTargetId` is
available. They must not synthesize `local:<provider>` from a provider-only
selection as a compatibility fallback.

The removed public `providerTargets`, `providerRailMode`, provider-target
renderers, and `defaultProviderTargetId` fields have no runtime compatibility
alias. Workbench hydration may read legacy `providerTargetId` once and project
it to `agentTargetId`, but canonical state and every subsequent write must omit
legacy provider-target fields. Keep this read in a dedicated persisted-state
migration; current-state normalizers must reject the removed alias.
`providerTargetRef` remains daemon/runtime
implementation data and must not cross back into AgentGUI's public UI contract.

AgentGUI must not mint invocation-control tokens, resolve invocation plans,
contact command gateways, or handle raw credentials. Host/trusted code must
re-authenticate the current user and workspace and resolve launch authority.
An agent may represent shared, local, remote, or other host-owned launch
mechanisms, but those meanings stay outside AgentGUI.

Desktop workbench feeds the renderer `AgentsService` `/agents` snapshot into
AgentGUI. Cursor and OpenCode are regular built-in Agent Targets and remain
visible without desktop experiment preferences. Product feature gates may
filter other targets before rendering; a loaded empty result remains empty.
Availability states that should stay visible must remain in the array with the
matching non-ready status instead of becoming synthetic provider placeholders.
Tutti Agent visibility is owned by
the daemon's `local:tutti-agent` Agent Target: disabled daemon targets stay in
the presentation snapshot for history and settings, but are omitted from the
new-session `agents` projection before the directory reaches AgentGUI.
Provider slash commands must come from the runtime command snapshot or an
explicit adapter-owned command seed. Do not add AgentGUI-only slash-command
fallbacks to make providers look aligned. For OpenCode, `/compact` and
`/review` are adapter-owned: the runtime seeds the command snapshot, and
`/review` also injects an OpenCode `command.review` config entry. AgentGUI may
surface these as OpenCode fallbacks. OpenCode may reuse the shared review
picker, but picker selections must still submit provider-native `/review ...`
text and must not call Codex's structured `review/start` protocol.
Standard ACP command snapshots also project their detailed catalog into the
session runtime context. Composer options may reuse that catalog when the
renderer subscribed after the startup update or after a restart; a live engine
snapshot remains authoritative whenever it is present. This recovery path must
preserve provider-advertised names, descriptions, and input hints and must not
invent an extension-specific fallback list.
Open Agent Extensions declare Skill discovery roots, invocation mode, and
trigger prefix in their validated composer profile. The daemon resolves only
safe relative workspace/user roots and projects the resulting Skill options;
AgentGUI must not infer Skill behavior from an open provider identifier.
Legacy local hosts may keep AgentGUI's provider-default slash entries by
omitting `slashCommandFallbackMode`. Shared or remote-owner hosts that already
query slash commands from the owning runtime must pass
`slashCommandFallbackMode="none"` so AgentGUI does not mix caller-local command
defaults, local `/plan`, or local capability slash entries into the owner
snapshot. This mode controls command-list synthesis, not the semantics of
advertised commands: when the owner explicitly advertises a built-in name such
as `/plan`, `/fast`, or `/status`, AgentGUI may still handle it with the same
local composer behavior used for local sessions.
Local capability entries such as `/browser` and `/computer` are composer
commands, not provider-native slash commands. Palette selection and manual
submission must converge on the same local effect: enable the negotiated
capability, preserve the slash invocation as the visible prompt, and send the
capability handoff prompt to the provider. A recognized local capability must
never fall through as raw slash text to the provider's command parser.
Capability syntax and handoff projection belong to the pure AgentGUI model,
shared by all local capability commands. The composer hook must dispatch one
semantic submit carrying runtime content, visible prompt, and a
`requiredSettingsPatch`; it must not orchestrate a settings mutation followed
by a separate submit. For a new session, activation folds that patch into the
initial settings. For an existing session, the activity engine retains it with
the queued prompt, and the host command port applies the patch successfully
before delivering the prompt. Queue waiting, promotion, and retry must preserve
the patch so capability activation and prompt delivery remain one operation.
Desktop workbench may apply product entry gates before passing target data into
AgentGUI. The Tutti Agent settings switch writes only the daemon-owned
`local:tutti-agent.Enabled` field, then refreshes the shared Agent Target
snapshot. Renderer local storage is accepted only once as an upgrade migration
input and never remains a visibility source. When disabled, the target is
omitted from new-session targets, unified dock launch, launchpad, provider
rail/composer entry points, Workspace App provider catalogs, and workspace-app
mention candidates. The durable target record and session/activity snapshots
remain intact, so existing `tutti-agent` sessions stay readable and their
provider identity stays `tutti-agent`.

`nexight` remains a historical/runtime provider identity for old activity data
and compatibility code, but it is no longer a desktop new-entry AgentGUI
provider. Do not reintroduce `agent-nexight` or the old "Tutti" pseudo-app as a
launch surface; use the first-party `local:tutti-agent` Agent Target instead.

### Conversation Projection

Projection code converts runtime/session state into renderable view models.
Keep projection deterministic and testable. Prefer pure helpers under
`model/**` and `shared/agentConversation/projection/**` for grouping, sorting,
status selection, and timeline conversion.

### React Components

React components should render snapshots and handle DOM interaction. Avoid
putting cross-step orchestration into component effects when a controller,
store, selector, or pure helper can own it.

## Ownership Map

| Area                                      | Owns                                                                                            | Should not own                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `AgentGUI.tsx`                            | Package-level host provider composition and forwarding node props                               | Session data interpretation                             |
| `AgentGUINode.tsx`                        | Node chrome, package-to-node prop assembly, layout decisions                                    | Runtime data fetching internals                         |
| `controller/useAgentGUINodeController.ts` | UI orchestration, selected conversation flow, runtime command calls, error reporting            | Low-level rendering or durable activity cache ownership |
| `controller/*.ts` helpers                 | Focused controller decisions such as composer, session, interactive, prompt, and error handling | Broad unrelated feature branching                       |
| `model/*.ts`                              | Pure view-model and policy logic                                                                | React effects or host transport                         |
| `AgentGUINodeView.tsx`                    | Concrete UI composition and event wiring from `viewModel` and `actions`                         | Fetching session lists or mutating stores directly      |
| `useAgentGuiConversationList.ts`          | UI-facing projection of canonical sessions plus engine-owned pending intents                    | Becoming a second durable or pending-intent store       |
| `shared/agentConversation/projection/**`  | Transcript, tool, approval, task, message projection                                            | Provider transport details                              |
| `agentRichText/**`                        | Composer document, mentions, IME, prompt image extraction                                       | Session lifecycle                                       |

## Change Impact Checklist

Before modifying AgentGuiNode or Agent conversation behavior, answer these
questions in the PR, commit notes, or working notes:

1. Which chain is being changed: activation, session list, selected session,
   message timeline, composer draft, submit, cancel, approval, interactive
   prompt, provider capability, generated files, mention resolution, or layout?
2. What is the source of truth for the data being changed?
3. Is the change touching only view rendering, or does it alter runtime command
   sequencing?
4. Does the same state appear in both a durable runtime snapshot and a local
   overlay? If yes, how are conflicts resolved?
5. Which tests prove the changed chain and its nearest neighbor still work?
6. Which user-visible surface owns the loading/error/disabled/selected state,
   and what exact condition clears it?
7. Is this a recurring bug pattern that should update this document or
   `docs/conventions/troubleshooting/agent-runtime.md`?

If the answer to source of truth is unclear, stop and trace the chain before
editing.

## Common Chains

### Open Or Activate A Conversation

```text
workbench launch or open-session request
  -> AgentGUI
  -> AgentGUINode
  -> useAgentGUINodeController
  -> selected conversation state
  -> runtime activation or synchronization
  -> conversation detail projection
  -> AgentGUINodeView
```

Check both the request identity and the selected conversation fallback. Bugs in
this path often look like the wrong session opening, a blank detail panel, or a
selected session that is no longer present after refresh.

### Send A Prompt

```text
composer document
  -> prompt content normalization
  -> optional asset upload / mention serialization
  -> runtime send or create-session command
  -> engine pending-intent projection
  -> runtime snapshot refresh and live events
  -> timeline projection
```

Never fix send bugs only in the composer UI. Also inspect the pending intent,
runtime command input, and timeline merge path.

Host-generated context must enter the composer through a domain-specific,
host-owned custom mention rather than impersonating a generic picker file. For
example, the standalone Browser inserts a `browser-element` mention whose
visible label is the compact DOM tag (`<a>`, `<div>`, and so on), while its href
scope carries a bounded, sanitized Cursor-compatible text record with the
three fields `DOM Path`, `Position`, and `HTML Element`. It must not retain the
former whole-snapshot JSON envelope or create a draft `file` block.
Repeated selections append
multiple `browser-element` mentions inline, separated by ordinary spaces, to
the same text-only draft. Their editable custom-mention wrappers must size to
the compact chip instead of forcing the generic 24px mention height. The append
path must also retain one ordinary trailing space after the last mention, just
like interactive mention insertion, so the caret lands in a text node and uses
the same height as ordinary composer text. Prompt normalization removes that
trailing whitespace before send. Any prompt containing a serialized structured
mention must also cross the runtime boundary as `displayPrompt`: execution
content materializes each registered browser mention into its plain three-field
text immediately before runtime dispatch, while optimistic and durable
user-message projection keeps the original mention markup and renders the same
chips shown by the composer. The daemon, activity runtime, and provider
protocols therefore receive ordinary text blocks and require no browser-specific
contract. One sent message can reference several nodes without introducing
visible attachment blocks. Host presentation must also tolerate historical
`browser-element` references that carry only `path`, `tag`, and `workspaceId`:
the tag label and icon remain renderable even when inline execution `context`
is unavailable. Only runtime materialization depends on `context`; a missing
execution field must not make persisted composer or timeline markup fall back
to literal Markdown.
The custom mention's canonical Markdown label is distinct from its host chip
presentation: a DOM tag may serialize as `[@a](mention://browser-element/...)`
while the registered chip renders `<a>`. Parsing and re-serializing the
composer must preserve the canonical label instead of replacing it with the
presentation string. Sent timeline rows render the same registered chip and
retain the adjacent concrete prompt. For an automatically derived conversation
title, the AgentGUI conversation rail removes browser-element mentions and
displays only the remaining user text, while the detail/workbench header keeps
the registered browser-element card beside that text. The stored canonical
title is unchanged. Task, session, app, file, and Agent references may also
produce title cards or rail markers. Renamed or cleared titles stay canonical
plain text instead of restoring the historical prompt.

### Composer Mention References

```text
@ trigger range
  -> AgentRichTextEditor suggestion state
  -> AgentFileMentionPalette row action
  -> mention command OR reference picker launch
  -> composer document update
  -> prompt mention serialization
```

The `@` trigger range is the source of truth for replacing typed mention text.
Normal row selection replaces that range through the suggestion command. Any
side action inside a mention row that opens another picker and later inserts
files or `workspace-reference` mentions must clear the active trigger text
before launching the picker, otherwise the raw `@` query remains in the
composer before the inserted mention.

Composer toolbar affordances that open the `@` panel should insert the same
trigger text through `AgentRichTextEditor` at the current selection and let the
Tiptap suggestion plugin publish `AgentRichTextEditor` suggestion state. Do not
open the mention palette as a separate UI-only state path; the trigger range
still owns command replacement, keyboard handling, and panel anchoring.

Line-start mention chips may use an editor-only zero-width caret anchor so the
caret can move to both sides of an atomic Tiptap node. That anchor is not prompt
content and is removed during prompt serialization. Its lifecycle therefore
belongs to the rich-text document layer: deleting the last adjacent line-start
mention with Backspace or Delete must remove the mention and anchor in the same
transaction. If another adjacent mention remains at line start, retain the
anchor for that node. Never leave an anchor-only document whose serialized
prompt is empty while its editor DOM is not.

Pasting text that contains an `@` must not be treated as active mention input
unless the paste leaves the caret immediately after the `@` trigger. A bare
`@` paste may open the mention panel; a complete pasted query such as `@readme`
should remain plain prompt text until the user explicitly places the caret in
an active trigger position.

Plain-text paste classification happens before structured mention-HTML
delegation. Once the trimmed plain-text representation reaches 5,000
characters, every editor paste entry point must classify it as large text and
must not insert it inline. The composer creates one `pasted-text` draft item,
then calls the dedicated `AgentActivityRuntime.stagePastedText` host boundary
with raw text. The host owns local persistence and returns a managed absolute
path, display name, and byte size. Do not encode pasted text as a generic
`uploadPromptContent` file block or infer text-staging support from
`promptContentUploadSupport.file`; external hosts may accept host paths while
rejecting inline file bytes.

The pasted-text state machine is `detected -> staging -> landed | failed`.
Missing host support is a failed attachment state, not an inline fallback. The
draft keeps the original text in memory so the user may explicitly restore it
through “Show in text field”; automatic failure recovery must not violate the
large-paste invariant. Uploading and failed pasted-text items block submission.
The desktop runtime implements `stagePastedText` through the host prompt-asset
archive and returns only the managed path metadata to AgentGUI.

`workspace-reference` hrefs are the passive reference contract, not a visual
metadata store. Do not serialize app icons into the href just to render a chip.
For `source=app` references, readonly and markdown renderers should hydrate the
icon from the same `workspaceAppIcons` appId/workspaceId table used by ordinary
`workspace-app` mentions.

After an app artifact reference is submitted into the conversation timeline,
clicking its readonly or markdown chip routes the reference's app id through the
existing `open-workspace-app` host action. The composer keeps its narrower draft
behavior: clicking the same reference before submission reopens the artifact
picker at that source instead of launching the app.

System file drag-and-drop uses the same composer mention path as the reference
picker. `@tutti-os/agent-gui` receives a host-injected dropped-file resolver
that returns host-local `WorkspaceFileReference` values with `hostPath`,
`displayName`, `kind`, and `sourceId`; it must not import Electron or resolve
desktop `File` objects itself. The desktop host owns `File -> hostPath`
resolution through platform capabilities. Before insertion, AgentGUI sends
host-local file references through `AgentActivityRuntime.uploadPromptContent`
and only inserts the returned agent-readable path as a normal markdown file
mention. The original host path is an upload source, not prompt content.
The desktop runtime implements this upload by asking the host file capability
to archive the selected file under a Tutti-managed agent prompt assets
directory, then returns that managed absolute path to AgentGUI. Prompt images
use the separate daemon prompt attachment path: AgentGUI keeps pasted image
base64 data only as pre-upload draft state, desktop runtime archives the image
to a managed desktop-local path before submission, and the daemon copies that
path-backed source into the session attachment store before runtime execution.

Agent launch mentions use the external rich-text `agent-target` provider. The
`workspace-app` provider is reserved for real workspace apps and must not return
legacy `agent-codex` or `agent-claude-code` pseudo apps. New agent mentions
must serialize the exact current Agent Target id, for example
`mention://agent-target/local:codex?workspaceId=<workspace-id>`. Examples are
non-exhaustive; callers must discover the current target list instead of
assuming a fixed provider catalog. Mentions must not serialize provider ids or
icon hints into the href. Renderer display code
must resolve labels, providers, and icons by looking up the current
`agentTargetId` in `AgentsService`-derived presentation data, so future
user-defined icons and editable targets have one renderer source of truth.
The same rule applies to Agent Session mention rows and message-center cards:
`provider` remains runtime/protocol identity, while user-visible Agent name and
artwork come from the session's `agentTargetId`. Open extension providers must
not be filtered through the built-in provider catalog. Historical sessions
without an `agentTargetId` may use the provider presentation as their legacy
display identity.
Historical pseudo-app mentions may remain as display tokens but are not a new
insertion target.
Desktop AgentGUI host input must include the `agent-target` capability when it
builds composer context mention providers. Inside the AgentGUI mention palette,
the Apps tab queries only `workspace-app`; first-party launch targets appear in
a separate Agents tab that queries only `agent-target`. Do not use the Apps tab
as an agent fallback, because that recreates the old pseudo workspace-app
contract.
Workspace-app search in the Apps tab matches only the localized display name.
App ids, descriptions, scopes, and CLI command metadata may enrich presentation
or routing, but they must not produce search results that the visible app name
cannot explain.

Workspace-issue candidates use the rich-text provider's optional grouped query
contract. The desktop provider first lists every daemon-ordered issue topic,
loads each topic's first page with bounded concurrency, and returns one
provider-owned group per non-empty topic. AgentGUI encodes the opaque topic id
into a dynamic `issue-topic:*` presentation key, then atomically replaces the
ordered group list for each debounced search. Each group owns its items,
query-scoped total, cursor, and load-more status; loading or retrying one topic
must not replace sibling groups or put the whole palette into loading state.
Search results in the Tasks tab match only the visible workspace-issue title.
The daemon issue-list query owns that rule so its items, counts, and cursors all
use the same title-only result set.

```text
Agent mention query identity
  -> desktop workspace-issue grouped provider
  -> daemon-ordered topic list
  -> bounded first-page issue queries
  -> atomic AgentGUI topic-group projection
  -> one-topic cursor requests from expand actions
```

Browse topic groups participate in the existing 30-second
stale-while-revalidate cache and shared in-flight dedupe. Successful browse
pages merge into the cached topic group so reopening the palette preserves
appended rows. Search groups remain request-scoped. Query, filter, workspace,
close, and dispose transitions invalidate old first-page and page requests;
`AbortSignal` is propagated through the desktop provider to the tuttid topic
and issue-list requests, while request identity and cursor checks remain the
final stale-response defense. Group metadata never changes the persisted
`workspace-issue` mention URI or scope.

Quick check:

```sh
corepack pnpm --filter @tutti-os/agent-gui exec vitest run agent-gui/agentGuiNode/AgentComposer.spec.tsx -t "removes the active @ trigger"
corepack pnpm --filter @tutti-os/agent-gui exec vitest run shared/AgentRichTextReadonly.spec.tsx shared/AgentMessageMarkdown.spec.tsx
```

### Agent Generated File Mentions

```text
Durable Turn.fileChanges snapshots
  -> indexed recent settled-Turn candidate window
  -> exact section join and Go file-state combination
  -> target filter and workspace-file search ranking
  -> desktop mention provider
  -> mention palette grouping/count presentation
  -> composer file mention insertion
```

`Turn.fileChanges` is the only generated-file source of truth. The daemon does
not persist a second file projection: it uses a partial settled-Turn index to
materialize at most the newest 1000 workspace Turns, joins the requested exact
rail section, and returns at most 100 settled Turns for Go aggregation.
Activity messages, tool payloads, provider metadata, and renderer session
snapshots are not compatibility fallbacks, so sessions that predate canonical
Turn file changes do not appear in generated-file results. Running, waiting,
and settling Turns are intentionally absent; all terminal outcomes may
contribute files because a failed or canceled Turn can already have written.

The query requires the exact persisted rail `sectionKey`. Project sections use
the `WorkspaceUserProject.sectionKey` supplied by the daemon; the unassigned
section uses the fixed `conversations` key. The desktop and AgentGUI layers must
not derive a project key from `cwd` or a path. A missing key fails closed and
the key is part of mention browse-cache identity. Go resolves relative paths
against each persisted session `cwd`; project sections retain only normalized
paths contained by their persisted `rail_project_path`. Turns are folded from
newest `settledAt` to oldest, so the first valid `added`, `modified`, or
`deleted` change for a path decides its current state. All other change kinds
are ignored. Tombstones are applied before Agent filtering, then a non-empty
query reuses workspace file-search ranking.

The aggregate is cached by `workspaceId + sectionKey` for ten seconds without
event invalidation. The HTTP cursor uses bounded offset pagination over at most
200 ranked paths. Cache expiry may cause duplicate, missing, or reordered
entries between pages, and a quiet section can be absent when its Turns fall
outside the 1000-Turn workspace candidate window. AgentGUI labels the group as
recent; this endpoint remains an optimistic convenience rather than an
exhaustive generated-file ledger.

### Reference Source Filtering

The desktop product may enable Agent provenance filtering through the
default-off `agent.referenceProvenanceFilter` developer feature flag. The flag
is projected into AgentGUI as a host capability; AgentGUI does not read desktop
preferences directly. Preview mode keeps the capability disabled. Public
AgentGUI hosts may instead opt in with
`hostCapabilities.referenceProvenanceFilterCatalog`, which carries the full
host-owned `enabledDimensions`, `agentOptions`, and `memberOptions` catalog. An
explicit catalog takes precedence over the legacy boolean switch. With neither
property, filtering remains disabled; the legacy switch continues to derive an
Agent-only catalog and never enables members.

AgentGUI creates one controlled provenance controller for both the composer
`@` palette and the `+` reference picker. The desktop host injects the current
Agent target catalog, while the query providers apply selected
`agentTargetId` values before pagination. Session search merges target-scoped
queries. Tutti's daemon-backed generated-file query accepts multiple
`agentTargetIds`; it combines the bounded Turn window for the persisted rail
section before applying the session-target filter, ranking, and result limit.
The renderer must not filter a capped snapshot.
In the `+` picker, desktop project/local sources switch to that same
generated-file provider for an active Agent constraint, then apply file type
filters and the result limit. This provenance constraint does not imply a file
path-to-session-cwd constraint. A project source may select the exact persisted
project `sectionKey` associated with its opaque location node, but it must not
synthesize a section key or map the node to a session working directory.
Ordinary opened-file and issue-summary records do not currently
carry durable provenance and therefore fail closed when either an Agent or
Member constraint is active. A typed File query must route to the
provenance-aware generated-file provider for either active dimension, even when
the ordinary generated-files group is otherwise disabled. Generated-file and
picker result groups remain source-owned. The Agent Session and Agent target
`@` lists are the exceptions when a host injects an Agent provenance catalog.
Session and Agent target rows use each Agent option's `parentMemberId` to group
under the matching Member catalog entry, so one member's sessions and targets
share a group across Agent targets while filtering still uses the individual
target ids. Collaboration hosts should build this catalog from the complete
Agent directory, using `AgentGUIAgent.owner.userId` for shared targets, rather
than deriving ownership only from sessions; targets without history must still
join their owner's group. Hosts that omit a matching Member entry retain the
per-Agent group. AgentGUI does not synthesize owner-aware row labels because
that presentation remains host-owned. Rows outside the catalog remain visible
in stable uncatalogued groups only while no explicit Agent filter is selected.
This grouping is presentation only; the provider still applies the selected
provenance constraint before pagination. A host may provide Member entries for
grouping without enabling the Member filter dimension.

Only catalog entries with a durable `agentTargetId` participate in filtering;
host target ids are not substitutes. Catalogs and filters are normalized at the
shared boundary, and cache identity uses collision-free semantic serialization.
Provider replacement must reapply the current filter. Idle preload captures the
filter value used to build its cache key, and an interactive filter change
aborts or invalidates the active request before the replacement debounce is
scheduled. Typed `@` queries in the File category continue to query the
Agent-generated-file provider whenever an Agent constraint is active.

The filter popover is portal-mounted and must mark its content as `nodrag`.
Portal content is not a DOM descendant of the Agent window trigger, so the
window's click-capture guard otherwise treats the option click as a draggable
window interaction and stops it before the filter row receives the event.

The shared contracts reserve a separate member dimension for collaboration
hosts. Collaboration hosts own Member option identity and the providers that
enforce `memberIds` before pagination. Tutti personal edition must not inject
that dimension and must not enable member or group-chat filtering.

### Approval Or Ask-User Prompt

```text
provider interaction request
  -> durable Interaction(pending)
  -> interaction_update
  -> AgentSessionEngine pendingInteractions selector
  -> prompt view model
  -> AgentInteractivePromptSurface or approval card
  -> runtime submitInteractive
  -> durable Interaction(answered or superseded)
```

Check stale prompt IDs, answered prompt filtering, bottom dock state, and
selected conversation synchronization together.

### Composer Settings

```text
provider capability/options
  -> composer support model
  -> node default settings
  -> per-session settings
  -> AgentSessionEngine settings-update intent
  -> live runtime update or historical durable projection update
  -> menu rendering
```

Avoid fixing a menu label or disabled state without checking whether the same
setting is also used by prompt creation, session continuation, and runtime
tracking.
Active-session settings are first-class session state. The controller submits
exactly one engine intent for one menu selection. The same explicit user
selection may independently update the target default and the node-local default
draft; merely opening or restoring a session must not. The engine owns the
operation state. A timed-out update remains `unknown`, and the next explicit user
selection carries retry intent instead of being silently dropped. That retry
merges the unresolved in-flight patch, any queued patch, and the latest selection
in that order, so the newest value wins without losing settings that the daemon
may not have applied before the timeout.

Provider-specific safety confirmation belongs at the composer setting selection
boundary, before the settings change reaches the engine. Selecting Codex
`full-access` opens a localized warning and must not dispatch a settings change
until the user confirms; canceling preserves the previous selection. Confirmation
still dispatches exactly one ordinary settings patch, so the engine and daemon do
not acquire a second safety-dialog state machine. Other providers' modes continue
to follow their provider contracts without inheriting this Codex-specific gate.
The warning's safety-reference link uses the host link-action boundary. Workspace
surfaces may route it to their Browser node; the standalone Agent window must fall
back to the desktop external-browser bridge rather than silently dropping the URL.

The daemon selects the mutation path from session liveness. A live session
updates through its provider adapter. A historical session updates the durable
activity projection directly and publishes reconciliation without resuming the
provider runtime or starting a sidecar. This keeps historical settings available
for the next explicit continuation while avoiding hidden startup latency and
provider side effects. Runtime resume and durable settings read-modify-write
share a context-aware per-session daemon serialization boundary, so a canceled
caller does not remain blocked behind a slow resume, a concurrent continuation
cannot restore stale settings, and partial patches cannot overwrite one another.
Workflows that must continue the same provider
conversation, such as plan implementation, explicitly resume first and then use
the live settings path; they must not depend on a generic settings call to wake
the runtime. Provider capability differences belong in the daemon runtime
adapter: for example, OpenCode model and reasoning-effort changes are live ACP
`session/set_config_option` updates, while spawn-time-only provider settings may
return the `agent.settings_require_new_session` reason. The UI should surface
that reason as guidance, not as an unhandled runtime error.

### Mention Or File Reference

```text
rich text document
  -> mention extension
  -> mention palette/search controller
  -> workspace reference adapter or source aggregator
  -> prompt serialization
  -> rendered transcript markdown/link actions
```

IME behavior, search state, serialization, and transcript rendering are separate
links. A local picker fix can break prompt serialization or rendered links.

Rendered transcript markdown should only promote explicit file targets to
workspace file actions: local absolute paths, home-relative paths, and Windows
absolute paths. Relative markdown links remain display text unless another
structured reference contract marks them as a workspace reference. Host adapters
that open workspace file nodes should validate explicit agent-command file
targets before launching the files surface, so a speculative or stale agent
path does not open a misleading workbench node. Both workspace and standalone
Agent window host routes must honor that validation intent and surface the same
localized missing-target feedback instead of opening an empty files surface or
silently doing nothing.

Bare HTTP links use the GFM literal-autolink parser, but transcript rendering
also repairs CJK sentence punctuation boundaries after Markdown parsing because
the upstream GFM boundary set is ASCII-oriented. This repair applies only to
literal autolinks and must preserve explicit Markdown links, angle autolinks,
code, and intentionally authored Unicode link destinations. Streaming and
settled transcript rendering must use the same boundary transform so an href
does not change when a turn finishes. Raw CJK punctuation in a literal autolink
is a sentence boundary; a URL that intentionally contains that punctuation must
percent-encode it or use an explicit Markdown link destination.

Provider host-app-context prompts should mirror that contract: when agents
reference code or workspace files in responses, instruct them to emit Markdown
links with filename labels and absolute filesystem targets such as
`[filename](/abs/path)`, not relative links, inline-code paths, or line-suffixed
paths.

Quick checks:

```sh
pnpm --filter @tutti-os/agent-gui test -- shared/AgentMessageMarkdown.spec.tsx
pnpm --filter @tutti-os/desktop test -- src/renderer/src/features/workspace-file-manager/services/internal/workspaceFileManagerService.test.ts src/renderer/src/features/workspace-workbench/services/workspaceFilesRevealIntent.test.ts
```

## Troubleshooting Playbook

### Blank Or Stale Conversation Detail

Quick checks:

- Confirm the selected `agentSessionId` still exists in the runtime snapshot.
- Check whether engine pending activations, deletion state, or the transient
  selected-conversation fallback is hiding or replacing the runtime conversation.
- Inspect message loading state and `ensureSessionSynchronized` calls.
- Check whether a React mounted ref or cleanup guard is dropping a successful
  async continuation.

Likely fix area:

- selection fallback helper
- engine pending-intent selectors
- session detail transport/controller loading and error state
- controller synchronization effect

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
```

### Prompt Sends But Timeline Does Not Update

Quick checks:

- Confirm `AgentActivityRuntime.sendInput` or create-session command was called
  with the expected session ID and content blocks.
- Confirm the pending-intent prompt projection is inserted and later reconciled.
- Confirm live events or message page reload contains a newer version.
- Inspect timeline item merge and dedupe keys.
- Confirm `message_update` payloads already include `turnId`,
  `occurredAtUnixMs`, and a positive `version` or `seq`; missing fields belong
  in runtime/adapter/daemon normalization, not AgentGUI prompt retargeting.
- When the selected detail window only contains optimistic prompt messages,
  do not use their local timestamp-derived versions as durable message-window
  bounds; live runtime messages can have lower authoritative sequence versions
  and must still enter the transcript before a refresh.
- If user prompts appear below assistant replies until the conversation is
  reopened, inspect whether optimistic prompt messages were merged into
  `detailMessages` or another durable/base set. Reconciliation should split
  durable messages from optimistic overlays, then drop overlays that match a
  durable `messageId`, `clientSubmitId`, or prompt signature.
- When a live message or lifecycle patch reveals the real turn ID for a
  first-prompt create, retarget the optimistic prompt from its pending
  client-submit turn ID only after the event is known to belong to the current
  submit; retained history must not retarget that optimistic prompt. Do this
  before projecting rows so the user prompt stays grouped above the agent
  response.

Likely fix area:

- prompt content normalization
- pending submit overlay
- message merge helper
- timeline projection

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/model/agentGuiConversationModel.spec.ts
```

### Mixed AgentGUI Language Or Date Labels

Quick checks:

- Check whether the surface is wrapped in `AgentGuiI18nProvider` through
  `AgentGUI`, `WorkspaceAgentMessageCenterPanel`, or a host-owned card wrapper.
- If a desktop surface passes a host `i18n` runtime into
  `AgentGuiI18nProvider`, pass the matching `locale` too. `t()` reads the
  runtime, while formatting helpers such as `formatAgentMessageTimestamp` read
  the AgentGUI locale bridge through `getActiveUiLanguage()`.
- Inspect workbench contribution plumbing when a card is rendered outside the
  main AgentGUI tree; `DesktopWorkbenchContributionContext` should carry both
  `appI18n` and `appLocale`.

Likely fix area:

- desktop contribution context / shell runtime locale propagation
- host-owned message center card wrappers
- direct `AgentGuiI18nProvider` call sites

### Approval Or Question Remains After Answering

Quick checks:

- Confirm the projected prompt status changes after the runtime response.
- Check whether answered/superseded prompts are filtered in both detail and
  bottom-dock surfaces.
- Inspect prompt IDs and turn IDs; local UI IDs must match runtime message
  identity.

Likely fix area:

- interactive projection
- approval projection
- bottom dock prompt selection
- runtime submit response handling

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- shared/agentConversation/projection/agentInteractiveProjection.spec.ts
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
```

### Provider Or Capability UI Looks Correct But Submit Uses Old Settings

Quick checks:

- Compare displayed settings with effective composer settings.
- Check node defaults, session settings, draft settings, and runtime options.
- Confirm setting changes call the runtime update or draft tracking method.

Likely fix area:

- `agentGuiController.composerHelpers.ts`
- `composerSettingsSupport.ts`
- `composerSettingsMenuModel.ts`
- controller settings update path

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/agentGuiController.composerHelpers.spec.ts
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/model/composerSettingsMenuModel.spec.ts
```

### Mention Search Or Picker Regresses IME

Quick checks:

- Check `isComposing` handling for Enter, Tab, Arrow keys, and search input.
- Confirm local composing text is not overwritten by async search state.
- Run both mention search and file mention palette tests.

Likely fix area:

- `AgentMentionSearchController.ts`
- `AgentFileMentionPalette.tsx`
- `agentRichText/agentRichTextIme.ts`

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/AgentMentionSearchController.spec.ts
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/AgentFileMentionPalette.spec.tsx
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/agentRichText/agentRichTextIme.spec.ts
```

## Boundary Checks

Run the runtime boundary check after changing AgentGUI data flow:

```sh
pnpm check:agent-activity-runtime-boundaries
pnpm check:agent-provider-strategy-boundaries
pnpm check:agent-gui-degradation
pnpm check:renderer-boundaries
pnpm lint:ts
pnpm typecheck
pnpm --filter @tutti-os/agent-gui test
pnpm --filter @tutti-os/desktop build
pnpm check:changed
```

Contract tests should lock:

- session and turn entity separation
- command correlation and idempotent replay
- selector behavior for running and settled turns
- grouped public props without flat regressions
- provider descriptor coverage for every registered provider
- render budgets for common GUI interactions

## Diagnostics

Diagnostics follow one command or event across boundaries using stable IDs:

- `workspaceId`
- `agentSessionId`
- `turnId`
- `clientSubmitId` or command ID
- provider ID and provider session ID when available

Submit correlation and submit diagnostics are separate typed contracts.
`clientSubmitId` remains a top-level idempotency identity; optional timing and
content-shape evidence travels as `submitDiagnostics` with the same field names
as the OpenAPI request schema. Generic metadata bags must not cross the engine
or daemon command seam because conditional object spreads can otherwise hide
request-contract drift from TypeScript.

For one investigated problem, every diagnostic log uses the same prefix and
serializes its payload with `JSON.stringify`. Investigation logs remain enabled
until the root cause is established. Unknown state requires more boundary
evidence before behavior changes.

> This change exposed a reusable AgentGUI pattern. Should I add it to
> `docs/architecture/agent-gui-node.md` or
> `docs/conventions/troubleshooting/agent-runtime.md`?

Debug in ownership order:

1. Verify daemon command acceptance, persisted intent, and correlated events.
2. Verify engine reduction and selector output for the same IDs.
3. Verify the vertical GUI module receives that selector output.
4. Verify the view renders it without adding workflow interpretation.

If evidence ends at a boundary, add diagnostics at both sides of that boundary.
Fix the first broken ownership transition.

## Documentation Impact

Update this document when ownership, entity flow, public node responsibilities,
provider strategy dispatch, validation, or diagnostic conventions change.
User-visible interaction details belong in product documentation; recurring
symptom playbooks belong in the relevant document under
`docs/conventions/troubleshooting/`.

A durable lesson should include the affected chain, the source-of-truth rule,
the quick check, and at least one validation command when a command exists. Any
self-evolution decision other than `discard` must update the matching durable
document in the same change and the final response should name the document
that was updated. If the impact check is `discard`, the final response should
state that no durable documentation update was needed.

## What To Avoid

- Do not patch a visible component without tracing the controller and runtime
  chain that feeds it.
- Do not create another durable session cache in AgentGuiNode.
- Do not reintroduce production reads or writes through legacy Host API
  session methods when `AgentActivityRuntime` has the operation.
- Do not hide runtime errors in local UI state without reporting diagnostics.
- Do not solve provider-specific behavior by hardcoding it in generic
  transcript or composer rendering unless the provider identity is part of the
  intended model.
- Do not add broad abstractions to make one bug easier; first use the existing
  controller, model, projection, and store boundaries.

## Related Documents

- [Agent Activity Packages](./agent-activity-packages.md)
- [Agent Reference Mention Resolution](./agent-reference-mention-resolution.md)
- [Agent Reference Sources](./agent-reference-sources.md)
- [Desktop Layering](../conventions/desktop-layering.md)
- [Agent Runtime Troubleshooting](../conventions/troubleshooting/agent-runtime.md)
- [`@tutti-os/agent-gui` README](../../packages/agent/gui/README.md)
