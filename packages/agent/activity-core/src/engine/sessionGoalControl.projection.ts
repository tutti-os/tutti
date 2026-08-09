import type {
  AgentActivityGoalControlAction,
  AgentActivitySessionGoal
} from "../types.ts";

export function projectSessionGoalControl(
  currentGoal: AgentActivitySessionGoal | null,
  action: AgentActivityGoalControlAction,
  objective?: string
): AgentActivitySessionGoal | null {
  switch (action) {
    case "clear":
      return null;
    case "pause":
      return currentGoal ? { ...currentGoal, status: "paused" } : null;
    case "resume":
      return currentGoal ? { ...currentGoal, status: "active" } : null;
    case "set": {
      const normalizedObjective = objective?.trim() ?? "";
      return normalizedObjective
        ? { objective: normalizedObjective, status: "active" }
        : currentGoal;
    }
  }
}

export function sessionGoalsEqual(
  left: AgentActivitySessionGoal | null,
  right: AgentActivitySessionGoal | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.objective === right.objective &&
      left.status === right.status &&
      left.reason === right.reason &&
      left.startedAtUnixMs === right.startedAtUnixMs &&
      left.iterations === right.iterations &&
      left.durationMs === right.durationMs &&
      left.tokens === right.tokens)
  );
}
