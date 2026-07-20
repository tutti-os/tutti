# Testing

This document defines the repository-managed test discovery and gate policy.

## Commands

- `pnpm test:ts`: all TypeScript/JavaScript workspace package tests
- `pnpm test:tools`: repository tool tests only
- `pnpm test:go`: generate builtin app assets, then run the blocking Go workspace test set
- `pnpm test:go:prepared`: run the blocking Go workspace test set when builtin app assets are already prepared
- `pnpm test:go:agent-daemon`: run the blocking agent daemon module as a focused lane

## Validation Selection

Validation entrypoints are scopes, not a cumulative checklist. For normal
non-UI-only work, inspect `pnpm check:changed -- --dry-run`, then run one final
`pnpm check:changed` after the change has settled. The final plan owns its
selected package tests, typechecks, lint, and boundary checks; do not run those
same commands as a separate final preflight or follow-up.

Direct package or boundary commands are iteration tools for a failing or
uncertain surface. After a failed changed-aware run, use
`pnpm check:changed -- --failed-only` when only failed lanes need another pass.
A focused command run before subsequent edits is evidence for that iteration,
not for the final worktree; some narrow coverage may therefore run again in the
final changed-aware gate.

Add a standalone final check only when the dry-run plan omits a capability the
changed surface requires:

- Desktop runtime/build behavior: `pnpm --filter @tutti-os/desktop build`
- user-visible copy or locale resources: `pnpm check:i18n`
- defaults under `config/tutti.defaults.json`: `pnpm generate:defaults` and `pnpm check:defaults-generated`
- provider strategy/capability contracts: `pnpm check:agent-provider-strategy-boundaries`
- daemon build confidence: `cd services/tuttid && go build ./...`

Use a full package suite or `pnpm check:full` only when broad impact, release
risk, an explicit workflow, or concrete uncertainty in changed-test selection
requires wider confidence. If wider confidence is required, avoid separately
pre-running every boundary/typecheck lane that `check:changed` already owns;
some overlap between its selected tests and an intentionally broader suite may
be unavoidable.

`pnpm check:full` prepares builtin app assets once, then uses the prepared Go
lint and test entrypoints. This prevents concurrent validation lanes from
writing the same generated assets. It captures complete task output under
`.tmp/check-full-runs` and prints compact phase summaries by default. Its failed
tasks print filtered error excerpts as soon as they finish; use `--verbose` for
live output or `--tail-lines <n>` to change each failed task's excerpt size.

## Workspace Test Discovery

TypeScript and JavaScript package tests are discovered from workspace
`package.json` files. Every workspace package with a `test` script is included
automatically; do not add package names to a root test whitelist.

A package that declares a `test` script must contain at least one package-local
`*.test.*` or `*.spec.*` file. The root runner rejects zero-test scripts so an
empty glob cannot be reported as a passing test suite. Remove a stale script or
add a real package test.

Repository tool tests are discovered from `tools/scripts/*.test.mjs`. Tool
tests that exercise package release helpers remain tool-owned instead of being
duplicated through a package-level test script. They are repository contract
tests, not TypeScript package tests, and run through `test:tools` only.

Repository policy, tool contracts, generated contracts, and architecture
boundaries are selected from `tools/scripts/repository-checks.mjs`. Both PR CI
and `check:changed` consume this registry; do not attach a repository-wide
check to a TypeScript or Go lane based on its implementation language.

Go tests are discovered from the modules declared in `go.work`. The blocking
lane includes every module, so additions to `go.work` join the root test gate
without a second registry.

Changed-aware validation must recognize every current `go.work` module so a Go
file change selects the matching package lint and test lanes.

## Agent Daemon Blocking Gate

`packages/agent/daemon` is part of the blocking Go workspace test set. A failure
from this module fails `pnpm test:go`, `pnpm check:full`, the pre-push hook, and
the pull-request Go Tests job. Use `pnpm test:go:agent-daemon` when iterating on
the module without running the other Go workspace lanes.

The module was promoted after its known timing-sensitive cases were converted
to event-driven synchronization and the full module passed repeated shuffled
runs. Do not add retries to preserve a green gate; reproduce and stabilize a
failing lifecycle transition instead.

Direct changes to the agent daemon should run the focused lane locally. Use a
repeated shuffled run when changing asynchronous lifecycle behavior.

For asynchronous runtime tests, prefer request/event channels and the session
event sink over fixed-interval polling of mutex-protected slices. Wait for the
specific protocol request or lifecycle event with a descriptive timeout so a
failure identifies the missing transition. Protocol mocks should also cover
valid response/notification reorderings; an RPC response must not be assumed to
arrive before the notifications caused by that request.

Protocol fixtures must answer every synchronous startup/capability probe they
can receive. Return an empty supported result or an explicit method-not-found
error for unsupported probes; never rely on the production RPC timeout as mock
behavior, because one missing response can add tens of seconds to every test
that starts the adapter.

## Output and Logs

Root test runners execute independent lanes with bounded concurrency. Successful
runs print one compact summary plus the three slowest lanes. Each lane writes
its complete output under:

- `.tmp/test-runs/typescript`
- `.tmp/test-runs/go`
- `.tmp/test-runs/go-agent-daemon`

Each root also writes `latest.json`, with per-lane duration, exit code, and log
path, plus a timestamped run directory containing the same `summary.json`.
Inspect that manifest first when an AI agent needs to identify the slow or
failed owner without scanning every log.

Failures print a filtered, bounded excerpt and the full log path as soon as the
lane finishes. Command echoes, package-manager failure wrappers, terminal color
escapes, and consecutive duplicate lines are removed while assertion text,
source locations, and stack frames are preserved. Use `--tail-lines <n>` to
change each displayed failure excerpt and `--max-parallel <n>` to reduce local
resource pressure.

The TypeScript runner uses up to four package lanes locally. CI runs one package
lane at a time because large Vitest packages already own internal worker pools;
stacking package concurrency on a small hosted runner can turn otherwise fast
component tests into timeout failures.

Agent daemon runtime tests suppress the default structured runtime logger to
keep test output bounded. Set `TUTTI_TEST_LOGS=1` for a diagnostic run that
needs the full runtime log stream.

Tests must not inspect or print real local credential snapshots unless the test
explicitly exercises credential storage through isolated fixtures. Node test
runs skip Claude authentication refresh diagnostics so normal unit tests do not
read or expose host credential metadata.
