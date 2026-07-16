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
- `TUTTI_LOG_DIR`
- `TUTTID_DB_PATH`
- `TUTTID_RUN_DIR`
- `TUTTID_PID_PATH`
- `TUTTID_LISTENER_INFO_PATH`
- `TUTTI_AGENT_CONTEXT_CONFIG`

Rules:

- treat these variables as developer and operator escape hatches, not product settings
- prefer `TUTTI_STATE_DIR` over adding new per-file overrides
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

Migrated agent runtime state should derive from the same root:

```text
~/.tutti[-dev]/
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
    runs/
      <agent-session-id>/
        sidecar-manifest.json
        codex-home/
        tutti-agent-home/
    attachments/
      <agent-session-id>/
        <attachment-id>.<ext>
    codex/
      tutti/
        current/
          agent-context.json
  agent-providers/
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
and receive it through `TUTTI_AGENT_HOME`. `agent/attachments` stores persisted
prompt attachments by agent session.

`agent/extensions` is daemon-owned verified Agent Extension state. Version
directories are immutable after installation; `active.json` selects the
currently registered version and is replaced atomically. Extension ZIPs do not
contain runtimes or executables. Cached assets and profiles remain under each
fixed installation for integrity checks and future session-pinned resume.
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
- desktop-managed local development starts `tuttid` with `TUTTI_ENV=development`
- packaged desktop builds start `tuttid` with `TUTTI_ENV=production`
- path helpers reserve `<state-dir>/logs` and `<state-dir>/run` for daemon log, listener-info, and pid files
- `tuttid` holds an exclusive lock on `<state-dir>/run/tuttid.pid.lock` for its full state-owning lifetime
- desktop main-process operational logging defaults to `<state-dir>/logs/tutti-desktop.log`
- desktop-to-daemon listener publication defaults to `<state-dir>/run/tuttid.listener.json`
- the bundled CLI discovers the managed daemon by reading `<state-dir>/run/tuttid.listener.json`
- packaged desktop shim install or repair uses `<state-dir>/bin/tutti` as the canonical user-level command path and points it at the packaged CLI binary; on macOS and Linux, when the login-shell `PATH` already contains writable `~/.local/bin` or `~/bin`, desktop also maintains a Tutti-owned forwarding shim there without replacing third-party commands
- local development scripts install or repair `<state-dir>/bin/tutti-dev` as the development CLI command and default it to `TUTTI_ENV=development`
- workspace app package cache, per-installation runtime/data/log state, and
  app factory job working directories live under `<state-dir>/apps`
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
