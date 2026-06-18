# Package Builder

Use this reference when adding or changing an app-owned `scripts/package-tutti-app.mjs`.

## Role

The app repository owns build orchestration. `$tutti-workspace-app-factory` owns the final package contract. Do not fork manifest/runtime rules; read the factory skill before changing package outputs.

## Builder Responsibilities

The package builder should:

- Run or depend on app build outputs for shared, web, and server code.
- Bundle server code for the managed Node runtime.
- Bundle worker and MCP entrypoints when the app needs background jobs or local agent tools.
- Generate or copy `tutti.app.json`.
- Generate or copy `tutti.cli.json` only when the app manifest declares `cli.manifest`.
- Generate executable `bootstrap.sh`.
- Include package-local `AGENTS.md`, optional `COMMANDS.md`, icons, locales, docs needed by agents, built web assets, and server bundle.
- Reject symlinks and missing required files.
- Validate package manifest, CLI manifest linkage, references endpoint linkage, and bootstrap executability.

## Bootstrap

Generated `bootstrap.sh` should:

- Resolve `TUTTI_APP_PACKAGE_DIR`, defaulting to its own directory for local direct startup.
- Export app-specific env vars from Tutti runtime env vars.
- Use `TUTTI_APP_NODE` instead of bare `node`.
- Use `TUTTI_APP_DATA_DIR`, `TUTTI_APP_RUNTIME_DIR`, and `TUTTI_APP_LOG_DIR` for mutable files.
- Set a package-local path for bundled MCP tools when local agents need them.
- Start all required child processes and clean them up on `INT`/`TERM`.

Pattern:

```sh
#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir="${TUTTI_APP_PACKAGE_DIR:-$script_dir}"

export HOST="${TUTTI_APP_HOST:-127.0.0.1}"
export APP_PORT="${TUTTI_APP_PORT:-3001}"
export APP_DATA_ROOT="${TUTTI_APP_DATA_DIR:-$package_dir/.data}"
export APP_RUNTIME_ROOT="${TUTTI_APP_RUNTIME_DIR:-$APP_DATA_ROOT/.runtime}"
export APP_WEB_DIST="$package_dir/dist"
export APP_TOOLS_MCP_PATH="$package_dir/server/tools-mcp.js"

node_bin="${TUTTI_APP_NODE:-node}"
mkdir -p "$APP_DATA_ROOT" "$APP_RUNTIME_ROOT"

"$node_bin" "$package_dir/server/server.js"
```

Keep install/build work out of `bootstrap.sh`; use `prepare.sh` only when preparation is required.

## CLI Surface

If the user asks to connect the app to the Tutti ecosystem, the app must expose a `tutti.cli.json` surface and declare it from `tutti.app.json`. Do not skip CLI integration as optional in that case. If the app has no obvious domain action yet, expose a small useful command such as `status`, `summary`, or `open-context` that proves the app is discoverable and callable.

If the app exposes `tutti.cli.json`:

- Use `schemaVersion: "tutti.app.cli.v1"`.
- Keep `scope` lowercase letters, numbers, and hyphen.
- Every command path must be non-empty and not repeat the scope.
- Every command needs `summary`, `description`, object `inputSchema`, and HTTP `POST` handler.
- Handler paths should be deterministic: `/tutti/cli/${command.path.join("/")}`.
- Route handlers must call shared use-case helpers, not duplicate business logic from `/api/*`.
- Add `COMMANDS.md` or equivalent documentation when the app has many commands.

## Validation

Package tests should assert:

- Required package files exist.
- `bootstrap.sh` is executable.
- `tutti.app.json` does not declare `runtime.kind`.
- CLI manifest exists when declared.
- CLI command handler paths start with `/tutti/cli/` and match command paths.
- Manifest localization files exist.
- No symlinks are present.
- Packaged server starts and `/api/health` or the manifest healthcheck path returns 2xx.

Run the factory validator against the generated package:

```bash
python3 <factory-skill>/scripts/validate_tutti_app_package.py build/tutti-app/package
```
