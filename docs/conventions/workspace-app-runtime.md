# Workspace App Runtime

Workspace App Center apps and daemon-managed ACP npm adapters run against a
daemon-managed runtime baseline. App packages must not bundle or declare
Python/Node versions; Tutti injects the managed runtime paths at launch.

## Bootstrap Contract

Every Workspace App package exposes one POSIX-compatible `bootstrap.sh` through
`runtime.bootstrap`. The app lifecycle depends on this contract rather than on
a platform implementation:

- macOS and Linux execute the script through the host's normal executable path;
- packaged Windows Desktop injects a Tutti-managed Bash runtime and the Windows
  shell adapter invokes the same script;
- fat packages select their native artifact with the injected
  `TUTTI_PLATFORM` value (`darwin-arm64`, `darwin-amd64`, or
  `windows-amd64`).

Keep bootstrap scripts LF-terminated and limited to POSIX shell built-ins plus
the commands supplied by the managed Windows shell: `cat`, `cp`, `dirname`,
`mkdir`, `mv`, `rm`, `sleep`, and `uname`. Use the explicit managed runtime
variables for Node and Python instead of expecting package managers or other
Unix tools in the shell. Do not add a second manifest entrypoint map or require
Git for Windows. The optional App Factory `prepare.sh` uses the same shell
adapter and command subset.

## App State Directories

Each installed app receives installation-scoped directories below the Tutti
state root. The runner creates them before `bootstrap.sh` starts and injects:

- `TUTTI_APP_DATA_DIR` for durable artifacts and non-database state;
- `TUTTI_APP_DATABASE_DIR` for host-local durable active databases, including
  SQLite WAL/SHM files and indexes;
- `TUTTI_APP_RUNTIME_DIR` for restartable scratch/runtime state;
- `TUTTI_APP_LOG_DIR` for backend logs.

An app may create multiple database files under `TUTTI_APP_DATABASE_DIR`.
Keeping live databases separate prevents synchronized, referenced, or exported
data paths from weakening filesystem locking and atomic-write guarantees. App
restarts and package upgrades preserve the database directory; uninstalling the
workspace app removes it together with the installation state root.

`TUTTI_CLI` is the app-facing CLI contract. Apps and skills must not depend on a
host-internal CLI configuration variable: the injected command is responsible
for locating and authenticating its own daemon connection.

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
  node/bin/corepack
```

Windows runtime artifacts, when added, must use the Windows executable names expected by tuttid:

```text
python/bin/python.exe
node/bin/node.exe
node/bin/npm.cmd
node/bin/corepack.cmd
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

1. Installs the pinned uv version on macOS and Linux.
2. Uses uv to install the pinned macOS/Linux Python baseline.
3. Downloads the pinned official CPython embeddable package on Windows, verifies its SHA-256, and requires valid Authenticode signatures on every `.exe`, `.dll`, and `.pyd` file.
4. Downloads the pinned Node release for each platform and verifies it against Node's `SHASUMS256.txt`.
5. Assembles separate Python and Node zips per platform.
6. Writes metadata for each platform's runtime components.
7. Uploads immutable component zips to S3.
8. Builds and uploads `catalog.json`.

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

The production runtime catalog must publish at least the `runtimeVersion` locked
by the desktop release target for every supported platform before that desktop
release is promoted. Runtime versions use an ordered `YYYY.MM.PATCH` format and
newer runtime releases remain compatible with older desktop releases because
tuttid always resolves the mutable catalog's current entry. The promotion
workflow enforces this ordering with
`tools/scripts/verify-tutti-app-runtime-release.mjs`; publish the managed runtime
first when the lock version changes.

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
        "connector-node-static": ["node"]
      }
    }
  }
}
```

tuttid resolves the `baseline` profile by default when launching apps, and may
preload smaller profiles such as `connector-node-static` during daemon startup or an
explicit runtime-preparation workflow before first launch. Listing App Center
apps must not preload runtimes as a side effect. App manifests must not declare
a runtime kind. The Windows managed runtime publishes the same Python+Node
`baseline` profile as Unix so existing Python apps (for example Automation)
remain portable. Apps that only need Node may declare
`runtime.profile: "connector-node-static"` so launch does not require the Python
component. If runtime requirements need to become more selective later, add a
capability list such as runtime component requirements rather than restoring a
single-kind manifest field. macOS and Linux currently use Python 3.12.13 from
the pinned uv-managed distribution. Windows uses python.org's official signed
Python 3.12.10 embeddable package because Python 3.12.10 is the last 3.12 patch
release with official Windows binaries; later 3.12 security releases are
source-only. The Windows version, archive URL, and SHA-256 are pinned separately
in `config/tutti.app-runtime.lock.json`, and platform metadata must report the
effective version rather than the cross-platform default.

The Windows embeddable package is intentionally minimal and isolated. It does
not include `pip`, `venv`, or `ensurepip`. Windows workspace apps using the
baseline profile must ship their dependencies in the app package and must not
install packages into the managed runtime. Moving Windows to a later Python
patch requires either an official signed binary distribution or Authenticode
signing of every shipped `.exe`, `.dll`, and `.pyd` file with an approved Tutti
publisher identity. SHA-256 verification alone is not a code-signing substitute.

## Runtime Overrides

Supported daemon overrides:

- `TUTTI_APP_RUNTIME_CATALOG`: HTTP(S) URL or local file path for the runtime catalog. Set it to an empty string to disable the default runtime catalog.
- `TUTTI_APP_RUNTIME_CACHE_ROOT`: cache root for platform-specific runtime directories.
- `TUTTI_APP_RUNTIME_ROOT`: exact prepared runtime root, mainly for tests and local debugging.
- `TUTTI_MANAGED_POSIX_SHELL`: absolute path to the managed POSIX shell
  executable. Packaged Windows Desktop sets this automatically; the Workspace
  App adapter consumes it, while the override exists for development, tests,
  and packaging diagnostics.

App packages must not set these variables. The runner injects `TUTTI_APP_PYTHON`, `TUTTI_APP_NODE`, `TUTTI_APP_NPM`, and `PATH` for app processes.
Agent provider installers may also use the managed `TUTTI_APP_NPM` path to
install ACP npm adapters into daemon-owned per-agent prefixes instead of npm
global locations.

Runtime artifacts must make `node/bin/npm`, `node/bin/npx`, and
`node/bin/corepack` standalone wrappers that execute the packaged Node binary
with their packaged CLI scripts. Do not rely on Node release symlinks surviving
zip packaging. The resolver treats a dereferenced Corepack distribution entry
as an invalid Node component and downloads the current catalog artifact again,
so existing caches recover when this wrapper contract changes.

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
