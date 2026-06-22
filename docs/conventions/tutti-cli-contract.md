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

## Frozen App CLI Contract

The app CLI path is a compatibility boundary for workspace apps.

Keep these semantics stable unless the app CLI manifest version changes:

- `tutti.app.json` points to the app-owned CLI manifest path
- `tutti.cli.json` uses `schemaVersion: "tutti.app.cli.v1"`
- `appcli/manifest.go` reads and validates the manifest shape
- `appcli.Registry` normalizes input according to the manifest input schema
- `appcli.Registry` invokes the app handler with the
  `tutti.app.cli.invoke.v1` envelope
- app handlers receive HTTP `POST` requests under `/tutti/cli/*`
- app handlers return the existing `CliCommandOutput` shape
- app command output is validated against the manifest-declared output contract

Do not require migration for existing app manifests when changing builtin CLI
implementation internals.

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

The framework may support Go `int64` internally, but the capability schema
should still expose it as `integer`.

Input structs should use tags for CLI field names, validation, and recovery
hints. Required inputs must include a recovery hint when a user can reasonably
discover the value with another Tutti command.

Example:

```go
type IssueListInput struct {
    TopicID   string `cli:"topic-id" validate:"required" hint:"Use issue topic list to discover workspace topics."`
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
