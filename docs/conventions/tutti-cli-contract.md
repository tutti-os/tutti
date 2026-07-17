# Tutti CLI Contract

This document defines the durable contract for Tutti CLI commands exposed
through the local daemon.

The bundled CLI is a thin client. It discovers command capabilities from
`tuttid`, matches command paths, parses flags using daemon-provided
`InputSchema`, invokes the daemon command endpoint, and renders the returned
`CommandOutput`.

## Error Output

`--json` applies to failure output as well as successful command output.
Expected invocation, transport, and domain failures write one JSON object to
stdout and do not fall back to free-form stderr text:

```json
{
  "error": {
    "reasonCode": "workspace_agent_session_not_found",
    "message": "agent session was not found"
  }
}
```

The CLI preserves the daemon protocol `reason` as `reasonCode`, falling back to
the daemon error `code` when no narrower reason exists. Optional daemon
`retryable` and `correlationId` fields are preserved. Errors detected before a
daemon invocation use stable CLI-owned reason codes such as `invalid_input`,
`command_not_found`, and `daemon_unavailable`.

Because `retryable` is omitted when false, consumers must not treat a missing
field as permission to retry an arbitrary structured failure. CLI-owned
transient reasons such as `daemon_unavailable` and `daemon_request_failed`
remain retryable by reason; daemon errors are retryable only when the envelope
explicitly says so.

Domain validation keeps its narrower daemon reason when one exists. For
example, `unsupported_permission_mode_id` means a caller supplied a permission
identifier that is not advertised for the selected Agent target. Automation
must refresh Composer Options and pass one of its `modes[].id` values verbatim;
it must not retry the same value or substitute `modes[].semantic`.
An obsolete persisted default is ignored while reading Composer Options so the
caller can recover by selecting a current advertised id. The same obsolete id,
when explicitly supplied in the current invocation, remains invalid input.

Exit codes stay intentionally small and stable: `0` means success, `2` means
the command invocation or input was invalid, and `1` means authentication,
transport, domain, or runtime failure. A daemon HTTP 400 response is invalid
input and therefore exits with `2`; other daemon failures exit with `1`.
Without `--json`, ordinary human-facing failures continue to write concise
text to stderr.

## Agent Turn Cancellation

Agent cancellation is Turn-scoped. Use
`agent cancel-turn --session-id <id> --turn-id <id>` to cancel one exact Turn
while preserving the session for later input. The explicit Turn id prevents a
caller from accidentally canceling a newer Turn that became active after it
last inspected the session.

JSON output returns `agentSessionId`, `turnId`, `canceled`, and the idempotent
result `reason` (`turn_canceled`, `already_settled`, or `not_found`). There is
no CLI operation that cancels or terminates an Agent session.

The old `agent cancel --session-id <id>` path remains an integration-only
compatibility alias. It resolves the currently active Turn, emits a
`deprecated_agent_cancel` warning, and must not be used by new integrations.

## Boundaries

The daemon has two CLI command surfaces:

- builtin commands owned by `services/tuttid/service/cli/providers/*`
- workspace app commands declared by app-owned `tutti.cli.json` manifests

Builtin commands should be implemented through the daemon CLI framework. The
framework is the source of truth for builtin command metadata, input schema,
input binding, validation, workspace resolution, and output formatting.

Workspace app commands use the frozen `tutti.app.cli.v1` manifest contract.
They are not implemented through the builtin framework.
Builtin summary/detail JSON view rules do not apply to workspace app commands.
External app commands follow their own manifest-declared output and response
contract.
Workspace app `appId` and CLI `scope` are separate identifiers. Discovery and
agent app mentions match commands by app id metadata, then invoke the listed
CLI scope; callers must not assume `scope == appId`.

## Frozen App CLI Contract

The app CLI path is a compatibility boundary for workspace apps.

Keep these semantics stable unless the app CLI manifest version changes:

- `tutti.app.json` points to the app-owned CLI manifest path
- `tutti.cli.json` uses `schemaVersion: "tutti.app.cli.v1"`
- `packages/appcli/core` reads and validates the manifest shape; daemon code
  adapts that protocol core to Tutti workspace/app runtime state
- `appcli.Registry` normalizes input according to the manifest input schema
- `appcli.Registry` invokes the app handler with the
  `tutti.app.cli.invoke.v1` envelope
- app handlers receive HTTP `POST` requests under `/tutti/cli/*`
- app handlers return the existing `CliCommandOutput` shape
- app command output is validated against the manifest-declared output contract
- app commands may declare optional `visibility: "integration"` to stay out of
  ordinary user and Agent discovery while remaining available to app-runtime
  integrations; omitted visibility is `public`
- app command input schema properties may include `enum` and `default`
  annotations when their values match the declared property type; `default` is
  metadata for help and discovery, not a host-side input value that is injected
  into handler requests

Do not require migration for existing app manifests when changing builtin CLI
implementation internals.

`visibility` is a discovery hint, not an authorization boundary. Use it to keep
integration-only commands out of `tutti --help`, Agent command guides, and
ordinary command matching. Do not use it for secrets, privileged actions, or
operations that must be blocked when a user already knows the command.

App-runtime CLI discovery should request integration-only commands without
skipping provider availability filters. Use the CLI capabilities
`includeIntegration` query for that path. Reserve `includeHidden` for metadata
or debugging paths that intentionally need both provider-filtered and
visibility-filtered capabilities.

## Builtin Command Source Of Truth

Every builtin command should be declared once through a command spec. The spec
drives:

- `Capability.ID`
- `Capability.Path`
- `Capability.Summary`
- `Capability.Description`
- `Capability.InputSchema`
- `Capability.Output`
- input binding and validation
- default output formatting
- command kind compliance

Provider handlers should contain business behavior only. They should not
hand-maintain JSON schema, duplicate flag parsing, duplicate required-field
validation, or duplicate default output branching when the framework can derive
it from the spec.

The framework must return the existing `cliservice.Command` type. The registry,
OpenAPI route shape, and app CLI registry remain separate.

Builtin capabilities may declare `Capability.Visibility` as `integration` when
the command is intended for app-runtime integrations rather than ordinary user
or Agent discovery. Omitted visibility defaults to `public`.

`workspace-apps.app.open` is public so agents can open requested workspace app
windows. Some built-in app ids, such as Agent GUI and issue-manager windows,
map to workbench nodes rather than installed app packages. Agent-facing skills
must still treat app opening as an explicit activation action: use it only when
the user asks to open or show an app window, or confirms that an app window
should be opened. For ordinary app work, agents should prefer the app-specific
CLI capability over opening the app UI.

### Computer command surfaces

The builtin `computer` provider has two intentionally different layers, both
owned by `services/tuttid/service/computer` and exposed through daemon command
specs:

- stable aliases such as `computer screenshot`, `click`, `type`, and `scroll`
  provide a small window-oriented compatibility contract and may normalize
  legacy tool names;
- `computer tool list|describe|call` discovers and invokes the native
  cua-driver MCP catalog without adding a Tutti binding for every driver tool;
  this is the complete extensible entry point for authorized native
  capabilities that do not have a stable alias.

Stable screenshot-coordinate commands (`screenshot`, `click`, `double-click`,
`right-click`, and `scroll`) expose only the window workflow. They do not expose
a synthetic shared `scope`. `pid` and `window-id` are accepted only as a pair;
when both are omitted, the service may select an eligible visible window.
Coordinates for pointer and scroll commands are local to the selected window
screenshot. Keyboard commands accept the same explicit pid/window pair to
avoid target drift. `move-cursor` is deliberately target- and scope-less: it
accepts agent-cursor screen points, not pixels copied from either screenshot
surface.

Pointer delivery is dispatch-only: pixel clicks post background CGEvents that
cua-driver cannot verify, and Electron-based apps may drop them silently. The
skill contract therefore prefers element-token actions (native `click` with an
`element_token` from screenshot structured content), requires effect
verification through a fresh screenshot rather than the agent-cursor overlay
(a separate visual channel that can render offset after display-configuration
changes), and escalates unresponsive background clicks via the native
`delivery_mode: "foreground"` contract instead of repeating the same pixel
click. See
[Computer Use Troubleshooting](./troubleshooting/computer-use.md#a-computer-click-reports-success-but-the-ui-does-not-change)
for the symptom-driven verification and recovery checklist.

Desktop automation follows each native cua-driver tool's real contract rather
than a Tutti-wide scope model:

- `get_config` reads cua-driver's host-global persisted `capture_scope`;
- `get_desktop_state` captures the desktop only when that persisted setting is
  already `desktop`; the call does not choose a capture scope;
- native `click` has its own per-call `scope: "desktop"` contract;
- native `scroll` requires a PID and has no true desktop-coordinate mode, so
  Tutti must not advertise desktop scrolling.

Stable commands and native calls must not implement a hidden set/call/restore
sequence around `capture_scope`. The `system.config.write` capability used by
native `set_config` is authorized by Tutti's default computer policy, so an
agent may explicitly set `capture_scope` to `desktop` through `computer tool
call` before invoking `get_desktop_state`. The mutation is host-global and
persisted by cua-driver; the agent must not disguise that fact or automatically
restore the previous value after capture. Stable `computer screenshot` remains
window-only regardless of the persisted scope.

The native catalog is also the policy input. Tutti applies a default-deny
capability allowlist in `service/computer`. `tool list` and `tool describe`
retain the complete live catalog and annotate every tool with the Tutti-owned
`allowed` decision and `denialReason`; `tool call` enforces the same policy.
MCP effect annotations are descriptive hints and never grant authority. Both
the catalog `schema_version` and `capability_version` are breaking-contract
boundaries; missing or unknown versions fail closed before any tool is listed,
described, or invoked. Every advertised capability must be explicitly
recognized and allowed before invocation. Tools with no capability metadata,
any unknown or denied capability, or a name absent from the live catalog remain
unavailable even when another capability on that tool is allowed. Stable
aliases enumerate their supported operations and must not fall through to raw
native invocation.

Stable aliases return compact, explicitly projected JSON. Native `tool call`
is the narrow exception: its JSON mode preserves the complete MCP tool result,
including unknown and future content variants, so extending cua-driver does
not require a Tutti result adapter. Plain mode may still project the collected
text for terminal use. A valid MCP result with `isError: true` is still emitted
unchanged by native JSON mode so callers retain its structured diagnostics;
transport and protocol failures remain CLI errors. Stable aliases continue to
translate `isError` results into their compatibility error behavior. Do not use
the native surface to bypass stable alias validation or the capability policy.

## Command Kinds

Builtin commands must declare one command kind.

| Kind     | Purpose                                 | Default output expectation                |
| -------- | --------------------------------------- | ----------------------------------------- |
| `list`   | Return a collection or page of records  | table for terminal output, compact JSON   |
| `get`    | Return one detailed record              | detail JSON                               |
| `action` | Start, mutate, cancel, open, or trigger | explicit concise result chosen by command |

List commands must use the `summary` JSON view by default. Get commands must
use the `detail` JSON view by default. Action commands must use the `summary`
JSON view by default.

`--json` means machine-readable output. It does not mean every domain field is
returned. The command kind chooses the stable JSON view: list/action commands
return concise summaries, and get commands return detail with nearby context.

Action commands should return the smallest useful confirmation payload. For
agent session actions, this normally means session id, exact `agentTargetId`,
provider runtime metadata, status, and whether a launch/open request was
published. Existing-session consumers must validate `agentTargetId` before
sending or attaching; provider equality is not sufficient because several
Agent Targets may share one provider.

Agent submission actions also return the exact top-level `turnId` established
or targeted by that command. `agent start` returns the initial Turn created for
its prompt, and `agent send` returns the Turn created by a normal send or
targeted by active-turn guidance. Callers must use this exact identity for
`agent turn-resources` and later Turn-scoped operations instead of inferring it
from `session.activeTurnId` or querying the transcript.

Agent session detail JSON uses the same protocol-v2 entities as HTTP/OpenAPI:
`activeTurnId`, `activeTurn`, `latestTurn`, and pending Interaction records.
It must not expose the provider-runtime `turnLifecycle` or
`submitAvailability` mirrors as session-domain fields. CLI status labels are
derived from the typed Turn projection rather than persisted on Session.

`agent send --guidance` sends a one-shot prompt as active-turn guidance for an
existing running session. It requires an active turn, does not attach to stdout
or subscribe to session events, and must fail instead of falling back to a normal
next-turn send when no active turn is present.

Issue-manager breakdown commands should preserve authored task order in the
daemon instead of relying on callers to serialize several single-task creates.
Use `issue task create-batch` for multiple new child tasks. Its `tasks-json`
input is a JSON array of task objects, and the daemon appends tasks in array
order with contiguous issue-local `sortIndex` values.

`agent get --json` progressively discloses agent context. Its default
`conversation` view returns the three most recent Turns newest-first. Messages
inside each Turn remain chronological and include only user/assistant body
content; tool calls and session audits are excluded. Each Turn exposes its
durable final assistant result separately as `finalMessage`, plus
`hasMoreMessages` when the bounded body scan did not cover the complete raw
trace. `--turns <N>` expands the recent window from 1 to 20 Turns, while
`--turn-id <id>` selects one exact Turn. `--before-turn-id <id>` pages the
`conversation` or metadata-only `turns` view towards older Turns; the cursor is
exclusive and callers use the oldest returned Turn id when `hasMoreTurns` is
true. `--view session` returns session metadata without messages. `--view
turns` returns the same newest-first Turn metadata without reading message
records. `--view trace --turn-id <id>` returns one Turn's tool-level message
records and full payloads, bounded by `--messages <1-100>` and pageable
backwards with `--before-version`.

Turns are the outer ordering unit: recent Turns come first, while messages
inside a Turn never reverse. The session record includes exact `agentTargetId`
alongside provider runtime metadata so callers can safely validate
attach/resume identity. When a compact conversation message contains image
prompt content, include an
`images` array with `attachmentId`, `mimeType`, `name`, and a daemon-local
`localPath` when the attachment file is available on disk. Keep `payload`
omitted from the conversation shape; expose full payloads only in the explicit
trace view. The deprecated integration-only `agent session-summary` path
remains temporarily available for compatibility with its existing pagination
flags and exact top-level JSON shape. Deprecation is advertised through command
metadata, not a runtime warning that would wrap or mutate legacy JSON output.

`agent wait --json` is the blocking progress helper for launched or continued
agent sessions. It should wait for the next meaningful stop point such as turn
completion, failure, cancellation, waiting for approval, waiting for user
input, or timeout. Its JSON result stays narrow: compact session status, the
exact top-level `turnId` associated with the stop point when one exists, wait
reason, latest version, effective wait cursor, and timeout flag. A completed or
failed turn additionally returns its last assistant text as `finalMessage`;
that nested record repeats the owning `turnId` for local correlation. An
approval or input stop additionally returns the pending `interactions` with
self-described actions and a JSON input summary of at most 2 KiB. It must not
reuse a historical settled Turn for an idle timeout: timeout carries a
`turnId` only while a Turn is active. It must not return execution-message
pagination or a full transcript; callers that need broader context should
follow with `agent get`, paging older Turns with `--before-turn-id` or selecting
one Turn's trace only when necessary. Keep message window controls out of the
public wait command shape, and keep timeout output free of result or
interaction detail.
The wait implementation skips transcript pagination and performs result
enrichment separately. New settled turns carry a durable final-assistant
resolution marker and, when present at settlement, the exact message anchor.
Anchored reads select that exact message; a resolved marker with no anchor means
the Turn had no final assistant text and must return no `finalMessage`, even if
an assistant message arrives later. Only legacy turns without resolution
metadata fall back to at most three descending message pages. If neither path
finds the message, omit `finalMessage` rather than returning an older assistant
response.
When a caller continues an existing session with `agent send`, the send action
should return a `waitAfterVersion` cursor, and the next wait call should pass
that cursor as `agent wait --after-version <waitAfterVersion> ...` so the wait
blocks for the new stop point instead of immediately replaying the previous
session stop state.

`agent respond --json` answers one pending interaction selected by
`--session-id`, `--turn-id`, and `--request-id`. Provider request ids are
transport-local and may repeat across Turns, so callers must pass the exact
Turn returned by `agent wait`. `--action`, `--option`, and object-valued
`--payload` map directly to the Host interactive input. `--semantic` is a thin
shortcut that resolves exactly one matching `actions[].semantic` from the
stored interaction; the CLI must not keep a provider-to-semantic mapping.
Unknown exact interaction tuples and missing or ambiguous semantics are invalid input errors.
The first responder atomically claims the pending interaction. Later responses
with the same action/option/payload return `answered`; different responses
return `superseded`. The result exposes the request and turn ids plus that Host
disposition, without surfacing raw operation conflict or in-progress errors.
After a successful claim, an authoritative terminal runtime disposition still
wins; for example, a runtime `superseded` result must not be rewritten to
`answered` merely because the durable claim already marked the Interaction.

## Tutti Mode Plan Commands

`tutti plan` is the Agent-callable observation and proposal surface for the
Tutti-owned workspace workflow. It is available independently of the current
Tutti Mode activation badge and independently of a provider's Default or Plan
collaboration mode. The badge is host preference state; it is not CLI
authorization and it is not evidence that a workflow exists.

The flow is single-shot: one `propose` submits the complete plan and opens the
single user review checkpoint. There is no separate configuration phase and no
daemon-derived decomposition turn.

The public command set is deliberately narrow:

- `tutti plan propose --file <absolute-path> --request-id <stable-id>` creates
  the initial revision and the single review checkpoint. The document must be
  one complete `tutti-mode-plan/v1` Markdown file: the plan narrative in the
  body plus the full task graph in the `tasks` frontmatter (at least one task
  is required). `phase` may be omitted; it defaults to `task_graph`.
  Configuration-only documents are rejected. When the Tutti Host Context is
  active, read its `orchestrationIntensity` (0-100) to choose decomposition
  granularity: low values mean few coarse tasks, high values mean many
  fine-grained tasks;
- `tutti plan revise --workflow-id <id> --file <absolute-path> --request-id
<stable-id>` appends a complete replacement plan document (narrative plus full
  task graph) after the user requests changes. When the user rejects the
  review, the daemon also proactively starts a feedback turn on the source
  session instructing the Agent to revise, so the Agent does not have to poll;
- `tutti plan get --workflow-id <id>` returns the caller-session-scoped
  authoritative snapshot;
- `tutti plan wait --workflow-id <id> --checkpoint-id <id>` performs a bounded
  wait for a durable user decision or operation outcome.

Tasks may carry optional `agentTargetId`, `modelPlanId`, `model`,
`permissionModeId`, and `reasoningEffort` assignments. The user can override
these per task in the review panel; overrides are recorded with the accepted
decision and win over the document values at Issue materialization.

There is no Agent CLI approval command. Accept, reject, feedback, and cancel
remain user-owned daemon interactions. The Agent may only observe the committed
result and continue with the returned next action.

`propose` and `revise` require caller-generated request IDs because response
loss must not cause an unintentional second mutation. The durable identity is
`(workspace, source session, mutation kind, workflow scope, request ID)`.
Retrying the same key with the same exact Markdown bytes returns the original
workflow, revision, and checkpoint and reports `replayed: true`. Reusing that
key with different bytes is a conflict. A new request ID is an intentional new
mutation even when the bytes and content-addressed file are identical; a
content digest is integrity evidence, not user intent.

Workflow lookup is isolated to the Agent session supplied by the daemon CLI
runtime context. A workflow created by another source session is reported as
not found. App CLI parent-command identity is not Agent Turn or tool-call
provenance and must never be stored as such. Proposal input files must be
absolute, bounded in size, parsed by the daemon, and retained as immutable
Markdown content; CLI clients must not implement the workflow state machine.

`agent turn-resources --json` is the narrow helper for looking up resources from
one explicit session turn. It requires `--session-id` and `--turn-id`, filters at
the message query layer, and returns resource-bearing user messages with images
grouped under their source message. Do not flatten images across turns in this
command; the calling agent decides which turns to inspect and which returned
`localPath` values to pass to provider launchers as `--image`.

Agent discovery and launch are target-first. `agent list --json` returns every
enabled Agent Target in stable target order, including its exact agent id,
display name, provider metadata, current runtime availability, and an explicit
`defaultAgentTargetId` resolved from the current desktop preference. The
preference resolves to the exact built-in target id before considering another
target that shares its provider, so a user-created agent cannot silently replace
the desktop default. Preference-read failures use the built-in default instead
of failing discovery. The default identifies preference, not readiness: it may
be unavailable. An `--agent-id` filter narrows only `agents`; it does not rewrite
the global default, so the default id may be absent from a filtered response.
The command must not collapse several agents that share one provider or make
callers guess a default from list order. Callers select an exact id and start it with
`agent start --agent-id <agent-id> ...`; provider-specific command
families such as `codex start` and `claude start` are not part of the
agent-facing CLI contract. A disabled Agent Target is absent from `agent list`,
and an explicit `agent start` for its id must fail before session creation; CLI
callers cannot bypass the daemon-owned enablement state.

During the agent-id migration window, old app integrations may continue to
invoke `agent providers`, provider-based composer/skill inputs, and the exact
`codex start` / `claude start` aliases. These are compatibility adapters, not
agent-facing discovery: generated runtime skills and command guides must omit
them. A provider selector may resolve only when exactly one enabled target uses
that provider; zero or multiple matches must fail with recovery guidance to
run `agent list --json`. Target-first composer-options and skill-bundle
responses use schema version 2 and carry `agentTargetId`; compatibility
responses preserve their prior schema version.
Remove this window only after released kit consumers and organization-owned
apps have migrated and old materialized skills have crossed the support
window.

`--model` remains optional on `agent start`. When omitted, tuttid resolves the
model from the selected agent's composer defaults or its runtime provider
default. `agent start` must reject unknown or disabled agent ids and point the
caller back to `agent list`; it must never create a provider-only session.
Provider is retained as derived runtime and diagnostic metadata, not launch
identity.

`--show` on `agent start` requests AgentGUI activation only; it must not
change the created session's visibility. User-started sessions should stay on
the normal visible default; only an explicit `--hidden` launcher input should
create a hidden session.

`agent start --isolation worktree` creates the session in
`<state-dir>/agent/worktrees/<session-id>` on branch `tutti/<session-id>`, based
on the resolved launch cwd's `HEAD`. The resolved cwd follows the normal
explicit-cwd then caller-session-cwd chain. Isolation is fail-closed: a missing
git executable, non-git cwd, nested repository or submodule, or failed
`git worktree add` rejects the launch before a session is created. Source
checkout changes are not copied; a dirty source checkout produces a warning.
The session runtime context persists the worktree path, branch, and base commit,
and compact session/action JSON exposes those coordinates as `isolation`.

Successful isolated worktrees are reclaimed only by the startup and periodic
agent worktree GC. GC retains a tree when it is dirty, its branch is ahead of
the recorded base commit, its creating session remains resumable, or another
session cwd points inside it. Runtime idleness, turn completion, and session
end timestamps must not trigger worktree deletion. Every session create is
synchronized with GC from cwd resolution through canonical session persistence
or failure rollback. This prevents a sweep both from observing an isolated tree
as an in-progress orphan and from deleting a managed tree while a non-isolated
session is adopting a cwd inside it. Session creates remain concurrent with one
another; only a GC sweep takes the exclusive side of this synchronization
boundary.

## Naming Rules

Command path segments and input names use lowercase kebab-case.

Examples:

- `issue list`
- `agent get`
- `agent respond`
- `topic-id`
- `wait`
- `page-size`

Do not introduce snake_case, camelCase, spaces, or leading dashes in command
path segments or input names.

Command IDs should stay stable. Renaming a builtin command path or deleting a
builtin command is a user-visible compatibility change. It does not affect app
commands unless an app attempts to use a reserved top-level scope.

Reserved app CLI scopes are owned by builtin commands and help/status plumbing.
Workspace apps must not claim these scopes:

- `agent`
- `help`
- `issue`
- `plan`
- `status`

## Input Schema

Builtin input schema is generated from typed Go input structs. The generated
schema should stay within the same small object-only subset used by app CLI
manifests unless the daemon HTTP contract is intentionally extended:

- top-level `type: "object"`
- `properties`
- `required`
- property `type`
- property `description`

Supported property types:

- `string`
- `boolean`
- `integer`
- `array` with string items for repeatable string flags

The framework may support Go `int64` internally, but the capability schema
should still expose it as `integer`.

Repeatable string inputs are represented as `[]string` fields in builtin input
structs and emitted as `type: "array"` with `items.type: "string"`. The bundled
CLI aggregates repeated flags before invoking the daemon, so commands can expose
inputs such as `--image <path>` multiple times without provider-specific parsing
in the terminal client.

Agent launcher and send commands accept image file inputs through the builtin
agent CLI provider. The CLI provider reads supported local image files, encodes
them as image `PromptContentBlock` values, and appends them after the text block
created from `--prompt`. Keep this compatibility conversion in the CLI provider
layer; downstream agent session services should receive structured prompt
content, not raw CLI image flags.

When an agent delegates work through `agent start --agent-id <agent-id>`, local
file references in the handoff prompt should use
`[@filename](/absolute/path)` instead of bare paths. Images have two valid
representations, and the delegating agent should choose one per image: pass
`--image <localPath>` for structured visual input, or use
`[@filename](/absolute/path)` in the prompt when preserving the file reference's
prompt/turn ordering is more important. Do not duplicate the same image through
both representations unless the user explicitly asks.

Input structs should use tags for CLI field names, validation, and recovery
hints. Required inputs must include a recovery hint when a user can reasonably
discover the value with another Tutti command.

Example:

```go
type IssueListInput struct {
    TopicID   string `cli:"topic-id" validate:"required" hint:"Use issue topic list --json to discover workspace topics."`
    Status    string `cli:"status"`
    Search    string `cli:"search"`
    PageSize  int    `cli:"page-size" validate:"min=1,max=100"`
    PageToken string `cli:"page-token"`
}
```

## Input Binding And Validation

The framework owns builtin input binding.

Rules:

- ignore unknown inputs for forward compatibility across app and daemon versions
- accept strings from `apps/cli` for string, boolean, and integer fields
- parse boolean strings using ordinary CLI-friendly values such as `true` and
  `false`
- parse integer strings as base-10 integers
- reject invalid type conversions
- reject missing required inputs
- enforce declared numeric ranges
- keep business-specific cross-field validation in command code

Error wording should be consistent:

- missing required input: `required input "topic-id" is missing`
- invalid input: `invalid input "page-size"`

All builtin input validation failures must wrap `cliservice.ErrInvalidInput` so
the existing invoke route status-code mapping remains stable.

## Recovery Hints

Recovery hints are diagnostic guidance for humans and agents. They are not a
stable localization contract.

Required inputs should include a hint when there is a known discovery command.
For example, `topic-id` should mention `issue topic list`.

Until the HTTP invoke error response has a structured hint field, framework
input errors may include the hint in the diagnostic message while still
wrapping `cliservice.ErrInvalidInput`.

When a structured invoke error hint is added later, add it as an optional
backward-compatible field and keep existing error classification stable.

## Workspace Resolution

Builtin specs must declare their workspace policy:

- `required`: a workspace is required, and startup workspace resolution may be
  used when the request does not provide one
- `startup-default`: use the requested workspace when provided, otherwise use
  the startup workspace
- `optional`: the command may run without a workspace

Workspace resolution belongs in `tuttid`, not in `apps/cli`.

Workspace app commands keep using `appcli.Registry` workspace resolution. Do
not route app commands through the builtin framework to reuse workspace logic.
Do not apply builtin summary/detail JSON view projection to app command output.

## Output Contract

Builtin output formatting is generated from the command output spec and the
typed business result.

The framework should support these output shapes:

- table columns plus row projection
- summary JSON projection
- detail JSON projection
- plain text projection
- markdown text projection

Do not use reflection to expose entire business structs as CLI JSON. JSON
output should be an explicit projection so runtime-only fields, private fields,
large payloads, and unstable implementation details do not leak into the CLI
contract.

For list commands:

- terminal default should usually be `table`
- JSON default must be `summary`
- summary JSON should include the records needed for automation plus pagination
  metadata when available
- lists are for discovery; use the matching get command for detailed context

For get commands:

- default output should usually be `json`
- JSON default must be `detail`
- detail JSON should include the detailed record and closely related child
  records or context

For action commands:

- output should confirm the action result without dumping full state
- table output is acceptable for interactive terminal use
- JSON default must be `summary`
- summary JSON should be compact and script-friendly

Builtin commands should not use a bare JSON formatter. They should declare
`JSONViews` with the default view required by their command kind. Raw JSON is
allowed only for narrow existing payloads with `RawJSON: true` and a reason.

Summary JSON must not include obvious UI or audit fields such as
`creatorAvatarUrl`, `creatorDisplayName`, or `creatorUserId`. It should also
avoid large default fields such as `content`, `runtimeContext`, `contextRefs`,
or unbounded messages. Do not use reflection to expose whole business records.

The existing `--json` CLI behavior remains client-side compatible: the client
requests JSON output mode, and the daemon chooses the stable JSON view declared
by the command spec.

## Client Compatibility

`apps/cli` should remain a thin daemon client.

It may:

- discover capabilities
- match command path segments
- parse flags according to `InputSchema`
- request JSON when `--json` is present
- render `CommandOutput`

It must not:

- duplicate daemon business validation
- resolve workspace business rules
- call desktop, renderer, or agent runtime internals directly
- hardcode builtin command-specific output logic beyond temporary positional
  argument conveniences already owned by the CLI

Future CLI enhancements such as non-TTY default JSON, `--format full`, and
structured recovery hint rendering are client features. They should be added
after the daemon framework exists and should not be required for builtin
framework migration.

## Compliance

Framework tests should cover:

- struct tags to input schema generation
- string, boolean, integer, and int64 binding
- required input validation
- numeric min/max validation
- unknown input is ignored
- no-input commands ignore extra input
- table, JSON, plain, and markdown output formatting
- command registration defaults

Builtin command compliance tests should assert:

- each builtin command has a valid spec
- capabilities match the generated spec
- command path segments and input names are kebab-case
- required inputs have hints when discoverable
- list commands declare compact JSON or an explicit opt-out reason
- declared default output mode has a formatter
- app CLI commands are not validated as builtin framework commands

Run focused daemon CLI tests before finishing framework or provider changes.
Broader daemon changes should also follow the normal `services/tuttid`
validation rules.
