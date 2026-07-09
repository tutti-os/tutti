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

## Runtime dependencies

- `@anthropic-ai/claude-agent-sdk`
- `zod`

## Environment propagation

The sidecar is launched directly without a shell, so user shell hooks (such
as CC-Switch) that inject proxy credentials into `process.env` never reach
the Claude SDK. To preserve parity with the native `claude` CLI, the sidecar
reads `${CLAUDE_CONFIG_DIR}/settings.json` (defaulting to `~/.claude`) and
merges the file's `env` block into the SDK query options.

Merge precedence (lowest to highest):

1. `process.env` at sidecar start
2. `env` entries from `${CLAUDE_CONFIG_DIR}/settings.json`
3. ACP payload `env` injected by tuttid for the active session

Only string-typed entries from the settings file are forwarded; non-string
values are skipped. A missing file, malformed JSON, or absent `env` block
returns an empty object and never blocks session start.

This is the same pattern that the native Claude CLI uses, so credentials
configured by tools such as CC-Switch (e.g. `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`) flow through to the Claude SDK exactly as they would
in a terminal session.
