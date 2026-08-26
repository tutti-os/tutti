import type {
  AgentPlanPromptAction,
  WorkspaceAgentMessageCenterItem
} from "@tutti-os/agent-gui/agent-message-center";
import type { WorkspaceAgentDecisionSubmitInput } from "./workspaceAgentDecisionNotification.ts";

export interface WorkspaceAgentInteractionSubmission {
  action?: string;
  agentSessionId: string;
  optionId?: string;
  payload?: Record<string, unknown>;
  requestId: string;
  turnId: string;
}

export interface WorkspaceAgentPlanSubmission {
  action: AgentPlanPromptAction;
  agentSessionId: string;
  feedbackText?: string;
  requestId: string;
}

export function submitWorkspaceAgentDecision(input: {
  item: WorkspaceAgentMessageCenterItem;
  submitInput: WorkspaceAgentDecisionSubmitInput;
  dispatchPlanAction: (submission: WorkspaceAgentPlanSubmission) => boolean;
  submitInteractionResponse: (
    submission: WorkspaceAgentInteractionSubmission
  ) => boolean;
}): void {
  if (input.item.pendingPrompt?.kind === "plan-implementation") {
    const action = input.submitInput.action;
    if (
      input.item.pendingPrompt.requestId !== input.submitInput.requestId ||
      (action !== "implement" && action !== "feedback" && action !== "skip")
    ) {
      throw new Error("plan_response_target_mismatch");
    }
    const feedbackText = input.submitInput.payload?.text;
    const accepted = input.dispatchPlanAction({
      action,
      agentSessionId: input.item.agentSessionId,
      requestId: input.item.pendingPrompt.requestId,
      ...(typeof feedbackText === "string" ? { feedbackText } : {})
    });
    if (!accepted) {
      throw new Error("plan_response_not_accepted");
    }
    return;
  }
  const target = input.item.pendingInteractionTarget;
  if (!target || target.requestId !== input.submitInput.requestId) {
    throw new Error("interaction_response_target_mismatch");
  }
  const accepted = input.submitInteractionResponse({
    agentSessionId: target.agentSessionId,
    requestId: target.requestId,
    turnId: target.turnId,
    ...(input.submitInput.action ? { action: input.submitInput.action } : {}),
    ...(input.submitInput.optionId
      ? { optionId: input.submitInput.optionId }
      : {}),
    ...(input.submitInput.payload ? { payload: input.submitInput.payload } : {})
  });
  if (!accepted) {
    throw new Error("interaction_response_not_accepted");
  }
}
