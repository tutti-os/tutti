import assert from "node:assert/strict";
import test from "node:test";
import { CompactionTracker } from "./compaction.ts";
import type { ClaudeSDKSidecarEvent } from "./protocol.ts";

test("compaction failure collapses a duplicated provider reason", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = new CompactionTracker({
    activeTurnId: () => "turn-1",
    ensureActive: () => {},
    clearPendingOrphans: () => {},
    getQuery: () => undefined,
    emit: (event) => events.push(event as ClaudeSDKSidecarEvent)
  });

  tracker.handleSystemMessage("status", { status: "compacting" });
  tracker.handleSystemMessage("status", {
    compact_result: "failed",
    compact_error:
      "Not enough messages to compact.Not enough messages to compact."
  });

  assert.equal(
    events[1]?.payload?.content,
    "Compacting failed: Not enough messages to compact."
  );
});

test("a newer context usage request supersedes an older delayed snapshot", async () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const resolvers: Array<(value: unknown) => void> = [];
  const tracker = new CompactionTracker({
    activeTurnId: () => "turn-1",
    ensureActive: () => {},
    clearPendingOrphans: () => {},
    getQuery: () => ({
      getContextUsage: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    }),
    emit: (event) => events.push(event as ClaudeSDKSidecarEvent)
  });

  const older = tracker.emitContextUsageSnapshot("turn-1");
  const newer = tracker.emitContextUsageSnapshot("turn-1");
  resolvers[1]?.({ totalTokens: 222, maxTokens: 200_000 });
  assert.equal(await newer, "emitted");
  resolvers[0]?.({ totalTokens: 111, maxTokens: 200_000 });
  assert.equal(await older, "stale");

  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.payload?.contextWindow, {
    usedTokens: 222,
    totalTokens: 200_000,
    compactsAutomatically: false
  });
});
