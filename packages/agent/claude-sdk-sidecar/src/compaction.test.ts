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
