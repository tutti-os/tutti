import { describe, expect, it } from "vitest";
import {
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_PROMPT,
  latestPlanTurnId,
  planImplementationPromptFromPlanTurn
} from "./planImplementationPresentation";

describe("plan implementation presentation", () => {
  it("exposes the semantic implement action and prompt copy", () => {
    expect(PLAN_IMPLEMENTATION_ACTION_IMPLEMENT).toBe("implement");
    expect(PLAN_IMPLEMENTATION_PROMPT).toBe("Implement the plan.");
  });

  it("projects a plan implementation prompt", () => {
    expect(
      planImplementationPromptFromPlanTurn("turn-1", "Implement?")
    ).toEqual({
      kind: "plan-implementation",
      requestId: "turn-1",
      title: "Implement?"
    });
  });

  it("returns the latest turn only when it contains a plan item", () => {
    expect(
      latestPlanTurnId([
        {
          turnId: "turn-1",
          occurredAtUnixMs: 1,
          payload: { messageKind: "plan" }
        },
        {
          turnId: "turn-2",
          occurredAtUnixMs: 2,
          payload: { messageKind: "text" }
        }
      ])
    ).toBeNull();
    expect(
      latestPlanTurnId([
        {
          turnId: "turn-1",
          occurredAtUnixMs: 1,
          payload: { messageKind: "text" }
        },
        {
          turnId: "turn-2",
          occurredAtUnixMs: 2,
          payload: { messageKind: "plan" }
        }
      ])
    ).toBe("turn-2");
  });
});
