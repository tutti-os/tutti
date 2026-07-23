# Issue execution

## Stop remains pending while the Agent Turn is already canceled

Check the durable Issue, Run, Agent Turn, runtime operation, and Agent outbox
facts separately. A paused Issue with a running Run and a terminal Agent Turn
usually indicates that synchronous Agent settlement re-entered Issue mutation
while the stop caller still held the same per-Issue mutex.

The invariant is:

> Never call Agent Host, git worktree operations, or another re-entrant module
> while holding the Issue mutation lock.

Cancellation should persist `dispatchPaused=true` and snapshot running Runs
under the lock, release it, then cancel Agent Sessions and idempotently settle
Runs from exact canonical Turn facts. A regression test should use a canceller
that publishes settlement synchronously before returning; a passive recorder
cannot reproduce this deadlock class. A second barrier test should pause while
launch is in flight and verify Stop returns immediately while the non-blocking
launch gate still requests exact-Turn compensation after launch.

Do not fix this symptom by treating the UI test as flaky, adding a timeout, or
introducing another pause flag. Those changes hide the blocked command without
repairing the callback cycle.

For the ownership and data-flow contract, see
[Issue Execution Coordination](../../architecture/issue-execution.md).
