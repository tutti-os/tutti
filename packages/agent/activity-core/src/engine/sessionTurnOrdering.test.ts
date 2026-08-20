import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityTurn } from "../types.ts";
import {
  compareTurnsByOccurrence,
  latestTurnForSession
} from "./sessionTurnOrdering.ts";

function makeTurn(
  overrides: Partial<AgentActivityTurn> = {}
): AgentActivityTurn {
  return {
    turnId: "turn-1",
    agentSessionId: "session-1",
    origin: "user_prompt",
    phase: "settled",
    outcome: "completed",
    startedAtUnixMs: 1,
    settledAtUnixMs: 2,
    updatedAtUnixMs: 2,
    ...overrides
  } as AgentActivityTurn;
}

test("returns null for blank, unknown, or empty sessions", () => {
  const turnsById = { "turn-1": makeTurn() };

  assert.equal(latestTurnForSession({}, "session-1"), null);
  assert.equal(latestTurnForSession(turnsById, "   "), null);
  assert.equal(latestTurnForSession(turnsById, "session-2"), null);
});

test("normalizes session ids and selects the newest turn", () => {
  const older = makeTurn({
    turnId: "turn-older",
    agentSessionId: " session-1 ",
    startedAtUnixMs: 10
  });
  const newer = makeTurn({
    turnId: "turn-newer",
    startedAtUnixMs: 11
  });

  assert.equal(
    latestTurnForSession({ older, newer }, " session-1 ")?.turnId,
    "turn-newer"
  );
});

test("uses turn id as a deterministic tie-breaker", () => {
  const first = makeTurn({ turnId: "turn-a", startedAtUnixMs: 10 });
  const second = makeTurn({ turnId: "turn-b", startedAtUnixMs: 10 });

  assert.equal(compareTurnsByOccurrence(first, second) < 0, true);
  assert.equal(
    latestTurnForSession({ first, second }, "session-1")?.turnId,
    "turn-b"
  );
});
