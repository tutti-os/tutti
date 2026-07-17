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
input and output. Every request and event carries `"version": 2`; either side
rejects unsupported or missing versions instead of guessing compatibility.
Protocol types and validation live in `src/protocol.ts`.

Interactive responses use `(turnId, requestId)` identity. The sidecar keeps a
bounded terminal disposition registry so `submit_interactive` is idempotent:
an identical replay reports `answered` without resolving the SDK permission
promise twice, while a changed replay reports `conflict`.
`interactive_disposition` lets the daemon recover when a submission was
applied but its acknowledgment was lost; transport ambiguity therefore remains
non-terminal until the sidecar reports an authoritative disposition.

## Module layout

`src/main.ts` only owns the stdio server and request routing. Session lifecycle,
stream projection, tools, interactions, compaction, usage, configuration, and
diagnostics live in focused modules coordinated by `src/sessionRuntime.ts`.
The full ownership and dependency rules are documented in
[`docs/architecture/claude-code-sdk-runtime.md`](../../../docs/architecture/claude-code-sdk-runtime.md).

## Runtime dependencies

- `@anthropic-ai/claude-agent-sdk`
- `zod`

## Model discovery benchmark

Measure the same SDK initialization call used to populate Claude model options:

```sh
pnpm --filter @tutti-os/claude-sdk-sidecar benchmark:model-discovery -- \
  --iterations 5 --cwd /path/to/workspace
```

Each iteration runs in a fresh Node process and reports SDK import, query
construction, `initializationResult()`, same-process `reinitialize()`, and
total process timings as newline-delimited JSON. Pass
`--claude-bin /path/to/claude` to measure a provisioned Claude executable
instead of the SDK-native optional dependency. The benchmark never submits a
prompt and denies all tool calls.

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
