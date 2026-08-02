import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeGoalProjection } from "./goalProjection.ts";
import type { ClaudeSDKSidecarEvent } from "./protocol.ts";
import { TurnLifecycle } from "./turnLifecycle.ts";

type EmittedEvent = Omit<ClaudeSDKSidecarEvent, "version">;

test("goal transcript failure becomes a fenced blocked lifecycle", () => {
  const events: EmittedEvent[] = [];
  const turns = testTurnLifecycle(events);
  turns.enqueue({
    turnId: "goal-arm",
    promptUuid: "provider-goal-arm",
    origin: "goal_arm",
    goalOperationId: "goal-op-1",
    goalRevision: 4,
    goalRepairEpoch: 2,
    goalAction: "set",
    settled: false
  });
  turns.activateForUserMessage("provider-goal-arm");
  const projection = new ClaudeGoalProjection(turns, (event) =>
    events.push(event)
  );

  projection.observeTranscriptEntries([
    {
      type: "attachment",
      uuid: "goal-sentinel",
      timestamp: "2026-08-02T01:00:00.000Z",
      attachment: {
        type: "goal_status",
        sentinel: true,
        met: false,
        condition: "ship it"
      }
    },
    {
      type: "attachment",
      uuid: "goal-failed",
      timestamp: "2026-08-02T01:00:01.000Z",
      attachment: {
        type: "goal_status",
        met: false,
        failed: true,
        condition: "ship it",
        reason: "evaluator failed",
        iterations: 2
      }
    }
  ]);

  const observations = events.filter((event) => event.type === "goal_observed");
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[1]?.payload, {
    turnId: "goal-arm",
    providerTurnId: "provider-goal-arm",
    action: "set",
    goalOperationId: "goal-op-1",
    goalRevision: 4,
    goalRepairEpoch: 2,
    occurredAtUnixMs: Date.parse("2026-08-02T01:00:01.000Z"),
    source: "transcript_mirror",
    updateType: "thread_goal_update",
    goal: {
      objective: "ship it",
      status: "blocked",
      reason: "evaluator failed",
      iterations: 2
    }
  });
});

test("goal transcript entries without immutable provenance fail closed", () => {
  const events: EmittedEvent[] = [];
  const turns = testTurnLifecycle(events);
  turns.enqueue({
    turnId: "ordinary-turn",
    promptUuid: "ordinary-provider-turn",
    settled: false
  });
  turns.activateForUserMessage("ordinary-provider-turn");
  const projection = new ClaudeGoalProjection(turns, (event) =>
    events.push(event)
  );
  const unfenced = {
    type: "attachment",
    uuid: "unfenced-goal",
    attachment: {
      type: "goal_status",
      sentinel: true,
      met: false,
      condition: "ship it"
    }
  };

  projection.observeTranscriptEntries([unfenced]);
  assert.equal(
    events.some((event) => event.type === "goal_observed"),
    false
  );

  turns.settleActive("turn_completed");
  turns.enqueue({
    turnId: "goal-arm",
    promptUuid: "provider-goal-arm",
    goalOperationId: "goal-op-1",
    goalRevision: 1,
    goalAction: "set",
    settled: false
  });
  turns.activateForUserMessage("provider-goal-arm");
  projection.observeTranscriptEntries([unfenced]);
  assert.equal(
    events.some((event) => event.type === "goal_observed"),
    false
  );
});

test("restored active generation accepts later transcript completion", () => {
  const events: EmittedEvent[] = [];
  const turns = testTurnLifecycle(events);
  const projection = new ClaudeGoalProjection(turns, (event) =>
    events.push(event)
  );
  projection.restoreGeneration(
    {
      operationId: "goal-op-restored",
      revision: 9,
      repairEpoch: 1,
      activatedAtUnixMs: Date.parse("2026-08-02T00:59:59.000Z")
    },
    { objective: "ship it", status: "active" }
  );

  projection.observeTranscriptEntries([
    {
      type: "attachment",
      uuid: "restored-complete",
      timestamp: "2026-08-02T01:00:00.000Z",
      attachment: {
        type: "goal_status",
        met: true,
        condition: "ship it",
        iterations: 3
      }
    }
  ]);

  const observation = events.find((event) => event.type === "goal_observed");
  assert.equal(observation?.payload?.goalOperationId, "goal-op-restored");
  assert.equal(observation?.payload?.goalRevision, 9);
  assert.deepEqual(observation?.payload?.goal, {
    objective: "ship it",
    status: "complete",
    iterations: 3
  });
});

test("successful provider clear retires the replay generation", () => {
  const events: EmittedEvent[] = [];
  const projection = new ClaudeGoalProjection(
    testTurnLifecycle(events),
    (event) => events.push(event)
  );
  projection.restoreGeneration(
    {
      operationId: "goal-op-restored",
      revision: 9,
      repairEpoch: 1,
      activatedAtUnixMs: Date.parse("2026-08-02T01:00:00.000Z")
    },
    { objective: "ship it", status: "active" }
  );

  projection.settleGoalControl("clear", false);
  assert.equal(projection.shouldReplayNativeTranscript(), true);
  projection.settleGoalControl("clear", true);
  assert.equal(projection.shouldReplayNativeTranscript(), false);
});

test("restored generation without an activation fence fails closed", () => {
  const events: EmittedEvent[] = [];
  const projection = new ClaudeGoalProjection(
    testTurnLifecycle(events),
    (event) => events.push(event)
  );
  projection.restoreGeneration(
    { operationId: "goal-op-restored", revision: 9, repairEpoch: 1 },
    { objective: "ship it", status: "active" }
  );

  assert.equal(projection.shouldReplayNativeTranscript(), false);
});

test("restored repair generation ignores the prior repair terminal", () => {
  const events: EmittedEvent[] = [];
  const turns = testTurnLifecycle(events);
  const projection = new ClaudeGoalProjection(turns, (event) =>
    events.push(event)
  );
  const activatedAtUnixMs = Date.parse("2026-08-02T02:00:00.000Z");
  projection.restoreGeneration(
    {
      operationId: "goal-op-current",
      revision: 10,
      repairEpoch: 2,
      activatedAtUnixMs
    },
    { objective: "ship it", status: "active" }
  );

  projection.observeTranscriptEntries([
    {
      type: "attachment",
      uuid: "previous-complete",
      timestamp: "2026-08-02T01:59:59.000Z",
      attachment: {
        type: "goal_status",
        met: true,
        condition: "ship it"
      }
    },
    {
      type: "attachment",
      uuid: "current-complete",
      timestamp: "2026-08-02T02:00:01.000Z",
      attachment: {
        type: "goal_status",
        met: true,
        condition: "ship it"
      }
    }
  ]);

  const observations = events.filter((event) => event.type === "goal_observed");
  assert.equal(observations.length, 1);
  assert.equal(
    observations[0]?.payload?.occurredAtUnixMs,
    Date.parse("2026-08-02T02:00:01.000Z")
  );
});

function testTurnLifecycle(events: EmittedEvent[]): TurnLifecycle {
  return new TurnLifecycle({
    emit: (event) => events.push(event),
    onActivate: () => {},
    onSettled: () => {}
  });
}
