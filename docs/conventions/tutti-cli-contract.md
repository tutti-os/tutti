# Tutti CLI Contract

This document defines the durable contract for Tutti CLI commands exposed
through the local daemon.

The bundled CLI is a thin client. It discovers command capabilities from
`tuttid`, matches command paths, parses flags using daemon-provided
`InputSchema`, invokes the daemon command endpoint, and renders the returned
`CommandOutput`.

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
agent session actions, this normally means session id, provider, status, and
whether a launch/open request was published.

Agent session compact/detail JSON may include additive runtime protocol fields
such as `turnLifecycle` and `submitAvailability` when the daemon has them. Keep
their field names aligned with the HTTP/OpenAPI session shape so CLI callers can
reason about active turns without switching transports.

Issue-manager breakdown commands should preserve authored task order in the
daemon instead of relying on callers to serialize several single-task creates.
Use `issue task create-batch` for multiple new child tasks. Its `tasks-json`
input is a JSON array of task objects, and the daemon appends tasks in array
order with contiguous issue-local `sortIndex` values.

`agent session-summary --json` returns compact message records for agent-session
mentions. When a compact message contains image prompt content, include an
`images` array with `attachmentId`, `mimeType`, `name`, and a daemon-local
`localPath` when the attachment file is available on disk. Keep `payload`
omitted from this compact shape; expose only fields useful for agent context
recovery.

`agent turn-resources --json` is the narrow helper for looking up resources from
one explicit session turn. It requires `--session-id` and `--turn-id`, filters at
the message query layer, and returns resource-bearing user messages with images
grouped under their source message. Do not flatten images across turns in this
command; the calling agent decides which turns to inspect and which returned
`localPath` values to pass to provider launchers as `--image`.

Provider launcher commands such as `codex start` and `claude start` should keep
`--model` optional. When omitted, tuttid resolves the model from composer
defaults or the provider configured/default model before starting the session.

## Naming Rules

Command path segments and input names use lowercase kebab-case.

Examples:

- `issue list`
- `agent session-summary`
- `topic-id`
- `after-version`
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

When an agent delegates work through `codex start` or `claude start`, local file
references in the handoff prompt should use `[@filename](/absolute/path)`
instead of bare paths. Images have two valid representations, and the delegating
agent should choose one per image: pass `--image <localPath>` for structured
visual input, or use `[@filename](/absolute/path)` in the prompt when preserving
the file reference's prompt/turn ordering is more important. Do not duplicate the
same image through both representations unless the user explicitly asks.

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
