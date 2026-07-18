import { Button } from "@tutti-os/ui-system/components";
import {
  TuttiModePlanPanel,
  TuttiPlanIssuePanel
} from "../../../workspaceWorkflow";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import type { AgentGUITuttiPlanReview } from "./useAgentGUITuttiPlanReview";
import type { TuttiModePlanPanelViewModel } from "../../../workspaceWorkflow";

export function AgentGUITuttiPlanPanelAttachment({
  labels,
  review,
  panel
}: {
  labels: AgentGUIViewLabels;
  review: AgentGUITuttiPlanReview;
  panel: TuttiModePlanPanelViewModel;
}): React.JSX.Element {
  const panels = review.tuttiModePlanPanels;
  return (
    <TuttiModePlanPanel
      assignmentCatalog={panels.assignmentCatalog}
      assignmentDrafts={review.planAssignmentDrafts[panel.id] ?? {}}
      labels={labels.tuttiModePlanPanel}
      panel={panel}
      submitting={panels.submittingCheckpointId === panel.checkpoint.id}
      onAssignmentDraftChange={(taskId, patch) =>
        review.handlePlanAssignmentDraftChange(panel.id, taskId, patch)
      }
    />
  );
}

export function AgentGUITuttiPlanIssueAttachment({
  labels,
  review,
  onOpenIssue
}: {
  labels: AgentGUIViewLabels;
  review: AgentGUITuttiPlanReview;
  onOpenIssue: (() => void) | undefined;
}): React.JSX.Element | null {
  if (!review.planIssue) return null;
  return (
    <TuttiPlanIssuePanel
      issue={review.planIssue}
      labels={labels.tuttiModePlanIssuePanel}
      onOpenIssue={onOpenIssue}
      onDecideTask={
        review.planIssueDecideAvailable ? review.decidePlanIssueTask : undefined
      }
      onCancelExecution={
        review.planIssueCancelAvailable
          ? review.cancelPlanIssueExecution
          : undefined
      }
      onOpenTask={review.openPlanIssueTaskSession}
    />
  );
}

/**
 * An accepted plan whose create_issue operation durably failed: there is no
 * pending checkpoint and no Issue, so without this card the conversation
 * would render nothing at all for the plan.
 */
export function AgentGUITuttiPlanIssueCreateFailedAttachment({
  labels,
  errorMessage
}: {
  labels: AgentGUIViewLabels;
  errorMessage: string | null;
}): React.JSX.Element {
  return (
    <div
      className="mx-auto flex w-full max-w-[860px] items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)] bg-card px-4 py-3 text-sm text-muted-foreground"
      role="alert"
      data-testid="tutti-plan-issue-create-failed"
    >
      <span>
        {labels.tuttiModePlanIssueCreateFailed(
          errorMessage ?? labels.tuttiModePlanLoadFailed
        )}
      </span>
    </div>
  );
}

export function AgentGUITuttiPlanLoadErrorAttachment({
  labels,
  review
}: {
  labels: AgentGUIViewLabels;
  review: AgentGUITuttiPlanReview;
}): React.JSX.Element {
  return (
    <div
      className="mx-auto flex w-full max-w-[860px] items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
      role="alert"
    >
      <span>{labels.tuttiModePlanLoadFailed}</span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={review.tuttiModePlanPanels.retry}
      >
        {labels.tuttiModePlanRetry}
      </Button>
    </div>
  );
}
