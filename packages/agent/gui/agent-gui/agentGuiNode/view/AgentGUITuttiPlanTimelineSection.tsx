import { Button } from "@tutti-os/ui-system/components";
import {
  TuttiModePlanPanel,
  TuttiPlanIssuePanel
} from "../../../workspaceWorkflow";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import type { AgentGUITuttiPlanReview } from "./useAgentGUITuttiPlanReview";

/**
 * The Tutti plan segment of the conversation timeline: pending review cards,
 * the embedded panel of the materialized plan Issue, and the load-error card.
 */
export function AgentGUITuttiPlanTimelineSection({
  labels,
  review,
  onOpenIssue
}: {
  labels: AgentGUIViewLabels;
  review: AgentGUITuttiPlanReview;
  onOpenIssue: (() => void) | undefined;
}): React.JSX.Element {
  const panels = review.tuttiModePlanPanels;
  return (
    <>
      {panels.panels.map((panel) => (
        <TuttiModePlanPanel
          key={panel.id}
          assignmentCatalog={panels.assignmentCatalog}
          assignmentDrafts={review.planAssignmentDrafts[panel.id] ?? {}}
          labels={labels.tuttiModePlanPanel}
          panel={panel}
          submitting={panels.submittingCheckpointId === panel.checkpoint.id}
          onAssignmentDraftChange={(taskId, patch) =>
            review.handlePlanAssignmentDraftChange(panel.id, taskId, patch)
          }
        />
      ))}
      {review.planIssue && !review.pendingPlanPanel ? (
        <TuttiPlanIssuePanel
          issue={review.planIssue}
          labels={labels.tuttiModePlanIssuePanel}
          onOpenIssue={onOpenIssue}
          onDecideTask={
            review.planIssueDecideAvailable
              ? review.decidePlanIssueTask
              : undefined
          }
          onCancelExecution={
            review.planIssueCancelAvailable
              ? review.cancelPlanIssueExecution
              : undefined
          }
        />
      ) : null}
      {panels.error ? (
        <div
          className="mx-auto flex w-full max-w-[860px] items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
          role="alert"
        >
          <span>{labels.tuttiModePlanLoadFailed}</span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={panels.retry}
          >
            {labels.tuttiModePlanRetry}
          </Button>
        </div>
      ) : null}
    </>
  );
}
