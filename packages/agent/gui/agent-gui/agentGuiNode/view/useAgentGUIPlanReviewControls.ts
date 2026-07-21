import { useState } from "react";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto/agentSession";
import type { AgentComposerProps } from "../AgentComposer";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import {
  agentPromptContentDisplayText,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import { useStableEventCallback } from "./agentGUIViewUtils";
import {
  mergeTaskAssignmentDraft,
  taskAssignmentInputsFromDrafts,
  useTuttiModePlanPanels,
  type TuttiModePlanTaskAssignmentDraft,
  type TuttiModePlanTaskAssignmentDrafts
} from "../../../workspaceWorkflow";

interface AgentGUIPlanReviewScrollAnchor {
  conversationId: string;
  scrollHeight: number;
  scrollTop: number;
}

/**
 * Tutti plan-review control cluster for the detail pane: assignment drafts,
 * the earliest actionable checkpoint derivation, and the composer decision
 * surface (typed feedback vs empty-send accept) while a review is pending.
 */
export function useAgentGUIPlanReviewControls(input: {
  actions: AgentGUINodeViewProps["actions"];
  labels: AgentGUIViewLabels;
  pendingPrependScrollAnchorRef: {
    current: AgentGUIPlanReviewScrollAnchor | null;
  };
  previewMode: boolean;
  submittedPromptScrollConversationRef: { current: string | null };
  viewModel: AgentGUINodeViewModel;
}) {
  const {
    actions,
    labels,
    pendingPrependScrollAnchorRef,
    previewMode,
    submittedPromptScrollConversationRef,
    viewModel
  } = input;
  const tuttiModePlanPanels = useTuttiModePlanPanels({
    enabled: !previewMode,
    workspaceId: viewModel.shell.workspaceId,
    sourceSessionId: viewModel.rail.activeConversationId,
    decidedBy: viewModel.shell.currentUserId?.trim() || "local"
  });
  // Assignment drafts are host-owned (keyed by panel id) so a composer-driven
  // accept can carry them; the panel only renders and reports edits.
  const [planAssignmentDrafts, setPlanAssignmentDrafts] = useState<
    Readonly<Record<string, TuttiModePlanTaskAssignmentDrafts>>
  >({});
  const handlePlanAssignmentDraftChange = useStableEventCallback(
    (
      panelId: string,
      taskId: string,
      patch: TuttiModePlanTaskAssignmentDraft
    ): void => {
      setPlanAssignmentDrafts((current) => ({
        ...current,
        [panelId]: mergeTaskAssignmentDraft(
          current[panelId] ?? {},
          taskId,
          patch
        )
      }));
    }
  );
  // The composer decides the earliest actionable checkpoint (single-review
  // flow: at most one is pending per session).
  const pendingPlanPanel =
    tuttiModePlanPanels.panels.find((panel) => panel.actionable) ?? null;
  const pendingPlanSubmitting =
    pendingPlanPanel !== null &&
    tuttiModePlanPanels.submittingCheckpointId ===
      pendingPlanPanel.checkpoint.id;
  const planReviewSendActive =
    pendingPlanPanel !== null && !pendingPlanSubmitting;
  // Once the session intensity diverges from the plan's snapshot, an empty
  // send means "re-plan at the new intensity" instead of accepting; matching
  // values (including adjusting back) restore accept semantics.
  const planReviewIntensityDiverged =
    pendingPlanPanel !== null &&
    viewModel.composer.tuttiModeOrchestrationIntensity !==
      pendingPlanPanel.execution.orchestrationIntensity;
  const decidePendingPlan = useStableEventCallback(
    (decision: "accepted" | "rejected" | "canceled", reason?: string): void => {
      if (!pendingPlanPanel || pendingPlanSubmitting) return;
      const assignments =
        decision === "accepted"
          ? taskAssignmentInputsFromDrafts(
              planAssignmentDrafts[pendingPlanPanel.id] ?? {},
              pendingPlanPanel.tasks
            )
          : [];
      void tuttiModePlanPanels.decide({
        workflowId: pendingPlanPanel.workflowId,
        checkpointId: pendingPlanPanel.checkpoint.id,
        decision,
        reason,
        taskAssignments: assignments.length > 0 ? assignments : undefined
      });
    }
  );
  const acceptPendingPlan = useStableEventCallback((): void => {
    if (planReviewIntensityDiverged && pendingPlanPanel) {
      decidePendingPlan(
        "rejected",
        labels.tuttiModePlanReplanFeedback(
          String(pendingPlanPanel.execution.orchestrationIntensity),
          String(viewModel.composer.tuttiModeOrchestrationIntensity)
        )
      );
      return;
    }
    decidePendingPlan("accepted");
  });
  const cancelPendingPlan = useStableEventCallback((): void => {
    decidePendingPlan("canceled");
  });
  const setTuttiModeActive = useStableEventCallback(actions.setTuttiModeActive);
  // Turning Tutti mode off with a review still pending also cancels the
  // checkpoint: the banner and composer decision semantics clear with it, and
  // the agent continues naturally on the next message without plan context.
  const setTuttiModeActiveAndSettleReview = useStableEventCallback(
    (active: boolean): void => {
      if (!active) {
        decidePendingPlan("canceled");
      }
      setTuttiModeActive(active);
    }
  );
  const updateDraftContent = useStableEventCallback(actions.updateDraftContent);
  const submitPrompt = useStableEventCallback(actions.submitPrompt);
  const submitGuidancePrompt = useStableEventCallback(
    actions.submitGuidancePrompt
  );
  const requestSubmittedPromptScrollToBottom = useStableEventCallback(
    (): void => {
      const activeConversationId = viewModel.rail.activeConversationId;
      if (!activeConversationId) {
        return;
      }
      submittedPromptScrollConversationRef.current = activeConversationId;
      pendingPrependScrollAnchorRef.current = null;
    }
  );
  const submitPromptAndScrollToBottom = useStableEventCallback(
    (
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: Parameters<AgentComposerProps["onSubmit"]>[2]
    ): void => {
      requestSubmittedPromptScrollToBottom();
      if (displayPrompt === undefined) {
        submitPrompt(content, undefined, options);
        return;
      }
      submitPrompt(content, displayPrompt, options);
    }
  );
  // While a plan review is pending the composer doubles as the decision
  // surface: typed text becomes request-changes feedback (the daemon relays
  // it to the agent), an empty send accepts. Normal sends resume once the
  // checkpoint settles.
  const submitPromptOrDecidePlan = useStableEventCallback(
    (...args: Parameters<typeof submitPrompt>): void => {
      const [content] = args;
      if (pendingPlanPanel && !pendingPlanSubmitting) {
        let feedback = agentPromptContentDisplayText(content).trim();
        // Slash commands (e.g. the usage chip's "/compact") are never plan
        // feedback — let them flow through the normal submit path.
        if (feedback && !feedback.startsWith("/")) {
          if (planReviewIntensityDiverged) {
            feedback += labels.tuttiModePlanReplanFeedbackSuffix(
              String(viewModel.composer.tuttiModeOrchestrationIntensity)
            );
          }
          decidePendingPlan("rejected", feedback);
          updateDraftContent(
            updateAgentComposerDraft(viewModel.composer.draftContent, {
              prompt: ""
            })
          );
          return;
        }
      }
      submitPromptAndScrollToBottom(...args);
    }
  );
  const submitGuidancePromptAndScrollToBottom = useStableEventCallback(
    (...args: Parameters<typeof submitGuidancePrompt>): void => {
      requestSubmittedPromptScrollToBottom();
      submitGuidancePrompt(...args);
    }
  );

  return {
    acceptPendingPlan,
    cancelPendingPlan,
    handlePlanAssignmentDraftChange,
    pendingPlanPanel,
    pendingPlanSubmitting,
    planAssignmentDrafts,
    planReviewIntensityDiverged,
    planReviewSendActive,
    setTuttiModeActiveAndSettleReview,
    submitGuidancePromptAndScrollToBottom,
    submitPromptOrDecidePlan,
    tuttiModePlanPanels
  };
}
