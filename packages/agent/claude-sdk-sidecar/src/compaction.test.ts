import assert from "node:assert/strict";
import test from "node:test";
import {
  CompactionTracker,
  isContextOverflowCompactionFailure
} from "./compaction.ts";
import type { ClaudeSDKSidecarEvent } from "./protocol.ts";

function createTracker(
  events: ClaudeSDKSidecarEvent[],
  activeTurnId = () => "turn-1"
): CompactionTracker {
  return new CompactionTracker({
    activeTurnId,
    ensureActive: () => {},
    clearPendingOrphans: () => {},
    getQuery: () => undefined,
    getModel: () => "sonnet",
    emit: (event) => events.push(event as ClaudeSDKSidecarEvent)
  });
}

test("compaction failure collapses a duplicated provider reason", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = createTracker(events);

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

test("pinned CLI compact_result overflow failure requires a new-conversation handoff", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = createTracker(events);
  const compactError =
    "Compaction failed · conversation could not be reduced below the context limit";

  tracker.selectCommand("turn-1", true);
  assert.equal(
    tracker.handleSystemMessage("status", { status: "compacting" }),
    true
  );
  assert.equal(
    tracker.handleSystemMessage("status", {
      compact_result: "failed",
      compact_error: compactError
    }),
    true
  );
  tracker.noteAssistantText(compactError);

  const failures = events.filter((event) => event.type === "compact_failed");
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0]?.payload, {
    turnId: "turn-1",
    reason: compactError,
    contextHandoffRequired: true,
    content: `Compacting failed: ${compactError}`
  });
});

test("non-overflow compact failure does not require a handoff", () => {
  assert.equal(
    isContextOverflowCompactionFailure("Not enough messages to compact."),
    false
  );
});

test("slash compact starts a progress banner before provider signals", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = createTracker(events, () => "");

  tracker.selectCommand("turn-compact", true);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "compact_started");
  assert.equal(events[0]?.payload?.turnId, "turn-compact");
});

test("slash compact start is idempotent with later status compacting", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = createTracker(events);

  tracker.selectCommand("turn-1", true);
  tracker.handleSystemMessage("status", { status: "compacting" });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "compact_started");
});

test("camelCase compactMetadata still publishes boundary usage", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = createTracker(events);
  tracker.selectCommand("turn-1", true);

  tracker.handleSystemMessage("compact_boundary", {
    compactMetadata: {
      trigger: "manual",
      preTokens: 48000,
      postTokens: 1990
    }
  });

  assert.equal(
    events.some((event) => event.type === "compact_completed"),
    true
  );
  const usage = events.find((event) => event.type === "usage_updated");
  assert.deepEqual(usage?.payload?.contextWindow, {
    usedTokens: 1990,
    lastUsedTokens: 48000
  });
});

test("local_command stdout marks compact failure before turn settle", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = createTracker(events);
  tracker.selectCommand("turn-1", true);

  tracker.handleSystemMessage("local_command", {
    content:
      "<local-command-stdout>Not enough messages to compact.</local-command-stdout>"
  });

  assert.equal(
    events.find((event) => event.type === "compact_failed")?.payload?.reason,
    "Not enough messages to compact."
  );
});

test("local_command_output Compacted completes the slash compact banner", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = createTracker(events);
  tracker.selectCommand("turn-1", true);

  tracker.handleSystemMessage("local_command_output", {
    content: "Compacted "
  });

  assert.equal(
    events.some((event) => event.type === "compact_completed"),
    true
  );
});

test("assistant failure copy during slash compact emits compact_failed", () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = createTracker(events);
  tracker.selectCommand("turn-1", true);

  tracker.noteAssistantText("Not enough messages to compact.");

  assert.equal(
    events.find((event) => event.type === "compact_failed")?.payload?.reason,
    "Not enough messages to compact."
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
    getModel: () => "sonnet",
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

test("a result for another model cannot publish the query fallback window", async () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = new CompactionTracker({
    activeTurnId: () => "turn-1",
    ensureActive: () => {},
    clearPendingOrphans: () => {},
    getQuery: () => ({
      getContextUsage: async () => ({ totalTokens: 222, maxTokens: 200_000 })
    }),
    getModel: () => "opus",
    emit: (event) => events.push(event as ClaudeSDKSidecarEvent)
  });

  assert.equal(
    await tracker.emitContextUsageSnapshot("turn-1", {
      modelUsage: {
        "claude-haiku-4-5": { contextWindow: 200_000 }
      }
    }),
    "stale"
  );
  assert.deepEqual(events, []);
});

test("restore usage publishes the raw hard limit and auto-compact diagnostics", async () => {
  const events: ClaudeSDKSidecarEvent[] = [];
  const tracker = new CompactionTracker({
    activeTurnId: () => "",
    ensureActive: () => {},
    clearPendingOrphans: () => {},
    getQuery: () => ({
      getContextUsage: async () => ({
        totalTokens: 915_111,
        maxTokens: 200_000,
        rawMaxTokens: 1_048_576,
        autoCompactThreshold: 867_000,
        isAutoCompactEnabled: true
      })
    }),
    getModel: () => "default",
    emit: (event) => events.push(event as ClaudeSDKSidecarEvent)
  });

  assert.equal(await tracker.emitContextUsageSnapshot(""), "emitted");
  assert.deepEqual(events[0]?.payload?.contextWindow, {
    usedTokens: 915_111,
    totalTokens: 1_048_576,
    rawMaxTokens: 1_048_576,
    sdkMaxTokens: 200_000,
    autoCompactThresholdTokens: 867_000,
    compactsAutomatically: true
  });
});
