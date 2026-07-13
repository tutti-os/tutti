import { useCallback } from "react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import { dispatchAgentPlanPromptAction } from "../../../shared/agentConversation/agentPlanPromptDispatch";
import {
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP
} from "../../../shared/agentConversation/planImplementationPresentation";

interface CurrentValue<T> {
  current: T;
}

interface UseAgentGUIPlanActionsInput {
  activeConversationIdRef: CurrentValue<string | null>;
  planActionsRef: CurrentValue<{
    implement: () => void;
    feedback: (feedback: string) => void;
    skip: () => void;
  }>;
  planImplementationTurnIdRef: CurrentValue<string | null>;
  sessionEngine: AgentSessionEngine;
  workspaceId: string;
}

export function useAgentGUIPlanActions(input: UseAgentGUIPlanActionsInput) {
  const dispatchPlanAction = useCallback(
    (
      action: Parameters<typeof dispatchAgentPlanPromptAction>[0]["action"],
      feedbackText?: string
    ) => {
      const agentSessionId = input.activeConversationIdRef.current;
      const turnId = input.planImplementationTurnIdRef.current;
      if (!agentSessionId || !turnId) return;
      dispatchAgentPlanPromptAction({
        action,
        agentSessionId,
        engine: input.sessionEngine,
        ...(feedbackText !== undefined ? { feedbackText } : {}),
        requestId: turnId,
        workspaceId: input.workspaceId
      });
    },
    [
      input.activeConversationIdRef,
      input.planImplementationTurnIdRef,
      input.sessionEngine,
      input.workspaceId
    ]
  );
  const implement = useCallback(
    () => dispatchPlanAction(PLAN_IMPLEMENTATION_ACTION_IMPLEMENT),
    [dispatchPlanAction]
  );
  const feedback = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        dispatchPlanAction(PLAN_IMPLEMENTATION_ACTION_FEEDBACK, trimmed);
      }
    },
    [dispatchPlanAction]
  );
  const skip = useCallback(
    () => dispatchPlanAction(PLAN_IMPLEMENTATION_ACTION_SKIP),
    [dispatchPlanAction]
  );
  input.planActionsRef.current = { implement, feedback, skip };
}
