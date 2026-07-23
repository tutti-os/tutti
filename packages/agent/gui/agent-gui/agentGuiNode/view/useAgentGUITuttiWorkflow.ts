import { useState } from "react";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import {
  mergeTaskAssignmentDraft,
  taskAssignmentInputsFromDrafts,
  useTuttiModePlanPanels,
  type TuttiModePlanAssignmentCatalog,
  type TuttiModePlanTaskAssignmentDraft,
  type TuttiModePlanTaskAssignmentDrafts,
  type TuttiPlanIssueTaskDecision
} from "../../../workspaceWorkflow";
import {
  agentPromptContentDisplayText,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import { useStableEventCallback } from "./agentGUIViewUtils";
import type { TuttiWorkflowDockPhase } from "../TuttiWorkflowDock";

export interface AgentGUITuttiWorkflowComposerController {
  planReviewSendActive: boolean;
  planReviewIntensityDiverged: boolean;
  acceptPendingPlan: () => void;
  setTuttiModeActiveAndSettleReview: (active: boolean) => void;
  submitPromptOrDecidePlan: (
    ...args: Parameters<AgentGUINodeViewProps["actions"]["submitPrompt"]>
  ) => void;
}

export interface AgentGUITuttiWorkflowDockController {
  assignmentCatalog: TuttiModePlanAssignmentCatalog;
  assignmentDrafts: TuttiModePlanTaskAssignmentDrafts;
  cancelExecution?: () => Promise<void>;
  cancelReview: () => void;
  changeIntensity: (value: number) => void;
  decideTask?: (
    taskId: string,
    decision: TuttiPlanIssueTaskDecision
  ) => Promise<void>;
  openIssue?: () => void;
  openTask?: (taskId: string) => Promise<void>;
  phase: TuttiWorkflowDockPhase | null;
  retry: () => void;
  updateAssignment: (
    taskId: string,
    patch: TuttiModePlanTaskAssignmentDraft
  ) => void;
}

export interface AgentGUITuttiWorkflowController {
  composer: AgentGUITuttiWorkflowComposerController;
  workflowDock: AgentGUITuttiWorkflowDockController;
}

interface MaterializingPlan {
  checkpointId: string;
  sourceSessionId: string;
  title: string;
}

/**
 * Everything the detail pane needs for the Tutti plan review flow and the
 * materialized plan Issue embed: composer-integrated review decisions (empty
 * send accepts, typed send requests changes, intensity divergence re-plans),
 * per-task assignment drafts, the embedded issue panel data plus its inline
 * acceptance decisions, and the single bottom-dock workflow projection.
 */
export function useAgentGUITuttiWorkflow(input: {
  viewModel: AgentGUINodeViewModel;
  previewMode: boolean;
  labels: AgentGUIViewLabels;
  stableLinkAction: ((action: WorkspaceLinkAction) => void) | undefined;
  setTuttiModeActive: (active: boolean) => void;
  setTuttiModeOrchestrationIntensity: (value: number) => void;
  updateDraftContent: AgentGUINodeViewProps["actions"]["updateDraftContent"];
  submitPromptPassthrough: (
    ...args: Parameters<AgentGUINodeViewProps["actions"]["submitPrompt"]>
  ) => void;
}): AgentGUITuttiWorkflowController {
  const {
    viewModel,
    previewMode,
    labels,
    stableLinkAction,
    setTuttiModeActive,
    setTuttiModeOrchestrationIntensity,
    updateDraftContent,
    submitPromptPassthrough
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
  // Acceptance removes the pending checkpoint before the Issue read model may
  // arrive. Keep only the minimum UI-local descriptor needed to preserve the
  // Dock shell through that handoff; accepted plan content remains daemon-owned.
  const [materializingPlan, setMaterializingPlan] =
    useState<MaterializingPlan | null>(null);
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
  const updateWorkflowAssignment = useStableEventCallback(
    (taskId: string, patch: TuttiModePlanTaskAssignmentDraft): void => {
      if (!pendingPlanPanel) return;
      handlePlanAssignmentDraftChange(pendingPlanPanel.id, taskId, patch);
    }
  );
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
      if (decision !== "accepted") {
        setMaterializingPlan(null);
      }
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
    if (pendingPlanPanel && viewModel.rail.activeConversationId) {
      setMaterializingPlan({
        checkpointId: pendingPlanPanel.checkpoint.id,
        sourceSessionId: viewModel.rail.activeConversationId,
        title: pendingPlanPanel.title
      });
    }
    decidePendingPlan("accepted");
  });
  const cancelPendingPlan = useStableEventCallback((): void => {
    decidePendingPlan("canceled");
  });
  // Turning Tutti mode off with a review still pending also cancels the
  // checkpoint: the banner and composer decision semantics clear with it, and
  // the agent continues naturally on the next message without plan context.
  const setTuttiModeActiveAndSettleReview = useStableEventCallback(
    (active: boolean): void => {
      if (!active) {
        setMaterializingPlan(null);
        decidePendingPlan("canceled");
      }
      setTuttiModeActive(active);
    }
  );
  // While a plan review is pending the composer doubles as the decision
  // surface: typed text becomes request-changes feedback (the daemon relays
  // it to the agent), an empty send accepts. Normal sends resume once the
  // checkpoint settles.
  const submitPromptOrDecidePlan = useStableEventCallback(
    (
      ...args: Parameters<AgentGUINodeViewProps["actions"]["submitPrompt"]>
    ): void => {
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
      submitPromptPassthrough(...args);
    }
  );
  // Embedded issue panel view for the materialized plan issue; the acceptance
  // gate (accept / rework on pending tasks) settles inline here.
  const planIssue = tuttiModePlanPanels.planIssue;
  const decidePlanIssueTask = useStableEventCallback(
    (taskId: string, decision: TuttiPlanIssueTaskDecision): Promise<void> =>
      tuttiModePlanPanels.decidePlanIssueTask
        ? tuttiModePlanPanels.decidePlanIssueTask(taskId, decision)
        : Promise.resolve()
  );
  const cancelPlanIssueExecution = useStableEventCallback(
    (): Promise<void> =>
      tuttiModePlanPanels.cancelPlanIssueExecution
        ? tuttiModePlanPanels.cancelPlanIssueExecution()
        : Promise.resolve()
  );
  // Clicking a task card jumps into the delegate conversation that ran it.
  const openPlanIssueTaskSession = useStableEventCallback(
    async (taskId: string): Promise<void> => {
      const resolve = tuttiModePlanPanels.resolvePlanIssueTaskSession;
      if (!resolve || !stableLinkAction) return;
      let target: { agentSessionId: string } | null = null;
      try {
        target = await resolve(taskId);
      } catch {
        return;
      }
      if (!target) return;
      stableLinkAction({
        type: "open-agent-session",
        workspaceId: viewModel.shell.workspaceId,
        agentSessionId: target.agentSessionId,
        source: "tutti-plan-issue-panel"
      });
    }
  );
  const openPlanIssue = useStableEventCallback((): void => {
    if (!planIssue) return;
    stableLinkAction?.({
      type: "open-workspace-issue",
      workspaceId: viewModel.shell.workspaceId,
      issueId: planIssue.issueId,
      topicId: planIssue.topicId || null,
      source: "tutti-plan-issue-panel"
    });
  });
  const materializingCurrentSession =
    materializingPlan !== null &&
    materializingPlan.sourceSessionId === viewModel.rail.activeConversationId;
  const materializingCurrentCheckpoint =
    materializingCurrentSession &&
    pendingPlanPanel?.checkpoint.id === materializingPlan.checkpointId;
  const materializationFailure =
    tuttiModePlanPanels.planIssueMaterializationFailure;
  let workflowDockPhase: TuttiWorkflowDockPhase | null = null;
  if (
    pendingPlanPanel &&
    (!materializingCurrentCheckpoint ||
      (tuttiModePlanPanels.error !== null && !pendingPlanSubmitting))
  ) {
    workflowDockPhase = {
      kind: "review",
      panel: pendingPlanPanel,
      submitting: pendingPlanSubmitting,
      intensity: viewModel.composer.tuttiModeOrchestrationIntensity,
      intensityDiverged: planReviewIntensityDiverged
    };
  } else if (materializationFailure) {
    workflowDockPhase = {
      kind: "error",
      message: labels.tuttiModePlanIssueCreateFailed(
        materializationFailure.errorMessage ?? labels.tuttiModePlanLoadFailed
      ),
      retryable: false
    };
  } else if (planIssue) {
    workflowDockPhase = { kind: "execution", issue: planIssue };
  } else if (materializingCurrentSession && materializingPlan) {
    workflowDockPhase = {
      kind: "materializing",
      title: materializingPlan.title
    };
  } else if (tuttiModePlanPanels.error !== null) {
    workflowDockPhase = {
      kind: "error",
      message: labels.tuttiModePlanLoadFailed,
      retryable: true
    };
  } else if (pendingPlanPanel) {
    workflowDockPhase = {
      kind: "review",
      panel: pendingPlanPanel,
      submitting: pendingPlanSubmitting,
      intensity: viewModel.composer.tuttiModeOrchestrationIntensity,
      intensityDiverged: planReviewIntensityDiverged
    };
  }
  return {
    composer: {
      acceptPendingPlan,
      planReviewIntensityDiverged,
      planReviewSendActive,
      setTuttiModeActiveAndSettleReview,
      submitPromptOrDecidePlan
    },
    workflowDock: {
      assignmentCatalog: tuttiModePlanPanels.assignmentCatalog,
      assignmentDrafts:
        workflowDockPhase?.kind === "review"
          ? (planAssignmentDrafts[workflowDockPhase.panel.id] ?? {})
          : {},
      cancelExecution:
        tuttiModePlanPanels.cancelPlanIssueExecution !== null
          ? cancelPlanIssueExecution
          : undefined,
      cancelReview: cancelPendingPlan,
      changeIntensity: setTuttiModeOrchestrationIntensity,
      decideTask:
        tuttiModePlanPanels.decidePlanIssueTask !== null
          ? decidePlanIssueTask
          : undefined,
      openIssue: stableLinkAction ? openPlanIssue : undefined,
      openTask: stableLinkAction ? openPlanIssueTaskSession : undefined,
      phase: workflowDockPhase,
      retry: tuttiModePlanPanels.retry,
      updateAssignment: updateWorkflowAssignment
    }
  };
}
