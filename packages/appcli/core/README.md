# App CLI Core

`packages/appcli/core` owns the reusable Go implementation of the App CLI
protocol contract used by workspace apps.

The package is intentionally limited to protocol-level behavior:

- `tutti.app.cli.v1` manifest reading and validation
- command capability construction from a manifest and host-provided app metadata
- manifest input normalization
- `tutti.app.cli.invoke.v1` HTTP invoke envelopes
- handler response decoding and output contract validation
- wait-command execution metadata and validated pending continuations
- scope conflict and reserved-scope state calculation

Host products keep their own workspace lookup, durable state, app package
metadata, runtime startup, and user-facing status DTO adapters outside this
module. Tutti daemon integration lives in `services/tuttid/service/cli/appcli`.

The protocol strings still use the frozen Tutti App CLI contract for backwards
compatibility with existing app manifests and handlers. That does not make this
module a Tutti daemon business layer; consumers such as TSH can reuse the
protocol core while supplying their own host adapters.

## Wait commands

An app command that semantically waits for a run, session, or other durable
execution declares `execution.mode` as `wait`. Its handler returns an ordinary
final output when the execution reaches a stop point. While the execution is
still active, the handler returns a validated `continuation` with state
`pending` and a bounded `retryAfterMs` delay.

The terminal CLI consumes continuations automatically. One visible command
therefore remains active across multiple handler invocations; callers do not
poll and do not pass a follow flag. The CLI-owned `--timeout-ms` option is an
optional total wait deadline. When it expires, the command returns a successful
JSON observation with `reason: "wait_timeout"`, `timedOut: true`, and
`executionContinues: true`; it never cancels the underlying execution.

Handler `timeoutMs` remains a per-invocation transport budget. It is not a
workflow or total wait timeout.
