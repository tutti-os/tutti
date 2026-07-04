# Codex app-server Step 3 thread registry plan

## Scope

Implement ADR 0003 for the daemon app-server path without changing desktop
rendering or the generic ACP adapter.

## Current state

- `appServerNotificationThreadMismatch` drops every notification whose
  `threadId` differs from `Session.ProviderSessionID`.
- `collabAgentToolCall` parent items are already converted into tool-call
  events, but their `receiverThreadIds` are not recorded.
- `activityshared.Event` has no owner-thread identity, so child-thread output
  cannot be preserved for later nested rendering.

## Implementation

1. Add `OwnerThreadID string` to `activityshared.Event`. Empty means the
   top-level thread; non-empty means the event originated from that child
   thread.
2. Add a small thread registry to `codexAppServerSession`, keyed by
   `childThreadID`, seeded from `collabAgentToolCall.receiverThreadIds` on the
   parent thread.
3. Replace the old mismatch drop-filter with notification routing:
   - parent-thread notifications run unchanged;
   - known child-thread lifecycle/turn/progress noise is suppressed;
   - substantive child-thread item/message/reasoning notifications are converted
     against the parent session and stamped with `OwnerThreadID`;
   - unknown foreign threads still fall through to log-and-drop behavior.
4. Forward `OwnerThreadID` into projected message/timeline payload metadata so
   current storage schemas stay stable while the identity data remains available.
5. Update the Step 0 foreign-thread characterization to assert routing semantics
   instead of the removed helper.

## Validation

- `go test ./runtime/ -run 'TestAppServerForeignThread|TestCodexAppServerAdapterExec.*ForeignThread|TestCodexAppServerAdapterExecRoutesLinkedChildThreadEvents' -count=1`
- Step 0 bug corpus
- `go build ./runtime/...`
- `go test ./runtime/ -count=1`
