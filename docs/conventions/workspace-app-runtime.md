# Workspace App Runtime

Workspace App Center apps and daemon-managed ACP npm adapters run against a
daemon-managed runtime baseline. App packages must not bundle or declare
Python/Node versions; Tutti injects the managed runtime paths at launch.

## Runtime Baseline

The baseline runtime is componentized. The default baseline profile contains the
Python and Node components, but each component is published as a separate
platform-specific zip so tuttid can download them in parallel:

```text
python component zip:
  python/bin/python3

node component zip:
  node/bin/node
  node/bin/npm
  node/bin/npx
```

Windows runtime artifacts, when added, must use the Windows executable names expected by tuttid:

```text
python/bin/python.exe
node/bin/node.exe
node/bin/npm.cmd
```

Catalog platform keys must use Go runtime names because tuttid resolves them with `runtime.GOOS` and `runtime.GOARCH`. Use `darwin-amd64` and `linux-amd64`, not Node's `darwin-x64` or `linux-x64` download labels.

## Release Ownership

Runtime artifacts are released independently from desktop packages. Do not publish runtime artifacts from `.github/workflows/desktop-release.yml`.

The runtime release source of truth is:

```text
config/tutti.app-runtime.lock.json
```

When Python, Node, uv, supported platforms, or artifact layout changes, update the lock and run the runtime release workflow once. Fixed versions do not require rebuilding on every product release.

The workflow is:

```text
.github/workflows/publish-tutti-app-runtime.yml
```

The workflow:

1. Installs the pinned uv version.
2. Uses uv to install the pinned Python baseline.
3. Downloads the pinned Node release for each platform and verifies it against Node's `SHASUMS256.txt`.
4. Assembles separate Python and Node zips per platform.
5. Writes metadata for each platform's runtime components.
6. Uploads immutable component zips to S3.
7. Builds and uploads `catalog.json`.

Runtime artifacts should be uploaded under a dedicated S3 prefix, normally:

```text
tutti-app-runtimes/<runtimeVersion>/<platform>/python/tutti-app-runtime-python-<platform>-<runtimeVersion>.zip
tutti-app-runtimes/<runtimeVersion>/<platform>/node/tutti-app-runtime-node-<platform>-<runtimeVersion>.zip
tutti-app-runtimes/catalog.json
```

The public artifact base URL must point at the same prefix, usually through CloudFront:

```text
https://<cloudfront-domain>/tutti-app-runtimes
```

When `TUTTI_APP_RUNTIME_CATALOG` is unset, tuttid uses the default published runtime catalog:

```text
https://d1x7gb6wqsqmnm.cloudfront.net/tutti-app-runtimes/catalog.json
```

Artifacts are immutable and should use long cache headers. The catalog is mutable and should use a short cache header.

## Catalog Shape

The runtime catalog consumed by tuttid has this shape:

```json
{
  "schemaVersion": "tutti.app.runtimes.v2",
  "runtimes": {
    "darwin-arm64": {
      "version": "2026.06.0",
      "components": {
        "python": {
          "version": "3.12.13",
          "artifactUrl": "https://cdn.example.test/tutti-app-runtimes/2026.06.0/darwin-arm64/python/tutti-app-runtime-python-darwin-arm64-2026.06.0.zip",
          "artifactSha256": "64-char-sha256",
          "artifactSizeBytes": 123
        },
        "node": {
          "version": "22.22.3",
          "artifactUrl": "https://cdn.example.test/tutti-app-runtimes/2026.06.0/darwin-arm64/node/tutti-app-runtime-node-darwin-arm64-2026.06.0.zip",
          "artifactSha256": "64-char-sha256",
          "artifactSizeBytes": 456
        }
      },
      "profiles": {
        "baseline": ["python", "node"],
        "node-static": ["node"]
      }
    }
  }
}
```

tuttid resolves the `baseline` profile by default when launching apps, and may
preload smaller profiles such as `node-static` during daemon startup or an
explicit runtime-preparation workflow before first launch. Listing App Center
apps must not preload runtimes as a side effect. App manifests must not declare
a runtime kind. Apps that only need Node may declare
`runtime.profile: "node-static"` so launch does not require the Python
component. If runtime requirements need to become more selective later, add a
capability list such as runtime component requirements rather than restoring a
single-kind manifest field.

## Runtime Lifecycle

Workspace App processes are daemon-owned background resources keyed by
`(workspaceId, appId)`. A renderer webview is only a view onto that resource:
closing or destroying the webview must not stop the app process.

Use the typed daemon endpoints for explicit lifecycle actions:

- `POST /v1/workspaces/{workspaceID}/apps/{appID}/launch` starts or reconnects
  to one app runtime.
- `POST /v1/workspaces/{workspaceID}/apps/{appID}/stop` stops only that app
  runtime.
- `POST /v1/workspaces/{workspaceID}/apps/stop-all` stops all app runtimes in
  the workspace and is reserved for explicit bulk shutdown flows.

Desktop window-close handling must remain separate from these stop operations.
The daemon runner and App Center service remain authoritative for runtime state;
Electron main and renderer code must not infer process lifetime from whether an
app window is visible.

Daemon shutdown stops every daemon-owned app runner, including both installed
App Center runtimes and transient App Factory validation runtimes. Keep new app
runtime owners registered with the composition-root shutdown path so `Cmd+Q`,
updates, and parent-process loss cannot orphan a child process.

## Runtime Overrides

Supported daemon overrides:

- `TUTTI_APP_RUNTIME_CATALOG`: HTTP(S) URL or local file path for the runtime catalog. Set it to an empty string to disable the default runtime catalog.
- `TUTTI_APP_RUNTIME_CACHE_ROOT`: cache root for platform-specific runtime directories.
- `TUTTI_APP_RUNTIME_ROOT`: exact prepared runtime root, mainly for tests and local debugging.

App packages must not set these variables. The runner injects `TUTTI_APP_PYTHON`, `TUTTI_APP_NODE`, `TUTTI_APP_NPM`, and `PATH` for app processes.
Agent provider installers may also use the managed `TUTTI_APP_NPM` path to
install ACP npm adapters into daemon-owned per-agent prefixes instead of npm
global locations.

Runtime artifacts must make `node/bin/npm` and `node/bin/npx` standalone
wrappers that execute the packaged Node binary with npm's packaged CLI scripts.
Do not rely on Node release symlinks surviving zip packaging.

## Validation

After runtime release changes, run:

```bash
node --test ./tools/scripts/build-tutti-app-runtime-catalog.test.mjs
pnpm lint:ts
```

After downloader or runner changes, also run:

```bash
cd services/tuttid && go test ./service/workspace ./service/eventstream
pnpm --filter @tutti-os/workspace-app-center test
pnpm --filter @tutti-os/desktop typecheck
```
