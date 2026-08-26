# @tutti-os/claude-sdk-sidecar

Sidecar process that bridges the Tutti agent runtime to the
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

Unlike the other `@tutti-os/*` release packages, this package ships **raw
TypeScript** under `src/` rather than a compiled `dist/`. It is executed
directly with Node's type-stripping loader:

```sh
node --experimental-strip-types ./src/main.ts
```

Consumers (the Tutti daemon, the desktop bundle, and `tsh`'s `npm-bundle-dir`)
pull this package into `node_modules`, install its runtime `dependencies`, and
launch `src/main.ts` with `--experimental-strip-types`. There is therefore no
build step and no bundled entry point beyond the source files.

## Sidecar protocol

The daemon and sidecar exchange newline-delimited JSON envelopes over standard
input and output. Every request and event carries `"version": 10`; either side
rejects unsupported or missing versions instead of guessing compatibility.
Protocol types and validation live in `src/protocol.ts`.

Protocol version 10 makes cancellation deadlines part of the request contract.
The daemon supplies separate cooperative-interrupt and consumer-drain budgets.
If Claude Code does not acknowledge the SDK interrupt within its budget, the
sidecar closes the owned Query transport, which terminates the Query's Claude
Code process, then waits only for the bounded drain budget before responding.
Every cancellation phase is emitted to stderr with the
`CLAUDE_CODE_CANCEL_DIAGNOSTIC` prefix and one JSON payload containing request,
Session, Turn, Query-generation, duration, and outcome fields; prompts, tool
inputs, credentials, and raw provider output are never included.

Protocol version 7 adds the stateless `recover_turn_binding` read. It resolves
exactly one root user-message UUID from an opaque recovery token, or performs a
fail-closed HMAC equality check for complete legacy text, and returns Claude's
provider Turn plus checkpoint identities without mutating provider history.

Protocol version 6 adds background-task level and continuation diagnostics.
`background_tasks_changed` is a full replace-set of currently running SDK
background tasks, not a terminal root-turn signal. When the set becomes empty,
the sidecar records a pending continuation. If the ordinary root result arrives
while that continuation is already pending, the original turn stays active
until session idle; no terminal/start pair is emitted. A synthetic continuation
is reserved only when the pending signal arrives after the root already
settled. Results whose
`origin.kind` is `task-notification` confirm background follow-up output without
assuming one result per notification. The SDK's `session_state_changed: idle`
event authoritatively settles the continuation after its background loop
drains. A follow-up result never starts a local settlement timer because later
queued follow-ups may legitimately take several seconds to begin. The synthetic
turn keeps the existing running/processing presentation. If root output does
not begin within 30 seconds, the sidecar emits a `continuation_delayed` warning,
completes the synthetic reservation, interrupts the pending query, and rejects
that continuation's late output.
Background-level events include aggregate provider and projected-task counts so
diagnostics can expose missing terminal task edges without logging task
descriptions or prompts.

`inspect_fork_checkpoints` and `fork_session` are stateless requests: they do
not create a `SessionRuntime` or resume a query. They use the official SDK
session APIs and return identities plus a provider-owned binding receipt;
prompt and tool content never cross this protocol boundary. A persisted
`providerCheckpointMessageId` avoids reading the source transcript. Legacy
Turns without that field perform one source lookup at Fork execution time.

`fork_session` calls the official `forkSession(..., {upToMessageId, title})`
mutation directly. Claude allocates the provider child UUID, while Host keeps
the canonical target Agent Session ID deterministic. The driver therefore does
not attest deterministic provider identity: after mutation starts, any SDK or
verification failure is `unknown` and must never be replayed. A trailing system
message may be present in the provider-owned child file but hidden by
`getSessionMessages()` until a later message extends the chain. The driver
therefore binds the selected remapped child root UUID and the last SDK-visible
child checkpoint without comparing source and child message content. Task
notifications and internal synthetic user messages extend the checkpoint when
visible, but are not treated as origin root Turns.
Top-level Claude `user` messages that carry `tool_result` blocks likewise stay
inside the preceding root Turn checkpoint and never become independent Turn
bindings.

For live Turns, the UUID supplied on the outbound SDK user message is a
`promptCorrelationId` only because Claude Code may rewrite it in the durable
transcript. `SessionRuntime` causally binds the next expected root prompt echo
to its canonical Turn, takes provider identity from the observed root
user-message UUID, and emits `provider_turn_identity_resolved`. Some successful
SDK queries omit that echo from the live iterator. A shared, idempotent
single-flight identity barrier runs before every root assistant, stream, tool,
approval, user-input, and result projection. It uses the official
`getSessionMessages()` transcript read to resolve exactly one root user message
by the opaque correlation UUID, with a bounded cancellable retry window for
transcript persistence lag.

Fallback and pre-identity Query terminals emit sanitized stderr records with
the `CLAUDE_CODE_PROVIDER_TURN_DIAGNOSTIC` prefix. The daemon forwards them as
`agent_session.claude_sdk.provider_turn_diagnostic` structured logs.
A dispatched Turn that still has no provider Turn identity after two minutes
emits one structured warning with the same event name. This diagnostic timer
does not cancel, fail, or otherwise change the Turn.

The daemon synchronously persists the canonical Turn, provider Session, and
provider Turn binding when it receives `provider_turn_identity_resolved`. Only
after that durable barrier succeeds does it publish canonical
`root_provider_turn.started` and allow later output or interaction events to
proceed. Checkpoint and terminal events use the same bound provider Turn ID and
never fall back to the outbound correlation UUID.

Exact cancellation returns a structured `pre_accept`, `provider_active`,
`absent`, or `mismatch` disposition. An undispatched Turn or deferred Goal
command can be removed locally. A dispatched Turn is fenced immediately, but
its terminal event is emitted only after the Query reaches an authoritative
shutdown boundary: either the SDK acknowledges the interrupt or the sidecar
closes the owned Query transport and its consumer drains. `provider_active`
includes the resolved provider Turn ID so the
daemon can wait for that exact Turn's durable acceptance result before it
confirms cancellation; failures and unknown dispositions remain fail-closed.

Interactive responses use `(turnId, requestId)` identity. The sidecar keeps a
bounded terminal disposition registry so `submit_interactive` is idempotent:
an identical replay reports `answered` without resolving the SDK permission
promise twice, while a changed replay reports `conflict`.
`interactive_disposition` lets the daemon recover when a submission was
applied but its acknowledgment was lost; transport ambiguity therefore remains
non-terminal until the sidecar reports an authoritative disposition.

Claude plan files keep the SDK default directory unless the host opts in to a
different location. A host can set `TUTTI_CLAUDE_PLANS_DIRECTORY` in the
session environment; the sidecar forwards its non-empty value through the
SDK-native `plansDirectory` setting.

## Module layout

`src/main.ts` only owns the stdio server and request routing. Session lifecycle,
stream projection, tools, interactions, compaction, usage, configuration, and
diagnostics live in focused modules coordinated by `src/sessionRuntime.ts`.
The full ownership and dependency rules are documented in
[`docs/architecture/claude-code-sdk-runtime.md`](../../../docs/architecture/claude-code-sdk-runtime.md).

## Runtime dependencies

- `@anthropic-ai/claude-agent-sdk`
- `zod`

## Environment propagation

The sidecar is launched directly without a shell, so user shell hooks (such
as CC-Switch) that inject proxy credentials into `process.env` never reach
the Claude SDK. To preserve parity with the native `claude` CLI, the sidecar
reads Claude settings files and merges their `env` blocks into the SDK query
options.

Merge precedence (lowest to highest):

1. `process.env` at sidecar start
2. `env` entries from `${CLAUDE_CONFIG_DIR}/settings.json` (defaulting to
   `~/.claude/settings.json`)
3. `env` entries from project-level `.claude/settings.json` and
   `.claude/settings.local.json`, walking from the filesystem root down to
   the session `cwd` (deeper directories win, `settings.local.json`
   overrides `settings.json` in the same directory)
4. ACP payload `env` injected by tuttid for the active session

Only string-typed entries from the settings files are forwarded; non-string
values are skipped. A missing file, malformed JSON, or absent `env` block
contributes nothing and never blocks session start.

This is the same pattern that the native Claude CLI uses, so credentials
configured by tools such as CC-Switch (e.g. `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`) flow through to the Claude SDK exactly as they would
in a terminal session.
