---
"@tutti-os/agent-activity-core": minor
---

Remove the public `PromptQueueAvailability` type and derive prompt-queue drain
readiness exclusively from post-reduction canonical session, turn, and
interaction lifecycle. Timed-out delivery confirmations now require an exact
turn id and wait for that canonical turn to settle before draining the next
prompt.
