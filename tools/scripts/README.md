# Scripts

This directory is reserved for repository scripts such as:

- build helpers
- packaging helpers
- code generation entrypoints
- validation tasks

Current examples include:

- `dev-gui.sh` for checking local prerequisites, preparing workspace
  dependencies, downloading and building the development `tuttid` binary, and
  launching the desktop GUI with `TUTTID_BIN`
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
- `capture-electron-trace.mjs` for recording desktop Electron performance
  traces through CDP stream mode without opening the DevTools Performance export
  UI
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

Example desktop trace capture:

```bash
TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT=9223 \
TUTTI_ELECTRON_JS_FLAGS=--max-old-space-size=8192 \
make dev-gui

pnpm trace:desktop -- --duration 15
```
