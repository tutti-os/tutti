# Scripts

This directory is reserved for repository scripts such as:

- build helpers
- packaging helpers
- code generation entrypoints
- validation tasks

Current examples include:

- `dev-gui.sh` for checking local prerequisites, preparing workspace
  dependencies, downloading and building the development `nextopd` binary, and
  launching the desktop GUI with `NEXTOPD_BIN`
- `setup-dev.mjs` for checking local developer prerequisites such as pinned lint tooling
- `setup-dev.mjs --install=golangci-lint` for installing the pinned Go lint tool
- `generate-defaults.mjs` for generating shared Go and desktop TypeScript defaults from `config/nextop.defaults.json`
- `generate-openapi.mjs` for generating Go and TypeScript API contract artifacts from `services/nextopd/api/openapi/nextopd.v1.yaml`
- `smoke-desktop-transport.mjs` for daemon transport smoke validation
- `check-i18n.mjs` for desktop locale parity, placeholder parity, i18n key references, and hardcoded user-visible copy candidates
- `check-electron-runtime-boundaries.mjs` for Electron `main`/`preload` runtime import graph checks that catch React/TSX leaks and externalized workspace packages that resolve to raw source files
- `check-ui-boundaries.mjs` for shared UI boundary enforcement across imports, CSS, SVG usage, and desktop Tailwind `@source` coverage for workspace packages that declare `nextop.tailwindSourceRoot`
- `build-nextop-app-release.mjs` for packaging an external Tutti app into a zip plus `release.json` and `latest.json`
- `build-nextop-app-catalog.mjs` for merging app `release.json` files into the App Center remote catalog
- `bump-nextop-app-version.mjs` for incrementing a Nextop app manifest semver version before release
- `build-nextop-app-runtime-catalog.mjs` for merging managed app runtime artifact metadata into the runtime download catalog
- `lark-log-tool.mjs` for fetching Feishu/Lark message file attachments or Base bug-record attachments with `lark-cli`, extracting Tutti log bundles, summarizing repeated log failures around an anchor time, and optionally watching appended warn/error lines in real time

  ```bash
  pnpm lark:logs -- fetch --url '<feishu-applink>' --issue 'interactive request is no longer live' --analyze
  pnpm lark:logs -- fetch --base-url '<feishu-base-url>' --record-url '<feishu-record-url>' --issue 'cannot submit reply' --analyze
  pnpm lark:logs -- fetch --record-url '<feishu-record-url>' --base-token '<base-token>' --table-id '<table-id-or-name>' --issue 'cannot submit reply' --analyze
  pnpm lark:logs -- fetch --record-url '<feishu-record-url>' --issue 'cannot submit reply' --analyze
  pnpm lark:logs -- analyze /path/to/nextop-logs.zip --anchor '2026-06-05 20:17' --issue 'event stream mismatch'
  ```

  The short `--record-url` form reads defaults from the first existing config:
  - `./.nextop-logger-fetcher.json`
  - `~/.config/nextop-logger-fetcher/config.json`
  - `~/.codex/skills/nextop-logger-fetcher/config.json`

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
