# Logging

This document defines the current logging conventions for `tutti`.

The repository-owned default values for log file names and rotation budgets now live in:

- `config/tutti.defaults.json`

Go and desktop code should consume generated defaults from that source instead of carrying duplicate literal values.

## Purpose

`tuttid` is a long-running local daemon.

Its normal operational logs should be durable and reviewable even when the desktop shell is the process supervisor.

`apps/desktop` main process should also keep a durable local log for Electron-shell concerns.

## `tuttid` Default Behavior

`tuttid` defaults to file-based logging.

Current default:

- log output mode: `file`
- log path: `<state-dir>/logs/tuttid.log`
- log format: structured `slog` text output
- default level: `info`
- active file name stays stable for tailing
- rotated history uses date-indexed names such as `tuttid.2026-05-21.log`

This means normal development and product runs should treat the daemon log file as the primary source for runtime analysis.

## Desktop Main Logging

Desktop main-process logging also defaults to file output.

Current default:

- log output mode: `file`
- log path: `<state-dir>/logs/tutti-desktop.log`
- default level: `info`
- active file name stays stable for tailing
- rotated history uses date-indexed names such as `tutti-desktop.2026-05-21.log`

Desktop logging is intended for:

- app bootstrap failures
- daemon supervision events
- shell-level errors
- Electron lifecycle issues

It is not a replacement for `tuttid` business and runtime logs.

## Correlation Fields

Desktop and daemon logs should be easy to align during one local run.

Current shared correlation behavior:

- desktop generates or adopts `TUTTI_SESSION_ID` at startup
- when desktop manages `tuttid`, it passes the same `TUTTI_SESSION_ID` into the daemon process
- both `tutti-desktop.log` and `tuttid.log` now include `session_id` in each structured line when available

This is intentionally lightweight:

- it is not a distributed tracing system
- it is a stable per-launch correlation key for local debugging and log analysis

## Desktop Diagnostic Exports

Desktop diagnostic exports use an explicit time range and an explicit Session
record choice. The supported combinations are:

- the last 10 minutes of logs
- the last 10 minutes of logs plus Agent Session records
- the last 3 days of logs
- the last 3 days of logs plus Agent Session records

The selected time range applies to structured log timestamps, file modification
time when a source has no parseable timestamps, and Agent Session update time.
Choosing logs only must not query or write Agent Session records. Runtime context,
the export summary, and other non-Session diagnostic snapshots remain part of the
log bundle so exported evidence stays interpretable.

Runtime-context transport diagnostics are allowlisted. Exports may include the
bound/requested address and listener/PID paths, but must never serialize the
transport access token or newly added transport snapshot fields by default.

## Error Codes

Startup, transport, and supervision failures should carry a stable `error_code` in addition to the human-readable message.

Current desktop-focused codes include:

- `logger_file_unavailable`
- `daemon_unavailable`
- `transport_timeout`
- `transport_connect_failed`
- `transport_request_failed`
- `managed_process_stderr`
- `managed_process_exited`
- `workspace_not_found`

Current daemon runtime codes include:

- `server_serve_failed`
- `server_shutdown_failed`

Protocol-layer codes belong to daemon API contracts rather than desktop-local runtime diagnostics.

Examples:

- `workspace_not_found`
- `workspace_path_exists`
- `workspace_operation_failed`
- `invalid_request`
- `service_unavailable`
- `method_not_allowed`

Rules:

- prefer a stable machine-readable code over parsing log messages later
- keep the code small and responsibility-oriented
- let the message continue to carry specific context for humans
- keep protocol-facing codes separate from desktop-local supervision codes such as `managed_process_exited`

## Output Modes

`tuttid` currently supports:

- `TUTTID_LOG_OUTPUT=file`
- `TUTTID_LOG_OUTPUT=stdout`
- `TUTTID_LOG_OUTPUT=tee`

Desktop main currently supports:

- `TUTTI_DESKTOP_LOG_OUTPUT=file`
- `TUTTI_DESKTOP_LOG_OUTPUT=stdout`
- `TUTTI_DESKTOP_LOG_OUTPUT=tee`

Rules:

- `file` writes only to the daemon log file
- `stdout` writes only to standard output
- `tee` writes to both the daemon log file and standard output

Default:

- `TUTTID_LOG_OUTPUT` unset behaves as `file`

## Log Levels

`tuttid` supports:

- `TUTTID_LOG_LEVEL=debug`
- `TUTTID_LOG_LEVEL=info`
- `TUTTID_LOG_LEVEL=warn`
- `TUTTID_LOG_LEVEL=error`

Default:

- `TUTTID_LOG_LEVEL` unset behaves as `info`

Desktop main supports:

- `TUTTI_DESKTOP_LOG_LEVEL=debug`
- `TUTTI_DESKTOP_LOG_LEVEL=info`
- `TUTTI_DESKTOP_LOG_LEVEL=warn`
- `TUTTI_DESKTOP_LOG_LEVEL=error`

Default:

- `TUTTI_DESKTOP_LOG_LEVEL` unset behaves as `info`

### Hot-Path Diagnostics

Streaming events, polling loops, renderer snapshots, and transport frames are
hot paths. Their successful per-event diagnostics belong at `debug`; the
default `info` level should contain a bounded summary per turn, short time
window, or semantic state transition.

Rules:

- aggregate repeated success events and retain counts plus stable correlation
  fields in the summary
- keep failures, dropped data, and rare lifecycle transitions visible at
  `warn` or `error`
- exclude cursors, timestamps, token/message versions, and elapsed time from
  change-detection signatures unless that value is the state being diagnosed
- log a periodic poll at `info` or `warn` only when its semantic result changes;
  unchanged results belong at `debug`
- desktop file writes must stay ordered without performing one synchronous
  filesystem write on the Electron main thread per line

## Rotation

Both daemon and desktop main now follow the same rotation convention:

- active file keeps a stable name
- rotation happens on calendar day change or when size budget is exceeded
- rotated files are date-indexed and optionally numbered for same-day rollover

Shared rotation controls:

- `TUTTI_LOG_DIR`
- `TUTTI_LOG_MAX_SIZE_MB`
- `TUTTI_LOG_MAX_BACKUPS`
- `TUTTI_LOG_MAX_AGE_DAYS`
- `TUTTI_LOG_MAX_TOTAL_MB`

Default budgets:

- max size: `50MB`
- max backups: `10`
- max age: `14 days`
- max total managed log directory size: `300MB`

## Desktop Supervision Rules

When desktop manages `tuttid`:

- daemon logs still default to file output
- desktop does not forward daemon stdout by default
- desktop still surfaces daemon stderr for startup and failure visibility

This keeps normal daemon logs in the file while still allowing focused debugging when stdout is explicitly requested.

Desktop-side debug options:

- set `TUTTID_LOG_OUTPUT=stdout` or `tee`
- or set `TUTTID_FORWARD_STDIO=1` when you want desktop to forward daemon stdout explicitly
- set `TUTTI_DESKTOP_LOG_OUTPUT=stdout` or `tee` when you want desktop shell logs on standard output

These environment variables are override and diagnostics controls, not the primary source of default logging policy.

## Allowed Override Surface

Current supported logging override surface:

- `TUTTI_LOG_DIR`
- `TUTTI_LOG_MAX_SIZE_MB`
- `TUTTI_LOG_MAX_BACKUPS`
- `TUTTI_LOG_MAX_AGE_DAYS`
- `TUTTI_LOG_MAX_TOTAL_MB`
- `TUTTID_LOG_PATH`
- `TUTTID_LOG_OUTPUT`
- `TUTTID_LOG_LEVEL`
- `TUTTI_DESKTOP_LOG_PATH`
- `TUTTI_DESKTOP_LOG_OUTPUT`
- `TUTTI_DESKTOP_LOG_LEVEL`
- `TUTTID_FORWARD_STDIO`
- `TUTTI_SESSION_ID`

Rules:

- these variables exist for local debugging, tests, packaging, and diagnostics
- do not introduce a new logging environment variable unless existing shared defaults or existing override hooks are insufficient
- prefer shared controls such as `TUTTI_LOG_DIR` and the rotation budget variables over component-specific one-off flags
- if a new logging override is added, update this document and `config/tutti.defaults.json` if the change also affects the repository-owned defaults

## Failure Visibility

Fatal startup failures should still be visible through `stderr`.

Examples:

- invalid log configuration
- logger file open failure
- listener startup failure
- fatal daemon exit

This avoids a failure mode where the daemon dies before usable file logging is available.

## Current Recommendation

Use:

- `file` for normal product runs and joint development analysis
- `tee` when debugging startup, transport, or daemon behavior while still preserving a durable file log
- `stdout` only for narrow, deliberate debugging flows

Use the same rule for desktop shell logs unless a local debugging task specifically benefits from terminal output.

## Related Docs

- [Local State Storage](./local-state-storage.md)
- [Desktop Layering](./desktop-layering.md)
