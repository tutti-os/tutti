# Workspace App Factory

Status: current implemented architecture

## Purpose

Workspace App Factory creates and iterates local workspace app packages through
an agent-backed daemon workflow. The output is a normal App Center package; it
does not generate or modify Tutti product source under `apps/desktop`,
`services/tuttid`, or `packages/*`.

The package contract is the supported boundary. Generated apps may use any
local implementation stack that validates and starts through their manifest
bootstrap.

## Ownership

`services/tuttid` owns:

- durable Factory jobs and state transitions;
- agent target validation, session creation, and completion reconciliation;
- draft and runtime directories;
- optional package preparation and healthchecked validation;
- publishing, version selection, rollback, and catalog updates;
- Factory and app runtime logs;
- `workspace.appfactory.job.updated` events.

`apps/desktop` owns App Center composition, generated tuttid client adapters,
host folder actions, and provider/model configuration loading.

`packages/workspace/app-center` owns host-neutral Factory presentation, view
models, i18n, and host action contracts. It does not construct daemon clients,
own Electron bridges, validate packages, select state paths, or orchestrate
agent sessions.

## Package Contract

Factory drafts contain a self-contained app package such as:

```text
package/
  tutti.app.json
  bootstrap.sh
  AGENTS.md
  icon.png
  ...
```

The manifest uses the normal App Center contract:

```json
{
  "schemaVersion": "tutti.app.manifest.v1",
  "appId": "app_550e8400-e29b-41d4-a716-446655440000",
  "version": "0.1.0",
  "name": "Weekly Report",
  "description": "Creates a weekly workspace report.",
  "icon": { "type": "asset", "src": "icon.png" },
  "runtime": {
    "kind": "custom",
    "bootstrap": "bootstrap.sh",
    "healthcheckPath": "/healthz"
  },
  "author": { "name": "Tutti" },
  "tags": ["generated"]
}
```

Stable rules:

- the system mints `appId`; users edit display metadata, not identity;
- the bootstrap is a relative executable package path and receives no runner
  arguments;
- the app binds the host and port supplied by the runner;
- `AGENTS.md` is non-empty and describes the generated package using portable
  environment variables and relative paths;
- package assets are treated as read-only at runtime;
- durable data, scratch data, logs, and reusable toolchains use their dedicated
  runner directories.

## Job Lifecycle

The durable states are:

```text
queued -> generating -> preparing -> validating -> ready -> published
                         \              \-> failed
                          \-> failed
queued|generating|preparing|validating -> canceled
```

A new job:

1. validates the workspace and registered, enabled `agentTargetId`;
2. creates a daemon-owned draft and context;
3. starts an Agent Session with the draft as its working directory;
4. observes the persisted Agent Session until generation completes;
5. runs optional `prepare.sh`;
6. validates the package and moves it to `ready` or `failed`;
7. publishes only from `ready`.

Jobs retain their agent session id, validation result, failure reason, and
published version. Failed jobs can retry validation or start a fix turn against
the same draft. Published apps can prepare a modification draft, validate it,
and publish a new version. Active jobs are reconciled with persisted agent state
after daemon interruption instead of relying only on in-memory callbacks.

## Agent Execution

Factory requires an `agentTargetId`. The daemon resolves it against the local
target registry, derives provider identity and launch ref, and rejects missing,
disabled, or invalid targets. UI-supplied provider strings are not launch
authority.

Composer configuration is loaded through the target-specific Factory endpoint
using a daemon-owned composer draft directory. Generation sessions receive:

- the package contract and App Factory skill;
- the job draft as cwd;
- workspace identity and root as context;
- the existing package for modification jobs;
- selected model, permission, and reasoning settings.

The renderer never executes generation or package preparation itself.

## Daemon State Layout

Factory state lives beneath the configured Tutti state directory:

```text
apps/
  factory/
    composer/<workspaceId>/draft/
    jobs/<jobId>/
      package/
      runtime/
      data/
      logs/
      context.json
  packages/<appId>/<version>/
  workspaces/<workspaceId>/<appId>/
    data/
    database/
    runtime/
    logs/
```

Factory writes generated package content only beneath daemon-owned state. The
workspace root may be supplied as read context, but it is not the draft output
directory.

## Preparation And Validation

When present, `prepare.sh` must be an executable file. It runs with Factory
runtime/data/log/toolchain environment directories and a bounded timeout. It
must not create or migrate an active app database during package preparation.

Validation then verifies:

- `tutti.app.json` through the daemon manifest parser;
- job-owned app identity and version metadata;
- absence of conflicting package identity;
- an existing executable runtime bootstrap;
- a non-empty, runtime-cleaned `AGENTS.md`;
- successful dry-run startup and healthcheck within the validation timeout.

Validation uses the normal App Runner with a Factory-scoped workspace id,
including an isolated `TUTTI_APP_DATABASE_DIR`, and always stops the dry-run
process afterward. Failure records a structured validation result and moves the
job to `failed`.

This is local package/runtime validation, not static security analysis or
cross-machine portability certification.

## Publish, Versions, And Rollback

Publishing copies a validated draft to
`apps/packages/<appId>/<version>`, records a generated `app_packages` row, and
updates the active `app_catalog_entries` pointer. It then adds the app to the
current workspace through App Center.

Republishing an existing Factory job assigns the next available patch version.
If the app is already installed, the old runtime is stopped before App Center
activates the new package. Package versions are immutable records; the catalog
entry selects the active version.

Rollback changes the active package version and restarts the installed app as
needed. It never rolls back app-owned data.

## Runtime And Security Boundary

Published generated apps use the normal workspace app runner. Important
environment boundaries include:

- `TUTTI_APP_PACKAGE_DIR`: read-only package content;
- `TUTTI_APP_RUNTIME_DIR`: scratch/runtime data;
- `TUTTI_APP_DATA_DIR`: durable app artifacts and non-database state;
- `TUTTI_APP_DATABASE_DIR`: host-local durable active databases and their
  sidecar files, separate from data that may be referenced, exported, backed
  up, or synchronized;
- `TUTTI_APP_LOG_DIR`: backend logs;
- `TUTTI_APP_TOOLCHAIN_ROOT`: reusable app-managed tools;
- `TUTTI_APP_SERVER_TOKEN`: server-only scoped daemon access.

The server token must not enter browser code, durable app data, or logs.
Generated apps are local child processes with the user's filesystem and network
capabilities; App Factory does not currently provide sandbox, VM, container, or
firewall isolation.

App schemas and data migrations remain owned by each generated app. Package
rollback changes code, not `TUTTI_APP_DATA_DIR` or
`TUTTI_APP_DATABASE_DIR`.

## Events And UI

Every durable job update publishes
`workspace.appfactory.job.updated`. Catalog, installation, and runtime changes
continue to use `workspace.app.updated`.

App Center is the primary Factory surface. It shows creation controls,
target/model settings, compact job progress, failure actions, publish actions,
and links to the owning Agent Session. Product copy stays in the app-center i18n
layer.

## HTTP Contract

OpenAPI is the source of truth. The current routes are:

```text
GET    /v1/workspaces/{workspaceID}/app-factory/jobs
POST   /v1/workspaces/{workspaceID}/app-factory/jobs
POST   /v1/workspaces/{workspaceID}/app-factory/agent-targets/{agentTargetID}/composer-options
GET    /v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}
DELETE /v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}
POST   /v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/cancel
POST   /v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/retry-validation
POST   /v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/fix
POST   /v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/prepare-modification
POST   /v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/publish
POST   /v1/workspaces/{workspaceID}/apps/{appID}/rollback
```

## Invariants

- Generated app code never lands in Tutti product source directories.
- The daemon owns job state, package validation, and catalog mutation.
- Agent targets are registry-resolved; provider strings are derived metadata.
- Only validated `ready` jobs can publish.
- Published package versions are separate from mutable app data.
- Renderer code never receives the app server token or Factory process control.

## Validation Surface

The durable tests cover job transitions and recovery, agent target resolution,
prompt/session wiring, preparation, validation, failure repair, publish
idempotency, version conflicts, republish, rollback, event publication, OpenAPI
contracts, and App Center projections.

Related documents:

- [Workspace App Runtime](../conventions/workspace-app-runtime.md)
- [Workspace App Catalog](../conventions/workspace-app-catalog.md)
- [Business Event Stream](./business-event-stream.md)
- [Agent GUI Node](./agent-gui-node.md)
