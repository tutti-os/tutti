import { useCallback } from "react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUIAgentTarget } from "../../../types";
import { dispatchAgentPlanPromptAction } from "../../../shared/agentConversation/agentPlanPromptDispatch";
import {
  buildPlanOrchestrationPrompt,
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP
} from "../../../shared/agentConversation/planImplementationPresentation";
import type {
  PlanIssueCreationOptions,
  PlanIssueDraft
} from "../../../shared/agentConversation/planImplementationPresentation";
import { translate } from "../../../i18n/index";
import { planOrchestrationCatalogFromRuntime } from "../model/planOrchestrationCatalog";

interface CurrentValue<T> {
  current: T;
}

interface UseAgentGUIPlanActionsInput {
  activeConversationIdRef: CurrentValue<string | null>;
  agentActivityRuntime: Pick<AgentActivityRuntime, "listModelPlans">;
  normalizedProviderTargets: readonly AgentGUIAgentTarget[];
  planActionsRef: CurrentValue<{
    createIssue: (creationOptions?: PlanIssueCreationOptions) => void;
    implement: () => void;
    orchestrate: (draft: PlanIssueDraft, displayPrompt: string) => void;
    feedback: (feedback: string) => void;
    skip: () => void;
  }>;
  planImplementationTurnIdRef: CurrentValue<string | null>;
  sessionEngine: AgentSessionEngine;
  workspaceId: string;
  onCreateIssueFromPlan?: (input: {
    agentSessionId: string;
    creationOptions?: PlanIssueCreationOptions;
    planTurnId: string;
    workspaceId: string;
  }) =>
    | Promise<{ issueId: string; topicId: string }>
    | { issueId: string; topicId: string };
  onShowMessage?: (
    message: string,
    tone?: "info" | "warning" | "error"
  ) => void;
}

export function useAgentGUIPlanActions(input: UseAgentGUIPlanActionsInput) {
  const dispatchPlanAction = useCallback(
    (
      action: Parameters<typeof dispatchAgentPlanPromptAction>[0]["action"],
      feedbackText?: string,
      runtimeFeedbackText?: string
    ) => {
      const agentSessionId = input.activeConversationIdRef.current;
      const turnId = input.planImplementationTurnIdRef.current;
      if (!agentSessionId || !turnId) return;
      dispatchAgentPlanPromptAction({
        action,
        agentSessionId,
        engine: input.sessionEngine,
        ...(feedbackText !== undefined ? { feedbackText } : {}),
        ...(runtimeFeedbackText !== undefined ? { runtimeFeedbackText } : {}),
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
  const createIssue = (creationOptions?: PlanIssueCreationOptions): void => {
    const agentSessionId = input.activeConversationIdRef.current;
    const planTurnId = input.planImplementationTurnIdRef.current;
    if (!agentSessionId || !planTurnId || !input.onCreateIssueFromPlan) return;
    void Promise.resolve(
      input.onCreateIssueFromPlan({
        agentSessionId,
        ...(creationOptions ? { creationOptions } : {}),
        planTurnId,
        workspaceId: input.workspaceId
      })
    ).catch((error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      input.onShowMessage?.(
        errorMessage === "agent_plan_parallel_worktree_unavailable"
          ? translate("agentHost.agentGui.planIssueParallelWorktreeUnavailable")
          : errorMessage,
        "error"
      );
    });
  };
  const feedback = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        dispatchPlanAction(PLAN_IMPLEMENTATION_ACTION_FEEDBACK, trimmed);
      }
    },
    [dispatchPlanAction]
  );
  const orchestrate = (draft: PlanIssueDraft, displayPrompt: string): void => {
    const normalizedDisplayPrompt = displayPrompt.trim();
    if (!normalizedDisplayPrompt || draft.stage !== "budget") return;
    const requestedSessionId = input.activeConversationIdRef.current;
    const requestedTurnId = input.planImplementationTurnIdRef.current;
    void Promise.resolve(
      input.agentActivityRuntime.listModelPlans?.({
        workspaceId: input.workspaceId
      }) ?? { plans: [] }
    )
      .then(({ plans }) => {
        if (
          input.activeConversationIdRef.current !== requestedSessionId ||
          input.planImplementationTurnIdRef.current !== requestedTurnId
        ) {
          return;
        }
        dispatchPlanAction(
          PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
          normalizedDisplayPrompt,
          buildPlanOrchestrationPrompt(
            draft,
            planOrchestrationCatalogFromRuntime({
              agentTargets: input.normalizedProviderTargets,
              modelPlans: plans
            })
          )
        );
      })
      .catch((error: unknown) => {
        input.onShowMessage?.(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      });
  };
  const skip = useCallback(
    () => dispatchPlanAction(PLAN_IMPLEMENTATION_ACTION_SKIP),
    [dispatchPlanAction]
  );
  input.planActionsRef.current = {
    createIssue,
    implement,
    orchestrate,
    feedback,
    skip
  };
}
