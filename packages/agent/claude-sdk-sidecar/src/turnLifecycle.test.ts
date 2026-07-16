import assert from "node:assert/strict";
import test from "node:test";
import type { ClaudeSDKSidecarEvent } from "./protocol.ts";
import { TurnLifecycle } from "./turnLifecycle.ts";

test("turn lifecycle activates and settles a queued turn", () => {
  const { lifecycle, events, activations, settlements } = createLifecycle();
  lifecycle.enqueue({
    turnId: "turn-1",
    promptUuid: "prompt-1",
    settled: false
  });

  lifecycle.activateForUserMessage("prompt-1");
  lifecycle.settleActive("turn_completed", { stopReason: "end_turn" });

  assert.equal(lifecycle.activeId, "");
  assert.equal(lifecycle.turnCount, 1);
  assert.equal(activations.count, 1);
  assert.equal(settlements.count, 1);
  assert.deepEqual(events[0], {
    type: "turn_completed",
    payload: { stopReason: "end_turn", turnId: "turn-1" }
  });
});

test("turn lifecycle announces a goal arm before its first output", () => {
  const { lifecycle, events } = createLifecycle();
  lifecycle.enqueue({
    turnId: "goal-arm-1",
    promptUuid: "prompt-goal",
    origin: "goal_arm",
    settled: false
  });

  lifecycle.activateForUserMessage("prompt-goal");

  assert.deepEqual(events[0], {
    type: "turn_started",
    payload: { turnId: "goal-arm-1", turnOrigin: "goal_arm" }
  });
});

test("goal activation carries its immutable command identity", () => {
  const { lifecycle, events } = createLifecycle();
  lifecycle.enqueue({
    turnId: "goal-arm-immutable",
    promptUuid: "prompt-goal-immutable",
    origin: "goal_arm",
    goalOperationId: "goal-op-1",
    goalRevision: 1,
    goalRepairEpoch: 7,
    goalAction: "set",
    settled: false
  });

  lifecycle.activateForUserMessage("prompt-goal-immutable");

  const applied = events.find((event) => event.type === "goal_command_started");
  assert.equal(applied?.payload?.operationId, "goal-op-1");
  assert.equal(applied?.payload?.revision, 1);
  assert.equal(applied?.payload?.repairEpoch, 7);
  const started = events.find((event) => event.type === "turn_started");
  assert.equal(started?.payload?.sourceGoalOperationId, "goal-op-1");
  assert.equal(started?.payload?.sourceGoalRevision, 1);
  assert.equal(started?.payload?.sourceGoalRepairEpoch, 7);
});

test("turn lifecycle creates an explicit synthetic turn for orphan assistant output", () => {
  const { lifecycle, events } = createLifecycle();

  const turn = lifecycle.ensureActive("assistant");

  assert.equal(turn?.synthetic, true);
  assert.match(turn?.turnId ?? "", /^synthetic-/u);
  assert.equal(events[0]?.type, "turn_started");
  assert.equal(events[0]?.payload?.synthetic, true);
});

test("turn lifecycle cancels queued turns and consumes their orphan results", () => {
  const { lifecycle, events } = createLifecycle();
  lifecycle.enqueue({
    turnId: "turn-1",
    promptUuid: "prompt-1",
    settled: false
  });
  lifecycle.enqueue({
    turnId: "turn-2",
    promptUuid: "prompt-2",
    settled: false
  });
  lifecycle.activateForUserMessage("prompt-1");

  assert.equal(lifecycle.cancelQueued(), true);
  assert.equal(lifecycle.pendingOrphans, 1);
  assert.equal(lifecycle.consumePendingOrphan(), true);
  assert.equal(lifecycle.consumePendingOrphan(), false);
  assert.equal(events.at(-1)?.type, "turn_canceled");
  assert.equal(events.at(-1)?.payload?.turnId, "turn-2");
});

test("notification-reserved synthetic turn times out and rejects late continuation", async () => {
  const timeouts = { count: 0 };
  const { lifecycle, events } = createLifecycle({
    continuationStartTimeoutMs: 5,
    onContinuationStartTimeout: () => {
      timeouts.count += 1;
    }
  });

  const reserved = lifecycle.expectSyntheticContinuation();
  assert.equal(reserved?.synthetic, true);
  assert.equal(lifecycle.awaitingContinuation, true);
  assert.equal(events[0]?.type, "turn_started");

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(timeouts.count, 1);
  assert.equal(lifecycle.activeId, "");
  assert.deepEqual(events.at(-1), {
    type: "turn_completed",
    payload: {
      stopReason: "background_agent_continuation_timeout",
      syntheticTimeout: true,
      turnId: reserved?.turnId
    }
  });
  assert.equal(lifecycle.ensureActive("assistant"), undefined);
  assert.equal(lifecycle.consumeTimedOutContinuationResult(), true);

  lifecycle.enqueue({
    turnId: "turn-after-timeout",
    promptUuid: "prompt-after-timeout",
    settled: false
  });
  lifecycle.activateForUserMessage("prompt-after-timeout");
  assert.equal(lifecycle.activeId, "turn-after-timeout");
  assert.equal(lifecycle.consumeTimedOutContinuationResult(), false);
});

test("root output confirms a reserved continuation and disarms its start timeout", async () => {
  const timeouts = { count: 0 };
  const { lifecycle, events } = createLifecycle({
    continuationStartTimeoutMs: 5,
    onContinuationStartTimeout: () => {
      timeouts.count += 1;
    }
  });
  const reserved = lifecycle.expectSyntheticContinuation();

  assert.equal(lifecycle.ensureActive("assistant"), reserved);
  assert.equal(lifecycle.awaitingContinuation, false);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(timeouts.count, 0);
  assert.equal(
    events.filter((event) => event.type === "turn_started").length,
    1
  );
  assert.equal(
    events.some((event) => event.type === "turn_completed"),
    false
  );
  lifecycle.settleActive("turn_completed");
});

test("cancel and guidance preserve reserved continuation ownership", async () => {
  const timeouts = { count: 0 };
  const { lifecycle, events } = createLifecycle({
    continuationStartTimeoutMs: 5,
    onContinuationStartTimeout: () => {
      timeouts.count += 1;
    }
  });
  const reserved = lifecycle.expectSyntheticContinuation();

  lifecycle.activateForUserMessage("guidance-prompt");
  assert.equal(lifecycle.activeTurn, reserved);
  assert.equal(
    events.filter((event) => event.type === "turn_started").length,
    1
  );

  assert.equal(lifecycle.cancelQueued(), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timeouts.count, 0);
  lifecycle.settleActive("turn_canceled");
  assert.equal(events.at(-1)?.type, "turn_canceled");
  assert.equal(events.at(-1)?.payload?.turnId, reserved?.turnId);
});

function createLifecycle(
  options: {
    continuationStartTimeoutMs?: number;
    onContinuationStartTimeout?: () => void;
  } = {}
): {
  lifecycle: TurnLifecycle;
  events: Array<Omit<ClaudeSDKSidecarEvent, "version">>;
  activations: { count: number };
  settlements: { count: number };
} {
  const events: Array<Omit<ClaudeSDKSidecarEvent, "version">> = [];
  const activations = { count: 0 };
  const settlements = { count: 0 };
  const lifecycle = new TurnLifecycle({
    emit: (event) => events.push(event),
    onActivate: () => {
      activations.count += 1;
    },
    onSettled: () => {
      settlements.count += 1;
    },
    ...options
  });
  return { lifecycle, events, activations, settlements };
}
