import { describe, expect, it } from "vitest";
import {
  canonicalGoalConfirmsOptimisticGoal,
  projectOptimisticGoalControl,
  unresolvedOptimisticGoalControl
} from "./agentGuiOptimisticGoal";

describe("optimistic goal projection", () => {
  it("projects goal controls without mutating the canonical goal", () => {
    const current = { objective: "ship it", status: "active" as const };

    expect(projectOptimisticGoalControl(current, "pause")).toEqual({
      objective: "ship it",
      status: "paused"
    });
    expect(current.status).toBe("active");
    expect(projectOptimisticGoalControl(current, "clear")).toBeNull();
  });

  it("waits for exact status reconciliation for direct controls", () => {
    const optimistic = { objective: "ship it", status: "paused" as const };

    expect(
      canonicalGoalConfirmsOptimisticGoal(
        { objective: "ship it", status: "active" },
        optimistic,
        false
      )
    ).toBe(false);
    expect(
      canonicalGoalConfirmsOptimisticGoal(
        { objective: "ship it", status: "paused" },
        optimistic,
        false
      )
    ).toBe(true);
  });

  it("accepts any authoritative status for a newly activated goal", () => {
    expect(
      canonicalGoalConfirmsOptimisticGoal(
        { objective: "ship it", status: "blocked" },
        { objective: "ship it", status: "active" },
        true
      )
    ).toBe(true);
  });

  it("keeps the overlay until the active session confirms it", () => {
    const optimistic = {
      agentSessionId: "session-1",
      goal: { objective: "ship it", status: "active" as const },
      reconcileOnObjectiveMatch: true,
      requestId: "goal-activation:1"
    };

    expect(unresolvedOptimisticGoalControl(optimistic, "session-1", null)).toBe(
      optimistic
    );
    expect(
      unresolvedOptimisticGoalControl(optimistic, "session-1", {
        agentSessionId: "session-1",
        goal: { objective: "ship it", status: "blocked" }
      })
    ).toBeNull();
  });
});
