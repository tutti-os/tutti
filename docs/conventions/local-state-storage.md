# Local State Storage

`tutti` local state must follow one root-directory convention.

The repository-owned default names for these paths now live in:

- `config/tutti.defaults.json`

Runtime code should consume generated defaults from that source instead of duplicating literal file names in multiple implementations.

## Default Roots

- production defaults to `~/.tutti`
- local development defaults to `~/.tutti-dev`

This rule applies to local databases, logs, caches, temporary runtime metadata, and other daemon-owned state.

## Environment Rules

- `TUTTI_ENV=development` uses `~/.tutti-dev`
- `TUTTI_ENV=production` uses `~/.tutti`
- `TUTTI_STATE_DIR=/custom/path` overrides both defaults
- `TUTTI_AGENT_RUNTIME_DIR=/custom/path` overrides the managed Agent Extension
  runtime root
- `TUTTI_DESKTOP_USER_DATA_DIR=/custom/path` overrides Electron `userData`
  only, for isolated desktop diagnostics

These environment variables are for development, test, packaging, and diagnostics overrides.
They are not the primary source of product defaults.

Per-file overrides such as `TUTTID_DB_PATH` are still allowed for narrow operational needs, but new local storage code should derive paths from the shared generated defaults and shared state root first.

`TUTTID_RUN_DIR` and `TUTTID_PID_PATH` redirect runtime metadata only. They do
not redirect the state ownership lock, which is always derived from
`TUTTI_STATE_DIR` as `<state-dir>/run/tuttid.pid.lock`.

## Allowed Override Surface

Current supported override surface for local state and closely-related runtime paths:

- `TUTTI_ENV`
- `TUTTI_STATE_DIR`
- `TUTTI_AGENT_RUNTIME_DIR`
- `TUTTI_LOG_DIR`
- `TUTTI_DESKTOP_USER_DATA_DIR`
- `TUTTID_DB_PATH`
- `TUTTID_RUN_DIR`
- `TUTTID_PID_PATH`
- `TUTTID_LISTENER_INFO_PATH`
- `TUTTI_AGENT_CONTEXT_CONFIG`

Rules:

- treat these variables as developer and operator escape hatches, not product settings
- prefer `TUTTI_STATE_DIR` over adding new per-file overrides
- keep `TUTTI_DESKTOP_USER_DATA_DIR` paired with an isolated
  `TUTTI_STATE_DIR`; it does not redirect daemon-owned state
- `TUTTI_STATE_DIR` does not redirect the managed Agent Extension runtime,
  whose compatibility location is `~/.local/share/tutti/agent-runtimes`; pair
  isolated Desktop diagnostics with an explicit `TUTTI_AGENT_RUNTIME_DIR`
- do not add a new environment variable when an existing shared root or generated default can express the same rule
- if a new override is truly needed, update this document and the matching transport or logging convention document in the same change

## Standard Layout

Production:

```text
~/.tutti/
  tuttid.db
  bin/
    tutti
    tutti-dev
  logs/
    tuttid.log
    tutti-desktop.log
  run/
    tuttid.listener.json
    tuttid.pid
    tuttid.pid.lock
```

Local development:

```text
~/.tutti-dev/
  tuttid.db
  bin/
    tutti
    tutti-dev
  logs/
    tuttid.log
    tutti-desktop.log
  run/
    tuttid.listener.json
    tuttid.pid
    tuttid.pid.lock
```

`tuttid.listener.json` is runtime endpoint metadata. It contains the loopback
address and per-run bearer auth needed by local clients such as the bundled
CLI, and should be written with restrictive file permissions.

## Daemon State Ownership

One state root has exactly one live `tuttid` owner. The daemon must acquire and
hold an exclusive operating-system lock on `<state-dir>/run/tuttid.pid.lock` before
initializing logging, recovering runtime locks, opening SQLite, running
migrations, seeding system records, or publishing listener metadata. A second
daemon targeting the same root must fail before touching durable state, even if
its pid or runtime metadata path is overridden. The PID
text remains available for desktop supervision and also protects upgrades from
an older live daemon that did not yet hold the operating-system lock. Before a
legacy PID blocks startup, the daemon verifies that the positive PID still
identifies a `tuttid` executable; a reused PID owned by an unrelated process is
stale metadata. Shutdown leaves the PID marker in place instead of racing a
legacy writer with a non-atomic read-then-remove. The next owner validates and
replaces that stale marker while holding the state-root lock.

Arguments that only inspect the daemon executable, such as `--help`, must exit
before state-path creation or ownership acquisition. Unknown arguments must
also fail without starting a daemon. Building or probing `tuttid` from an agent
or terminal therefore cannot silently become another production daemon.

Bare daemon execution defaults to production state. Development commands must
set `TUTTI_ENV=development`, set an explicit `TUTTI_STATE_DIR`, or use the
repository's managed development entry points. Environment separation and
single-owner locking are complementary: separation prevents unintended access;
locking prevents concurrent mutation after a root has been selected.

## Desktop Preferences

Device-global desktop preferences are durable daemon state in the
`desktop_preferences` row of `tuttid.db`. They are not workspace settings and
must be changed through the preferences service/API so the daemon can persist,
normalize, and publish the authoritative preferences event.

Fresh-profile creation is daemon-owned. A client uses the desktop preferences
`initializeIfAbsent` write mode. Before the atomic write, the preferences
service applies the daemon's fresh-profile workspace-mode default to the
normalized client candidate, so the Agent default cannot vary by caller while
other candidate fields and feature flags are preserved. The store writes that
complete row with a single `INSERT ... ON CONFLICT DO NOTHING` and returns the
authoritative stored row. If a concurrent initializer created the row first,
that stored row wins without being overwritten. Only `initializeIfAbsent` may
create this identity row. Field-specific writers fail without side effects when
the row is missing, so a partial patch can never decide whether the identity is
new or accidentally replace the complete initialization contract. The normal
omitted/`replace` write mode remains the full preference update. The daemon-owned
complete default uses the stable desktop update channel; packaged RC builds may
subsequently align that preference from their installed version. Existing rows
are never backfilled by initialization.

`agent_cli_update_check_enabled` stores the
`agentCliUpdateCheckEnabled` preference as a non-null SQLite boolean and
defaults to `true`, including for existing databases upgraded by migration. It
controls only the daemon's periodic managed-provider CLI update discovery. A
false value cancels scheduling and any in-flight discovery; it does not remove
cached metadata, change local readiness, or disable an explicit user-requested
update action.

## Model Access Plans

Workspace model access plans and custom Agents are daemon-owned rows in
`tuttid.db`. `model_plans` stores the plan configuration and verification
projection; API keys are encrypted in `api_key_ciphertext` and must never be
returned through public plan DTOs. `workspace_agents` is the current writable
Harness-to-Plan/default-model mapping. `agent_target_model_bindings` retains
the older target-to-plan shape only for historical sessions, rollback, and
legacy API compatibility; a forward migration idempotently materializes any
late binding rows as `source=legacy_binding` WorkspaceAgents before Desktop
removes the binding editor. Plan reference protection includes both current
WorkspaceAgents and remaining legacy consumers.
The retired `first_use_json` column and
`model_plan_first_use_candidates` table remain only for database downgrade
compatibility; current model-plan readiness ends at successful connection
detection and no session attribution is written or reconciled. The historical
`model_plan_first_use_candidates_v1` migration still repairs databases that
recorded `model_plans_v1` before this table existed. Migration identifiers are
immutable once any development or production database can record them; later
required tables, columns, or indexes must use a new forward migration rather
than extending the SQL hidden behind an existing marker.

The initial migration copies existing managed model-provider credentials into
stable `mp-migrated-<provider>` plans without removing the legacy rows, because
the workspace-app credential broker still owns that legacy surface. Normal
reads use the SQLite read pool and mutations use the single writer connection.

Migrated agent runtime state should derive from the same root:

```text
~/.tutti[-dev]/
  tutti-mode-plans/
    <workflow-id>/
      revisions/
        <sha256>.md
  agent/
    discovery/
      claude-code/
    extensions/
      <agent-key>/
        active.json
        <extension-version>/
          installation.json
          tutti.agent.json
          profiles/
          locales/
          assets/
    sessions/
      <date>-<sequence>/
    worktrees/
      <worktree-id>/
      .metadata/
        <worktree-id>.json
    runs/
      <agent-session-id>/
        sidecar-manifest.json
        codex-home/
        tutti-agent-home/
    attachments/
      <agent-session-id>/
        <attachment-id>.<ext>
  agent-prompt-assets/
    issues/
      <attachment-id>.<ext>
    codex/
      tutti/
        current/
          agent-context.json
  agent-providers/
    claude-code/
      current.json
    external-agent-registry/
      cache/
        registry.json
      packages/
        <agent-id>/
      binaries/
        <agent-id>/
  apps/
    packages/
      <app-id>/
        <version>/
    installations/
      <app-id>/
        <installation-scope>/
          runtime/
          data/
          database/
          logs/
    factory/
      jobs/
        <factory-job-id>/
          draft/
          runtime/
          data/
          logs/
  app-toolchains/
```

`agent/discovery/claude-code` is the fixed, project-neutral working directory
for Claude Code capability discovery. Discovery must not run from `/` or from a
user project directory, and its cache identity must not vary with a caller's
cwd or workspace. Agent-target identity and the non-secret auth fingerprint do
remain part of the identity. `agent/sessions` stores daemon-created working directories for agent sessions
that do not receive an explicit cwd. `agent/runs` stores per-session provider
sidecar state that can be recreated or cleaned up when the owning agent session
is deleted. Provider-specific homes, generated skills, and cleanup manifests
live under the matching run directory. Codex sessions use `codex-home` and
receive it through `CODEX_HOME`; Tutti Agent sessions use `tutti-agent-home`
and receive it through `TUTTI_AGENT_HOME`. `agent/skill-bundles/v1/<digest>`
stores immutable, rebuildable Tutti-managed Skill bundles shared by equal
content across Tutti Agent sessions; session cleanup never removes these
entries. `agent/system-skill-bundles/v1/<digest>/.system` stores immutable,
rebuildable snapshots of the embedded Skills installed by the active Tutti
Agent binary; run-scoped homes link to the matching digest before thread
startup. Session cleanup never removes either shared cache. `agent/attachments`
stores persisted prompt attachments by agent session.

`agent-prompt-assets/issues` stores daemon-managed PNG, JPEG, and WebP source
files attached to Qute Issues. Their metadata and Issue/Task ownership remain
in SQLite ContextRefs. The source root is intentionally inside the Agent prompt
attachment allowlist: when an Issue Run starts, the prompt attachment store
copies each image into `agent/attachments/<agent-session-id>` before provider
preparation. Removing the owning Issue, Task, or ContextRef removes only
matching files inside this managed directory. New image bytes are staged
before the Issue and its ContextRefs are committed together in one SQLite
transaction. Daemon startup reconciles the directory against durable SQLite
ContextRefs and prepared/leased Issue Run payload snapshots. A launch snapshot
pins its managed image paths until delivery is confirmed or the Run is settled,
so editing an Issue cannot change an admitted prompt. Reconciliation removes
files orphaned before the Issue transaction, or by a prior cleanup failure.

## Developer Agent Session Cassettes

The daemon keeps mutable Recording metadata and the rebuildable Cassette catalog
in SQLite. It does not persist Replay Workspace, Replay Surface, playback, or
verification state. It writes a Recording candidate under
`<TUTTI_STATE_DIR>/agent-session-recordings/<recording-id>/candidate/`.
A recording is a capture window over one recursive SessionGraph.
`create-session` has no initial state. `continue-session` captures the selected
root graph and related Tutti Mode, Workflow, and Issue business state in
`initial-state.json`. Explicit stop writes `expected-state.json`, finalizes the
provider tape, assigns a distinct
Cassette id, audits the candidate, and atomically publishes it under
`<TUTTI_STATE_DIR>/agent-session-cassettes/<cassette-id>`. Recording metadata
does not enter the published Cassette. Canceling removes the candidate. Turn
settlement does not stop recording. A daemon restart marks an active recording
incomplete and discards its candidate. Deleting an inactive recording removes
its Recording row, Cassette catalog row, and candidate or published directory.

`pnpm e2e:agent-gui -- --record <directory> --scenario <id>` exercises one
named scenario in an isolated runtime and copies the completed recording to
the requested directory. The runner has no raw prompt or generic
`--continue-session` recording mode; those semantics belong to the scenario
and the finalized cassette action.
The isolated daemon database and Electron `userData` live under the repository
`.tmp` root and are removed unless `--keep-runtime` is set.

The schema-v7 cassette contains `cassette.json`, `activity-events.jsonl`,
`checkpoint-plan.json`, optional `initial-state.json`,
`provider/{manifest.json,frames.jsonl}`, `expected-state.json`,
`blobs/manifest.json`, and any referenced content-addressed files under
`blobs/`.
Published files contain no source Workspace ID, database table/column names,
row IDs, migrations, or absolute paths. The daemon creates the transient
Workspace, restores semantic state before Host recovery, and captures actual
semantic state for verification.
Publication rejects every unrecognized file, including logs, screenshots,
databases, credentials, unrelated Sessions, and Workspace copies. Provider
payloads are capped at 8 MiB per frame and 256 MiB stored per tape; referenced
blobs are capped at 20 MiB each; the full audited file set is capped at 384 MiB.
The manifests report per-kind and per-file byte counts and hashes. Provider
frames and selected blobs may still contain private prompts, output, and files.
The blob manifest selects persisted prompt attachments explicitly referenced by
semantic Agent messages; replay verifies their SHA-256 and restores them into the
isolated attachment store. It does not scan the Workspace. Do not commit,
upload, or share a cassette without reviewing those scoped artifacts.

## Deleted Agent Conversation Retention

Soft-deleted Agent conversations remain recoverable canonical tombstones until
the device-global retention period expires. The supported values are 15 and 30
days, with 30 days as the default. Existing tombstones use their original
deletion timestamp; upgrades do not add another grace period. The daemon runs
small permanent-removal batches only while Agent work is idle, no more than one
successful automatic sweep per 24 hours. The desktop setting also exposes an
explicitly confirmed manual cleanup that targets all current topmost tombstone
components in the selected Workspace, regardless of the visible search or
project filter.

Only tombstones written by the lossless deletion generation are restorable.
They retain the complete root/child Session tree and its transcript, history,
provider resume identity, copied prompt attachments, and worktree reference.
Legacy tombstones are listed but remain unavailable for restore because their
Turn graph was already removed. Restore clears the exact tree tombstone without
rewriting its original Session metadata or starting provider work.

The Workspace store records a durable cleanup item in the same SQLite
transaction that hard-deletes canonical and Tutti Mode state for these
Tutti-owned Session components:

- `agent/attachments/<agent-session-id>`: persisted prompt attachments owned by
  the purged session.
- `agent/runs/<agent-session-id>`: the isolated provider sidecar state retained
  while the Session is recoverable.

The queue remains keyed by Workspace and Session so each purge transaction has
its own durable work item and is the only producer of that item. After Host
returns, maintenance only drains the committed queue; it never re-enqueues the
purge result. Cleanup is attempted immediately and failures remain durable for
a later idle retry. A deliberately queue-less composition may perform direct
best-effort cleanup instead. The physical roots above are currently keyed only
by agent Session ID, however, so any pending queue row globally fences insertion
of that Session ID in every Workspace. Before hard resource deletion, the
cleanup worker queries canonical live and tombstoned state across the full
database and retires the item without touching files if any Workspace still
owns the ID. Multiple queue rows for the same ID are safe: the first may remove
the roots and later attempts are idempotent. During recoverable deletion,
Workspace-keyed runtime and Model Gateway cleanup still runs, but the global
Agent/browser resource releaser is skipped when another Workspace has a live
canonical owner with that ID. Canonical deletion remains successful when
filesystem cleanup fails. Cleanup is limited to the two Session-scoped roots
above; it never deletes a user project, arbitrary Session cwd, provider
installation, shared provider home, or custom external provider home. A future
migration to Workspace-scoped physical paths is outside this change.
Managed worktrees are independent Workspace resources. Recoverable deletion,
restore, hard deletion, and purge do not retain, release, or remove them.

Deleted SQLite pages are immediately reusable by the database. After an
explicit manual sweep only, the daemon may additionally run a three-second
best-effort `VACUUM` when the whole database is no larger than 64 MiB, at least
8 MiB and one quarter of its pages are free, and Agent work is still idle.
Automatic maintenance never performs this compaction; a busy, timed-out, or
failed attempt does not roll back the committed purge.

`agent/worktrees/<worktree-id>` is a daemon-managed Git checkout with its own
resource identity and explicit lifecycle. The tuttid agent adapter owns the
corresponding `.metadata/<worktree-id>.json` record used for enumeration,
creation-transaction recovery, and explicit deletion. It records the Workspace,
repository root, branch, base commit, selected repository-relative working
directory, and opaque creation-request hash; new records never persist a
Session id. Metadata moves from `creating` to `ready` after `git worktree add`
and cwd validation. An exact retry repairs an interrupted `creating` transaction
or reuses its ready checkout; a Workspace, repository, or relative-directory
mismatch fails closed. Legacy Session-keyed records remain readable but their
Session id is compatibility data, not ownership.

Canonical Session isolation JSON references the independent worktree id and Git
coordinates as runtime facts. Fork copies the prepared cwd and runtime context
without validating a Session-to-worktree ownership relation. Session deletion,
restore, and purge never remove a worktree, and Host startup or periodic work
never sweeps this directory. The Workspace managed-worktree API is the only
normal deletion entrypoint. It refuses dirty or ahead resources and deletes the
branch with an expected-object-id compare so a concurrent commit is preserved.

`agent/extensions` is daemon-owned verified Agent Extension state. Version
directories are immutable after installation; `active.json` selects the
currently registered version and is replaced atomically. Extension ZIPs do not
contain runtimes or executables. Cached assets and profiles remain under each
fixed installation for integrity checks and future session-pinned resume.
Development-only local package overrides are copied into the same state as
content-addressed `+local.<digest>` versions; the daemon never launches against
the mutable source directory. Only the `data/agentextension` installation
adapter derives these paths or persists `installation.json` and `active.json`;
the service layer retains verification and activation workflow ownership.
Agent Extension executables are user-local programs rather than daemon state:

```text
~/.local/bin/
  <agent-command> -> ~/.local/share/tutti/agent-runtimes/<agent-key>/bin/<agent-command>

~/.local/share/tutti/agent-runtimes/
  <agent-key>/
    bin/
      <agent-command> -> ../<runtime-identity>/<runtime-executable>
    <runtime-identity>/
      activation.json
      node_modules/
  claude-code/
    versions/
      <claude-version>/
        claude
```

A compatible user-local executable remains preferred; otherwise one explicitly
confirmed, pinned runtime is installed per extension version and reused across
development, production, and all workspaces. Runtime installation never writes
under a user project. Setup action records, extension packages, discovery CWDs,
and session state remain under the selected `~/.tutti[-dev]` state root. The
Claude SDK sidecar's `current.json` pointer is state metadata, while its pinned
native executable uses the shared user-local runtime root.

Agent Extension activation publishes its command through the stable two-link
chain above. Development and production share that command and underlying
versioned runtime; environment separation applies only to daemon state. Tutti
never replaces a pre-existing regular file or foreign symlink in
`~/.local/bin`. Its own published link remains classified as managed for
fingerprint checks, persists across feature disablement and daemon shutdown,
and requires explicit reinstall if either link is missing or invalid.

Agent Extension setup uses these daemon-owned state paths:

```text
<state-dir>/agent/extension-runtime-actions/<scope-sha256>.json
<state-dir>/agent/extension-account-usage-companion-failures/<scope-sha256>.json
<state-dir>/agent/account-usage-node-snapshots/<node-sha256>.exe
<state-dir>/agent/discovery/agent-extensions/
```

Account-usage companion failure records contain only stable identities, an
error code, a failure count, and retry timestamps. Raw installer/provider
errors, paths, output, and credentials are never persisted. Recovery deletes
the record. Windows stores content-addressed Node snapshots here and keeps each
verified snapshot read-locked while it is reusable.

Connector CLI packages use daemon-owned state rather than the user's global
npm prefix. All CLI Connector installations bind to the one signed
`connector-node-static` runtime under `<state-dir>/connectors/runtimes` and use:

```text
<state-dir>/connectors/node-packages/shared/pnpm-store/
<state-dir>/connectors/node-packages/shared/corepack/
<state-dir>/connectors/node-packages/shared/npm-cache/
<state-dir>/connectors/node-packages/shared/pnpm-home/
<state-dir>/connectors/node-packages/packages/<connector-key>/<release-digest>/
```

The shared directories deduplicate registry downloads and physical dependency
content. The release directory remains isolated and contains only its lock,
links/hardlinks, package metadata, generated bin entry, and installation
receipt. A release-scoped rollback removes only the target release. Explicit
Connector uninstall removes every private release directory and prepared or
download-cached artifact for that Connector, while preserving shared package
content, account authorization, and user/workspace state.

The action filename hashes exact Target plus fixed extension installation
identity; workspace identity remains inside the record, not in a directory
segment. The data adapter owns path derivation, strict JSON decoding, scope
validation, `0700` directories, `0600` temporary files, sync, and atomic rename.
Session-level runtime/profile pinning remains tracked in the Agent Extension
architecture migration; `active.json` alone is not a durable session pin.

Filesystem paths under `<state-dir>` must not expose `workspaceId` as a
directory segment. Workspace ownership belongs in the SQLite database and
transport/domain contracts; local file paths should use user-meaningful or
session-scoped names. Workspace app installation state uses an opaque
`<installation-scope>` derived from the workspace/app identity so separate
workspace installations stay isolated without exposing workspace IDs in the
filesystem.

Pre-release layouts that exposed workspace IDs as state-directory segments are
intentionally unsupported by runtime fallback or automatic migration. Internal
testers who need to keep data should move it to the current layout before
upgrading.

The exact files may appear gradually as features are implemented, but new daemon-owned local files should follow this layout.

`agent-providers/external-agent-registry` stores the ACP External Agent Registry
cache plus daemon-managed adapter artifacts. npm-based adapters use
`packages/<agent-id>` as their npm prefix so global npm shims cannot affect
Tutti provider startup.

## Current Usage

- `tuttid` SQLite database defaults to `<state-dir>/tuttid.db`
- immutable Tutti mode plan revisions live under `<state-dir>/tutti-mode-plans/<workflow-id>/revisions/<sha256>.md`; the daemon writes each revision atomically and verifies its content digest when reading it
- desktop-managed local development starts `tuttid` with `TUTTI_ENV=development`
- packaged desktop builds start `tuttid` with `TUTTI_ENV=production`
- path helpers reserve `<state-dir>/logs` and `<state-dir>/run` for daemon log, listener-info, and pid files
- `tuttid` holds an exclusive lock on `<state-dir>/run/tuttid.pid.lock` for its full state-owning lifetime
- desktop main-process operational logging defaults to `<state-dir>/logs/tutti-desktop.log`
- desktop-to-daemon listener publication defaults to `<state-dir>/run/tuttid.listener.json`
- the bundled CLI discovers the managed daemon by reading `<state-dir>/run/tuttid.listener.json`
- packaged desktop shim install or repair uses `<state-dir>/bin/tutti` as the canonical user-level command path and points it at the packaged CLI binary; on macOS and Linux, when the login-shell `PATH` already contains writable `~/.local/bin` or `~/bin`, desktop also maintains a Tutti-owned forwarding shim there without replacing third-party commands
- packaged Windows uninstall preserves the `.tutti` state root by default but
  removes canonical and user-PATH `tutti.cmd` shims only when their marker line
  identifies them as Tutti-owned; uninstall must not delete an unmarked
  third-party command with the same name; interactive uninstall asks whether
  to preserve or delete all user state, while silent uninstall preserves it
  unless explicitly invoked with `--delete-app-data`; the delete path removes
  daemon state, Electron user data, updater cache, and the per-user `tutti`
  protocol registration
- local development scripts install or repair `<state-dir>/bin/tutti-dev` as the development CLI command and default it to `TUTTI_ENV=development`
- workspace app package cache, per-installation runtime/data/database/log state, and
  app factory job working directories live under `<state-dir>/apps`
- each workspace app installation receives a host-local durable `database/`
  directory for active SQLite databases and other files that require local
  filesystem locking; uninstalling the installation removes it with the rest
  of that installation's state
- workspace apps receive `<state-dir>/app-toolchains` as the shared cache root
  for reusable app-managed binaries

## SQLite Connection Governance

The daemon owns one SQLite database file and opens separate `database/sql`
pools for writes and reads. The write pool has exactly one connection because
SQLite serializes writers and several migrations rely on connection-scoped
PRAGMA state. The read-only pool uses WAL snapshots and may grow on demand to a
small bounded number of connections; its connections use SQLite read-only and
`query_only` modes.

Route independent queries through the read pool. Writes, migrations,
read-modify-write sequences, and reads that must share a write transaction's
snapshot stay on the write connection or its `sql.Tx`. Configure
connection-scoped PRAGMAs in the SQLite DSN so every dynamically opened
connection receives the same settings; executing a PRAGMA once through
`sql.DB` is not sufficient for a multi-connection pool. Long-lived read
transactions must be avoided because they can delay WAL checkpoints.

## Validation

The repository includes a transport smoke test:

- `pnpm smoke:desktop-transport`

Use it after changing local transport, listener setup, or state path derivation.

## Logging

`tuttid` default operational logging writes to:

- `<state-dir>/logs/tuttid.log`

See [Logging](./logging.md) for output mode and level rules.

## Rule Of Thumb

When adding a new local file path:

1. start from the shared state root
2. create a domain-specific subpath under that root
3. avoid writing new daemon-owned files directly under `$HOME`
