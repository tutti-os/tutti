import { useState, type RefObject } from "react";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import {
  mergeTaskAssignmentDraft,
  taskAssignmentInputsFromDrafts,
  useTuttiModePlanPanels,
  type TuttiModePlanPanelViewModel,
  type TuttiModePlanTaskAssignmentDraft,
  type TuttiModePlanTaskAssignmentDrafts,
  type TuttiPlanIssueSnapshot,
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
import type { TuttiPlanIssueStatusStripCounts } from "../TuttiPlanIssueStatusStrip";
import { useStableEventCallback } from "./agentGUIViewUtils";
import type { AgentTranscriptAttachmentLocator } from "../../../shared/agentConversation/components/AgentTranscriptView";

export interface AgentGUITuttiPlanReview {
  tuttiModePlanPanels: ReturnType<typeof useTuttiModePlanPanels>;
  planAssignmentDrafts: Readonly<
    Record<string, TuttiModePlanTaskAssignmentDrafts>
  >;
  handlePlanAssignmentDraftChange: (
    panelId: string,
    taskId: string,
    patch: TuttiModePlanTaskAssignmentDraft
  ) => void;
  pendingPlanPanel: TuttiModePlanPanelViewModel | null;
  pendingPlanSubmitting: boolean;
  planReviewSendActive: boolean;
  planReviewIntensityDiverged: boolean;
  acceptPendingPlan: () => void;
  cancelPendingPlan: () => void;
  setTuttiModeActiveAndSettleReview: (active: boolean) => void;
  submitPromptOrDecidePlan: (
    ...args: Parameters<AgentGUINodeViewProps["actions"]["submitPrompt"]>
  ) => void;
  planIssue: TuttiPlanIssueSnapshot | null;
  planIssueDecideAvailable: boolean;
  decidePlanIssueTask: (
    taskId: string,
    decision: TuttiPlanIssueTaskDecision
  ) => Promise<void>;
  planIssueCancelAvailable: boolean;
  cancelPlanIssueExecution: () => Promise<void>;
  openPlanIssueTaskSession: (taskId: string) => Promise<void>;
  openPlanIssue: () => void;
  jumpToPlanIssuePanel: () => void;
  tuttiPlanReview: {
    planTitle: string;
    submitting: boolean;
    intensity: number;
    intensityDiverged: boolean;
  } | null;
  tuttiPlanIssueStatus:
    | (TuttiPlanIssueStatusStripCounts & { title: string })
    | null;
}

function countTasksWithStatus(
  issue: TuttiPlanIssueSnapshot,
  status: string
): number {
  return issue.tasks.filter((task) => task.status === status).length;
}

/**
 * Everything the detail pane needs for the Tutti plan review flow and the
 * materialized plan Issue embed: composer-integrated review decisions (empty
 * send accepts, typed send requests changes, intensity divergence re-plans),
 * per-task assignment drafts, the embedded issue panel data plus its inline
 * acceptance decisions, and the bottom-dock banner/status-strip inputs.
 */
export function useAgentGUITuttiPlanReview(input: {
  viewModel: AgentGUINodeViewModel;
  previewMode: boolean;
  labels: AgentGUIViewLabels;
  timelineAttachmentLocatorRef: RefObject<AgentTranscriptAttachmentLocator | null>;
  stableLinkAction: ((action: WorkspaceLinkAction) => void) | undefined;
  setTuttiModeActive: (active: boolean) => void;
  updateDraftContent: AgentGUINodeViewProps["actions"]["updateDraftContent"];
  submitPromptPassthrough: (
    ...args: Parameters<AgentGUINodeViewProps["actions"]["submitPrompt"]>
  ) => void;
}): AgentGUITuttiPlanReview {
  const {
    viewModel,
    previewMode,
    labels,
    timelineAttachmentLocatorRef,
    stableLinkAction,
    setTuttiModeActive,
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
  const jumpToPlanIssuePanel = useStableEventCallback((): void => {
    if (!planIssue) return;
    timelineAttachmentLocatorRef.current?.(`workflow:${planIssue.workflowId}`);
  });
  return {
    tuttiModePlanPanels,
    planAssignmentDrafts,
    handlePlanAssignmentDraftChange,
    pendingPlanPanel,
    pendingPlanSubmitting,
    planReviewSendActive,
    planReviewIntensityDiverged,
    acceptPendingPlan,
    cancelPendingPlan,
    setTuttiModeActiveAndSettleReview,
    submitPromptOrDecidePlan,
    planIssue,
    planIssueDecideAvailable: tuttiModePlanPanels.decidePlanIssueTask !== null,
    decidePlanIssueTask,
    planIssueCancelAvailable:
      tuttiModePlanPanels.cancelPlanIssueExecution !== null,
    cancelPlanIssueExecution,
    openPlanIssueTaskSession,
    openPlanIssue,
    jumpToPlanIssuePanel,
    tuttiPlanReview: pendingPlanPanel
      ? {
          planTitle: pendingPlanPanel.title,
          submitting: pendingPlanSubmitting,
          intensity: viewModel.composer.tuttiModeOrchestrationIntensity,
          intensityDiverged: planReviewIntensityDiverged
        }
      : null,
    tuttiPlanIssueStatus:
      planIssue && !pendingPlanPanel
        ? {
            title: planIssue.title,
            running: countTasksWithStatus(planIssue, "running"),
            pendingAcceptance: countTasksWithStatus(
              planIssue,
              "pending_acceptance"
            ),
            failed: countTasksWithStatus(planIssue, "failed"),
            done: countTasksWithStatus(planIssue, "completed"),
            total: planIssue.tasks.length
          }
        : null
  };
}
