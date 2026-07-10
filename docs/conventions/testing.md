# Testing

This document defines the repository-managed test discovery and gate policy.

## Commands

- `pnpm test:ts`: all TypeScript/JavaScript workspace package tests plus repository tool tests
- `pnpm test:tools`: repository tool tests only
- `pnpm test:go`: generate builtin app assets, then run the blocking Go workspace test set
- `pnpm test:go:prepared`: run the blocking Go workspace test set when builtin app assets are already prepared
- `pnpm test:go:agent-daemon`: run the currently non-blocking agent daemon lane

`pnpm check:full` prepares builtin app assets once, then uses the prepared Go
lint and test entrypoints. This prevents concurrent validation lanes from
writing the same generated assets.

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
duplicated through a package-level test script.

Go tests are discovered from the modules declared in `go.work`. The blocking
lane includes every module except `packages/agent/daemon`; additions to
`go.work` therefore join the root test gate without a second registry.

Changed-aware validation must recognize every current `go.work` module so a Go
file change selects the matching package lint and test lanes.

## Agent Daemon Soft Gate

`packages/agent/daemon` remains an explicit soft gate while its runtime suite
contains scheduler-sensitive asynchronous cases. Pull-request CI runs
`pnpm test:go:agent-daemon` with non-blocking failure semantics and emits a
workflow warning when it fails.

Promote this lane into the blocking Go set only after the timing-sensitive
tests are event-driven or otherwise stable under repeated and concurrent runs.
Do not hide failures with retries as a substitute for stabilization.

Direct changes to the agent daemon should still run the lane locally. Use a
repeated focused run when changing asynchronous lifecycle behavior.

For asynchronous runtime tests, prefer request/event channels and the session
event sink over fixed-interval polling of mutex-protected slices. Wait for the
specific protocol request or lifecycle event with a descriptive timeout so a
failure identifies the missing transition. Protocol mocks should also cover
valid response/notification reorderings; an RPC response must not be assumed to
arrive before the notifications caused by that request.

## Output and Logs

Root test runners execute independent lanes with bounded concurrency. Successful
runs print one compact summary. Each lane writes its complete output under:

- `.tmp/test-runs/typescript`
- `.tmp/test-runs/go`
- `.tmp/test-runs/go-agent-daemon`

Failures print a bounded tail and the full log path. Use `--tail-lines <n>` to
change the displayed failure tail and `--max-parallel <n>` to reduce local
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
