import { useRef, useState } from "react";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import {
  mergeTaskAssignmentDraft,
  taskAssignmentInputsFromDrafts,
  tuttiModePlanTaskActionPrompt,
  tuttiPlanIssueExecutionIsActive,
  useTuttiModePlanPanels,
  type TuttiModePlanAssignmentCatalog,
  type TuttiModePlanTaskAssignmentDraft,
  type TuttiModePlanTaskAssignmentDrafts,
  type TuttiPlanIssueTaskAction
} from "../../../workspaceWorkflow";
import {
  agentComposerDraftHasContent,
  agentPromptContentDisplayText,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import { appendAgentGUIComposerPrompt } from "../controller/useAgentGUIComposerAppendRequest";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import { useStableEventCallback } from "./agentGUIViewUtils";
import type { TuttiWorkflowDockPhase } from "../TuttiWorkflowDock";

export interface AgentGUITuttiWorkflowComposerController {
  planReviewSendActive: boolean;
  tuttiExecutionActive: boolean;
  tuttiExecutionStopping: boolean;
  planReviewDraftHasContent: boolean;
  planReviewPreferencesDiverged: boolean;
  acceptPendingPlan: () => void;
  requestPendingPlanChanges: () => void;
  setTuttiModeActiveAndSettleReview: (active: boolean) => void;
  stopTuttiExecution: () => Promise<void>;
  submitPromptOrDecidePlan: (
    ...args: Parameters<AgentGUINodeViewProps["actions"]["submitPrompt"]>
  ) => void;
}

export interface AgentGUITuttiWorkflowDockController {
  assignmentCatalog: TuttiModePlanAssignmentCatalog;
  assignmentDrafts: TuttiModePlanTaskAssignmentDrafts;
  cancelReview: () => void;
  changeEffect: (value: number) => void;
  changeSpeed: (value: number) => void;
  taskAction?: (
    taskId: string,
    action: TuttiPlanIssueTaskAction
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
  workflowId: string;
}

/**
 * Everything the detail pane needs for the Tutti plan review flow and the
 * materialized plan Issue embed: composer-integrated review decisions (empty
 * send accepts, typed send requests changes, and a proven preference change
 * exposes an additional request-changes action),
 * per-task assignment drafts, the embedded issue panel data plus its inline
 * acceptance decisions, and the single bottom-dock workflow projection.
 */
export function useAgentGUITuttiWorkflow(input: {
  viewModel: AgentGUINodeViewModel;
  labels: AgentGUIViewLabels;
  stableLinkAction: ((action: WorkspaceLinkAction) => void) | undefined;
  setTuttiModeActive: (active: boolean) => void;
  setTuttiModeEffect: (value: number) => void;
  setTuttiModeSpeed: (value: number) => void;
  updateDraftContent: AgentGUINodeViewProps["actions"]["updateDraftContent"];
  submitPromptPassthrough: (
    ...args: Parameters<AgentGUINodeViewProps["actions"]["submitPrompt"]>
  ) => void;
}): AgentGUITuttiWorkflowController {
  const {
    viewModel,
    labels,
    stableLinkAction,
    setTuttiModeActive,
    setTuttiModeEffect,
    setTuttiModeSpeed,
    updateDraftContent,
    submitPromptPassthrough
  } = input;
  const tuttiModePlanPanels = useTuttiModePlanPanels({
    enabled: true,
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
  const [stoppingIssueId, setStoppingIssueId] = useState<string | null>(null);
  const stoppingIssueIdRef = useRef<string | null>(null);
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
  const planReviewDraftHasContent = agentComposerDraftHasContent(
    viewModel.composer.draftContent
  );
  // A preference change is real only when the reviewed document carries both
  // explicit frozen values. Legacy documents without that pair remain
  // acceptable, but the UI must not invent a comparison from unrelated fields.
  const pendingPlanEffect = pendingPlanPanel?.execution.effect;
  const pendingPlanSpeed = pendingPlanPanel?.execution.speed;
  const pendingPlanHasPreferenceSnapshot =
    typeof pendingPlanEffect === "number" &&
    typeof pendingPlanSpeed === "number";
  const planReviewPreferencesDiverged =
    pendingPlanPanel !== null &&
    pendingPlanHasPreferenceSnapshot &&
    (viewModel.composer.tuttiModeEffect !== pendingPlanEffect ||
      viewModel.composer.tuttiModeSpeed !== pendingPlanSpeed);
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
    if (pendingPlanPanel && viewModel.rail.activeConversationId) {
      setMaterializingPlan({
        checkpointId: pendingPlanPanel.checkpoint.id,
        sourceSessionId: viewModel.rail.activeConversationId,
        title: pendingPlanPanel.title,
        workflowId: pendingPlanPanel.workflowId
      });
    }
    decidePendingPlan("accepted");
  });
  const replanPendingPlanWithCurrentPreferences = useStableEventCallback(
    (): void => {
      if (!pendingPlanPanel || !pendingPlanHasPreferenceSnapshot) return;
      decidePendingPlan(
        "rejected",
        labels.tuttiModePlanReplanFeedback(
          String(pendingPlanEffect),
          String(pendingPlanSpeed),
          String(viewModel.composer.tuttiModeEffect),
          String(viewModel.composer.tuttiModeSpeed)
        )
      );
    }
  );
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
  // it to the agent), while an empty send always accepts the exact visible
  // checkpoint. Normal sends resume once the checkpoint settles.
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
          if (planReviewPreferencesDiverged) {
            feedback += labels.tuttiModePlanReplanFeedbackSuffix(
              String(viewModel.composer.tuttiModeEffect),
              String(viewModel.composer.tuttiModeSpeed)
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
  // Embedded issue panel actions are source-Agent instructions. They append a
  // draft for user review instead of impersonating Agent CLI authority or
  // mutating the managed Issue through a generic Task endpoint.
  const planIssue = tuttiModePlanPanels.planIssue;
  const tuttiExecutionActive = tuttiPlanIssueExecutionIsActive(planIssue);
  const preparePlanIssueTaskPrompt = useStableEventCallback(
    (taskId: string, action: TuttiPlanIssueTaskAction): Promise<void> => {
      if (!planIssue) {
        return Promise.resolve();
      }
      const prompt = tuttiModePlanTaskActionPrompt({
        action,
        issue: planIssue,
        labels: {
          accept: labels.tuttiModePlanIssueAcceptPrompt,
          rework: labels.tuttiModePlanIssueReworkPrompt
        },
        taskId,
        workspaceId: viewModel.shell.workspaceId
      });
      if (!prompt) {
        return Promise.resolve();
      }
      updateDraftContent(
        appendAgentGUIComposerPrompt(viewModel.composer.draftContent, prompt)
      );
      return Promise.resolve();
    }
  );
  const cancelPlanIssueExecution = useStableEventCallback(
    async (): Promise<void> => {
      const issueId = planIssue?.issueId ?? "";
      if (
        !tuttiExecutionActive ||
        !issueId ||
        stoppingIssueIdRef.current === issueId ||
        !tuttiModePlanPanels.cancelPlanIssueExecution
      ) {
        return;
      }
      stoppingIssueIdRef.current = issueId;
      setStoppingIssueId(issueId);
      try {
        await tuttiModePlanPanels.cancelPlanIssueExecution();
      } finally {
        if (stoppingIssueIdRef.current === issueId) {
          stoppingIssueIdRef.current = null;
        }
        setStoppingIssueId((current) => (current === issueId ? null : current));
      }
    }
  );
  const tuttiExecutionStopping =
    tuttiExecutionActive && stoppingIssueId === planIssue?.issueId;
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
  const materializingWorkflowSettled =
    materializingCurrentSession &&
    materializingPlan !== null &&
    ((planIssue !== null &&
      planIssue.workflowId === materializingPlan.workflowId) ||
      (materializationFailure !== null &&
        materializationFailure.workflowId === materializingPlan.workflowId) ||
      (pendingPlanPanel !== null &&
        pendingPlanPanel.checkpoint.id !== materializingPlan.checkpointId) ||
      (tuttiModePlanPanels.error !== null && !pendingPlanSubmitting));
  // This is a conditional same-component state adjustment: React restarts the
  // render before commit, so a terminal read-model observation cannot expose a
  // stale materializing phase for one frame or survive a later Session switch.
  if (materializingWorkflowSettled) {
    setMaterializingPlan(null);
  }
  // The bottom workflow dock mirrors the live Tutti Mode toggle. Turning the
  // mode off hides the banner immediately, even while a materialized Issue, a
  // pending checkpoint, or an in-flight materialization still exists in the
  // daemon: only project a dock phase while the mode is active.
  const tuttiModeActive = viewModel.composer.isTuttiModeActive;
  let workflowDockPhase: TuttiWorkflowDockPhase | null = null;
  if (tuttiModeActive) {
    if (
      pendingPlanPanel &&
      (!materializingCurrentCheckpoint ||
        (tuttiModePlanPanels.error !== null && !pendingPlanSubmitting))
    ) {
      workflowDockPhase = {
        kind: "review",
        panel: pendingPlanPanel,
        submitting: pendingPlanSubmitting,
        effect: viewModel.composer.tuttiModeEffect,
        speed: viewModel.composer.tuttiModeSpeed,
        preferencesDiverged: planReviewPreferencesDiverged
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
        effect: viewModel.composer.tuttiModeEffect,
        speed: viewModel.composer.tuttiModeSpeed,
        preferencesDiverged: planReviewPreferencesDiverged
      };
    }
  }
  return {
    composer: {
      acceptPendingPlan,
      planReviewDraftHasContent,
      planReviewPreferencesDiverged,
      planReviewSendActive,
      requestPendingPlanChanges: replanPendingPlanWithCurrentPreferences,
      setTuttiModeActiveAndSettleReview,
      stopTuttiExecution: cancelPlanIssueExecution,
      tuttiExecutionActive,
      tuttiExecutionStopping,
      submitPromptOrDecidePlan
    },
    workflowDock: {
      assignmentCatalog: tuttiModePlanPanels.assignmentCatalog,
      assignmentDrafts:
        workflowDockPhase?.kind === "review"
          ? (planAssignmentDrafts[workflowDockPhase.panel.id] ?? {})
          : {},
      cancelReview: cancelPendingPlan,
      changeEffect: setTuttiModeEffect,
      changeSpeed: setTuttiModeSpeed,
      taskAction: planIssue ? preparePlanIssueTaskPrompt : undefined,
      openIssue: stableLinkAction ? openPlanIssue : undefined,
      openTask: stableLinkAction ? openPlanIssueTaskSession : undefined,
      phase: workflowDockPhase,
      retry: tuttiModePlanPanels.retry,
      updateAssignment: updateWorkflowAssignment
    }
  };
}
