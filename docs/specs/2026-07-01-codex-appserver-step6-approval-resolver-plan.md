# Codex App-Server Step 6 Approval Resolver Plan

Step 6 implements ADR 0006 without opening the Step 7 `Exec`/controller seam.
The current JSON-RPC request handler remains as a blocking shim, but pending
approval state moves behind a resolver projection that can be reconciled and
terminated by provider notifications.

## Scope

- Add a Codex app-server approval resolver owned by the adapter/reducer layer.
- Represent approval and interactive requests as resolver records with explicit
  states: `pending`, `resolved`, and `interrupted`.
- Handle `serverRequest/resolved` as the authoritative terminal for pending
  approvals and user-input requests. The notification removes the pending
  prompt, unblocks the parked responder, and emits resolved call state.
- Keep existing user-visible approval detail events and `SubmitInteractive`
  behavior. The handler still holds the Codex RPC open until the resolver
  resolves, preserving the current adapter contract for Step 6.
- Reject unsupported server-request methods explicitly with a failed call event
  when they arrive during an active turn.

## Implementation

1. Add a resolver helper under `runtime` for registering, resolving, interrupting,
   and snapshotting pending requests.
2. Route `storePendingRequest`, `deletePendingRequest`, `rejectPendingRequests`,
   and `SessionState` through the resolver instead of direct map mutation.
3. Add `serverRequest/resolved` to the reducer switch and translate it into
   `EventCallCompleted` plus a working turn update for the matching pending
   request.
4. Keep the blocking JSON-RPC handler as a shim over `pending.wait`.
5. Add tests for out-of-band resolution, user-input pending state, approval
   approve/deny mapping, and unsupported server-request rejection.

## Validation

- Step 0 corpus stays green.
- `go test ./runtime/ -count=1`
- `go build ./runtime/...`
