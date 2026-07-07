# Trae Solo Bridge Built-in App

Purpose: built-in Tutti workspace app that bridges a workspace prompt into the standalone Trae Solo desktop app. It is not a Tutti Agent Provider Adapter.

Runtime:

- `bootstrap.sh` requires `TUTTI_APP_PORT` and `TUTTI_APP_NODE`.
- `server.js` binds `$TUTTI_APP_HOST:$TUTTI_APP_PORT`.
- Durable run metadata is stored in `$TUTTI_APP_DATA_DIR/runs.json`.
- Runtime scratch/log files must stay under the runner-provided data/runtime/log directories.

Solo app identity:

- macOS app: `/Applications/TRAE SOLO CN.app`
- bundle id: `cn.trae.solo.app`
- CLI: `/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin/trae-solo-cn`

Supported Solo modes:

- `work`: Work / PPT mode
- `code`: programming / Code mode
- `design`: frontend design / Design mode

Flow:

1. User enters a project directory, Solo mode, and prompt in the app UI.
2. `/api/launch` validates the project directory, creates `.tutti-trae-solo/<runId>.result.md`, builds a Trae Solo-ready instruction prompt, and copies it to macOS clipboard as fallback.
3. New-session CLI transfer uses DevTools/CDP to control Trae Solo in the background. Do not call `activate`; the bridge should not bring Trae Solo to the foreground.
4. The bridge hides Trae Solo after startup/project focus/send attempts. A first macOS launch may flash briefly, but normal operation must not steal focus.
5. Result retrieval remains file-based through `/api/result/<runId>`.

Modification guidance:

- Keep this package self-contained.
- Do not write durable state under `TUTTI_APP_PACKAGE_DIR`.
- Keep user-visible browser copy inside `server.js` unless/until this package gets a separate frontend build/i18n layer.
- If Trae exposes a stable local result/session API later, replace CDP/file polling with that API.
