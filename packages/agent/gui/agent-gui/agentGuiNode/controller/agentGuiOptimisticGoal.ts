import type {
  AgentActivityGoalControlAction,
  AgentActivitySessionGoal,
  CanonicalAgentSession
} from "@tutti-os/agent-activity-core";
import type { AgentGUIOptimisticGoalControl } from "../model/agentGuiNodeTypes";

export function projectOptimisticGoalControl(
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

export function canonicalGoalConfirmsOptimisticGoal(
  canonicalGoal: AgentActivitySessionGoal | null,
  optimisticGoal: AgentActivitySessionGoal | null,
  reconcileOnObjectiveMatch: boolean
): boolean {
  if (optimisticGoal === null) {
    return canonicalGoal === null;
  }
  if (canonicalGoal?.objective !== optimisticGoal.objective) {
    return false;
  }
  return (
    reconcileOnObjectiveMatch || canonicalGoal.status === optimisticGoal.status
  );
}

export function unresolvedOptimisticGoalControl(
  optimisticGoalControl: AgentGUIOptimisticGoalControl | null,
  agentSessionId: string | null,
  canonicalSession: Pick<
    CanonicalAgentSession,
    "agentSessionId" | "goal"
  > | null
): AgentGUIOptimisticGoalControl | null {
  if (
    optimisticGoalControl?.agentSessionId !== agentSessionId ||
    canonicalSession?.agentSessionId !== agentSessionId
  ) {
    return optimisticGoalControl?.agentSessionId === agentSessionId
      ? optimisticGoalControl
      : null;
  }
  return canonicalGoalConfirmsOptimisticGoal(
    canonicalSession.goal,
    optimisticGoalControl.goal,
    optimisticGoalControl.reconcileOnObjectiveMatch
  )
    ? null
    : optimisticGoalControl;
}
