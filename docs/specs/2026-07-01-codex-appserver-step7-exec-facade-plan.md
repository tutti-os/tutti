# Codex App-Server Step 7 Exec Facade Plan

Step 7 implements ADR 0005 C+D after the hard-stop approval. The goal is to
invert Codex app-server `Exec` behind a command/observe facade while keeping the
existing blocking adapter contract as a strangler shim for non-migrated callers.

## Scope

- Add an optional async turn interface for adapters. The existing `Adapter.Exec`
  signature remains available and is used by providers that do not implement the
  async interface.
- Route `Controller.Exec` through the async interface for Codex app-server so the
  controller no longer waits on the adapter's blocking `Exec` return for turn
  completion.
- Isolate Codex app-server's current blocking execution body behind
  `execBlocking` and expose `ExecAsync` as the controller-facing strangler seam.
  The controller no longer depends on the blocking return value; it finalizes
  from terminal events emitted by the reducer/projection path. Further
  submit/observe extraction can now happen behind this adapter-local seam
  without touching `controller.go` again.
- Keep live-session release semantics facade-owned: active turns and pending
  requests keep `ReleaseLiveSession` busy; idle sessions remain releasable.

## Risk Controls

- The async interface is optional and provider-local.
- The blocking wrapper remains for tests and non-controller callers during the
  migration.
- Terminal classification remains Step 5's reducer-owned projection.
- Step 0 corpus and full runtime tests gate the change.

## Validation

- Step 0 corpus.
- `go test ./runtime/ -count=1`
- `go build ./runtime/...`
