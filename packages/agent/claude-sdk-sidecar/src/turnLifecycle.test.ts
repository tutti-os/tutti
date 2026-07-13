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

function createLifecycle(): {
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
    }
  });
  return { lifecycle, events, activations, settlements };
}
