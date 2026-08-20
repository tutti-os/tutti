# Scripts

This directory is reserved for repository scripts such as:

- build helpers
- packaging helpers
- code generation entrypoints
- validation tasks

Current examples include:

- `dev-gui.sh` for checking local prerequisites, preparing workspace
  dependencies, downloading and building the development `tuttid` binary, and
  launching the desktop GUI with `TUTTID_BIN`; the renderer dev server warms
  its reachable module graph before Electron opens. Agent Extensions use their
  configured signed remote releases by default. The command clears inherited
  Kimi Code package overrides so stale shell or launchd state cannot shadow the
  release used by the shipped product; set `DEV_GUI_KIMI_CODE_PACKAGE_DIR` to
  an explicit unpacked package path only when testing a local package. When the
  package comes from the standard Kimi Extension repository layout, the script
  also discovers its local account-usage Helper so an unpublished development
  package can exercise API billing without weakening the production install
  contract. `DEV_GUI_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE` selects an explicit
  Helper when the layout differs. The standard layout points at the Helper's
  self-contained `dist/cli.cjs` build. The script canonicalizes these paths and
  fails before launch when an account-usage profile declares a Helper but its
  executable build is missing
- `renderer-dev-warmup.mjs` for moving cold Vite and React Compiler transforms
  ahead of the Electron launch during desktop development
- `setup-dev.mjs` for checking local developer prerequisites such as pinned lint tooling
- `setup-dev.mjs --install=golangci-lint` for installing the pinned Go lint tool
- `generate-defaults.mjs` for generating shared Go and desktop TypeScript defaults from `config/tutti.defaults.json`
- `generate-openapi.mjs` for generating Go and TypeScript API contract artifacts from `services/tuttid/api/openapi/tuttid.v1.yaml`
- `smoke-desktop-transport.mjs` for daemon transport smoke validation
- `push-checked.mjs` for fetching the current branch, stopping before
  `check:full` when the remote branch already has new commits, then pushing
  with an explicit `--force-with-lease` against the fetched remote head
- `check-i18n.mjs` for desktop locale parity, placeholder parity, i18n key references, and hardcoded user-visible copy candidates
- `check-electron-runtime-boundaries.mjs` for Electron `main`/`preload` runtime import graph checks that catch React/TSX leaks and externalized workspace packages that resolve to raw source files
- `check-ui-boundaries.mjs` for shared UI boundary enforcement across imports, CSS, SVG usage, and desktop Tailwind `@source` coverage for workspace packages that declare `tutti.tailwindSourceRoot`
- `build-tutti-app-release.mjs` for packaging an external Tutti app into a zip plus `release.json` and `latest.json`
- `build-tutti-app-catalog.mjs` for merging app `release.json` files into the App Center remote catalog
- `build-tutti-app-runtime-catalog.mjs` for merging managed app runtime artifact metadata into the runtime download catalog
- `apps/desktop/scripts/vendor-managed-posix-shell.mjs` for assembling the
  pinned minimal managed POSIX shell used by packaged Windows Desktop adapters;
  CI downloads and verifies the archive from
  `config/tutti.managed-posix-shell.lock.json`, while local packaging may set
  `TUTTI_MSYS2_BASE_ARCHIVE` to an already downloaded matching archive
  (the caller passes the target platform explicitly)
- `capture-electron-trace.mjs` for recording desktop Electron performance
  traces through CDP stream mode without opening the DevTools Performance export
  UI
- `run-agent-gui-performance.mjs` for starting an isolated Desktop from a
  consistent backup of the developer database, running a selected AgentGUI or
  window interaction, capturing its exact trace window, and generating
  report-only JSON and Markdown summaries. It reuses a fresh production
  Desktop bundle when available, so each run starts the isolated Electron
  process directly instead of starting a new Vite renderer dev server.
- `lark-log-tool.mjs` for fetching Feishu/Lark message file attachments or Base bug-record attachments with `lark-cli`, extracting Tutti log bundles, summarizing repeated log failures around an anchor time, and optionally watching appended warn/error lines in real time

  ```bash
  pnpm lark:logs -- fetch --url '<feishu-applink>' --issue 'interactive request is no longer live' --analyze
  pnpm lark:logs -- fetch --base-url '<feishu-base-url>' --record-url '<feishu-record-url>' --issue 'cannot submit reply' --analyze
  pnpm lark:logs -- fetch --record-url '<feishu-record-url>' --base-token '<base-token>' --table-id '<table-id-or-name>' --issue 'cannot submit reply' --analyze
  pnpm lark:logs -- fetch --record-url '<feishu-record-url>' --issue 'cannot submit reply' --analyze
  pnpm lark:logs -- analyze /path/to/tutti-logs.zip --anchor '2026-06-05 20:17' --issue 'event stream mismatch'
  ```

  The short `--record-url` form reads defaults from the first existing config:
  - `./.tutti-logger-fetcher.json`
  - `~/.config/tutti-logger-fetcher/config.json`
  - `~/.codex/skills/tutti-logger-fetcher/config.json`

  Example:

  ```json
  {
    "bugRecord": {
      "baseToken": "app_xxx",
      "tableId": "tbl_xxx",
      "viewId": "vew_xxx",
      "attachmentField": "日志",
      "recordTimeField": "反馈时间"
    }
  }
  ```

Core product behavior should graduate into Go services or first-class tools rather than remain in shell scripts indefinitely.

## Agent Session Replay recording

This repository owns the generic Electron record/replay runner. QA case
metadata, scenario modules, fixtures, Cassettes, and evidence live in the
separate `tutti-agent-session-replay-cases` repository.

Record mode receives the case-owned module explicitly:

```bash
pnpm e2e:agent-gui -- \
  --record .tmp/cassettes/c01_codex \
  --scenario c01 \
  --scenario-file ../tutti-agent-session-replay-cases/cases/c01/scenario.mjs
```

`run-agent-session-replay.mjs` owns CLI mode selection and record/replay
orchestration. It validates that the external module's exported scenario ID
matches `--scenario`. Cassette validation and artifacts, isolated runtime
setup, and recording project preparation remain in
`agent-session-replay-runner/`.

Example desktop trace capture:

```bash
TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT=9223 \
TUTTI_ELECTRON_JS_FLAGS=--max-old-space-size=8192 \
make dev-gui

pnpm trace:desktop -- --duration 15
```

Automated AgentGUI performance reports:

```bash
pnpm perf:agent-gui
pnpm perf:agent-gui -- --list-scenarios
pnpm perf:agent-gui -- --scenario session-switch
pnpm perf:agent-gui -- --scenario virtualized-streaming
pnpm perf:agent-gui -- --scenario composer-input
pnpm perf:agent-gui -- --scenario provider-status-focus-refresh --all-process-time-profile
```

The command reads `~/.tutti-dev/tuttid.db` by default and uses SQLite online
backup to create a temporary copy. It never writes the source database. The
copy keeps projects, sessions, and rail data, but clears recoverable operation
queues and the selected AgentGUI session before starting an isolated daemon and
Electron `userData` directory. This prevents the diagnostic run from resuming a
real provider session while avoiding a schema-sensitive fixture.
All scenarios run with invisible, non-activating Electron windows while keeping
the real renderer, compositor, and CDP trace pipeline active. Native pointer
events pass through those windows; scenario interaction is injected through
CDP.

Outputs are stored under
`.tmp/perf/agent-gui/<scenario>/<timestamp>/`: `trace.json`,
`report.json`, `report.md`, and `desktop.log`. Metric values are report-only;
only infrastructure, scenario, trace, or analysis failures return a non-zero
exit code. Available scenarios also cover deterministic streaming into an
already virtualized transcript, fresh-scope Rail reveal, hero composer
prompt-tip layout measurement during resize, per-character composer input,
IME composition, `@` panel keyboard navigation in a restored dock composer,
internal Workbench window lifecycle, and native Electron window state changes.
The streaming scenario rewrites only the isolated snapshot and shadows
`cursor-agent` only inside the isolated Desktop process, so it cannot send input
to an installed Agent provider. The native window scenarios are currently
macOS-only. Use `--source-db`,
`--from-target-id`, or `--to-target-id` to override the defaults.

The `provider-status-focus-refresh` scenario dispatches a second synthetic
workspace focus and observes the page for one second, then proves neither focus
starts a provider-status request. On macOS,
`--all-process-time-profile` additionally writes `time-profile.trace` for all
processes, including `tuttid` and short-lived provider CLIs that are outside the
Chromium trace.

The Markdown report contains scenario assertions, observed milestone phases,
renderer-main `RunTask`/layout/paint metrics, React component fanout, and static
repository declaration links for components that resolve unambiguously. It
reports `ungraded` without a comparable baseline; it does not turn raw duration
or render counts into a pass/fail verdict. Source links are ownership hints,
not runtime stack attribution.

`analyze-electron-trace.mjs` is marker- and scenario-neutral. Interactive
automation lives in scenario modules registered by
`agent-gui-performance-scenarios.mjs`; each owns preparation, execution,
milestones, completion, and assertions. New scenarios should reuse the runner
and analyzer through that boundary. Native close/reopen is intentionally not
mixed into the renderer-marked native-window scenario because it destroys the
renderer that owns the start/end markers.

SQLite migrations are forward-only. If the developer database was last opened
by a newer checkout with incompatible Agent target migrations, the command
reports them before starting Desktop. Use the matching checkout or provide a
compatible snapshot through `--source-db`; the runner does not downgrade the
source.
