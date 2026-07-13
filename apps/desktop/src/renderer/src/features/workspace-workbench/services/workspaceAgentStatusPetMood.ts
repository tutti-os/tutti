import {
  selectEngineHasQueuedPrompts,
  selectSessionActivationPresentations,
  selectWorkspaceAgentConsumerCounts,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";

export type WorkspaceAgentStatusPetMood =
  | "failed"
  | "idle"
  | "review"
  | "running"
  | "waiting";

export function resolveWorkspaceAgentStatusPetMood(
  state: AgentSessionEngineState
): WorkspaceAgentStatusPetMood {
  const counts = selectWorkspaceAgentConsumerCounts(state);
  if (counts.waiting > 0) {
    return "waiting";
  }
  if (counts.failed > 0) {
    return "failed";
  }
  if (counts.working > 0) {
    return "running";
  }
  const hasActivatingSession = Object.values(
    selectSessionActivationPresentations(state)
  ).some((activation) => activation.status === "activating");
  const hasQueuedPrompt = selectEngineHasQueuedPrompts(state);
  if (hasQueuedPrompt || hasActivatingSession) {
    return "review";
  }
  return "idle";
}
