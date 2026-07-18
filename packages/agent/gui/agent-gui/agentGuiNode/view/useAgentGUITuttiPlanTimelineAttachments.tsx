import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type {
  AgentTranscriptAttachmentLocator,
  AgentTranscriptTurnAttachment
} from "../../../shared/agentConversation/components/AgentTranscriptView";
import {
  AgentGUITuttiPlanIssueAttachment,
  AgentGUITuttiPlanIssueCreateFailedAttachment,
  AgentGUITuttiPlanLoadErrorAttachment,
  AgentGUITuttiPlanPanelAttachment
} from "./AgentGUITuttiPlanTimelineSection";
import {
  useAgentGUITuttiPlanReview,
  type AgentGUITuttiPlanReview
} from "./useAgentGUITuttiPlanReview";

type ReviewInput = Omit<
  Parameters<typeof useAgentGUITuttiPlanReview>[0],
  "timelineAttachmentLocatorRef"
>;

export function useAgentGUITuttiPlanTimelineAttachments(input: ReviewInput): {
  dockIssueStatus: AgentGUITuttiPlanReview["tuttiPlanIssueStatus"];
  locatorRef: RefObject<AgentTranscriptAttachmentLocator | null>;
  onVisibilityChange: (attachmentId: string, visible: boolean) => void;
  review: AgentGUITuttiPlanReview;
  turnAttachments: readonly AgentTranscriptTurnAttachment[];
} {
  const locatorRef = useRef<AgentTranscriptAttachmentLocator | null>(null);
  const [visibleAttachmentIds, setVisibleAttachmentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const onVisibilityChange = useCallback(
    (attachmentId: string, visible: boolean): void => {
      setVisibleAttachmentIds((current) => {
        if (current.has(attachmentId) === visible) return current;
        const next = new Set(current);
        if (visible) next.add(attachmentId);
        else next.delete(attachmentId);
        return next;
      });
    },
    []
  );
  const review = useAgentGUITuttiPlanReview({
    ...input,
    timelineAttachmentLocatorRef: locatorRef
  });
  const turnAttachments = useMemo<
    readonly AgentTranscriptTurnAttachment[]
  >(() => {
    const attachments: AgentTranscriptTurnAttachment[] =
      review.tuttiModePlanPanels.panels.map((panel) => ({
        id: `workflow:${panel.workflowId}`,
        anchorTurnId: panel.sourceTurnId,
        content: (
          <AgentGUITuttiPlanPanelAttachment
            labels={input.labels}
            review={review}
            panel={panel}
          />
        )
      }));
    if (review.planIssue && !review.pendingPlanPanel) {
      attachments.push({
        id: `workflow:${review.planIssue.workflowId}`,
        anchorTurnId: review.planIssue.sourceTurnId,
        content: (
          <AgentGUITuttiPlanIssueAttachment
            labels={input.labels}
            review={review}
            onOpenIssue={
              input.stableLinkAction ? review.openPlanIssue : undefined
            }
          />
        )
      });
    }
    const materializationFailure =
      review.tuttiModePlanPanels.planIssueMaterializationFailure;
    if (
      materializationFailure &&
      // A pending review panel of the same workflow supersedes the failure
      // card (a revise is already underway) and would collide on the
      // workflow:<id> identity.
      !review.tuttiModePlanPanels.panels.some(
        (panel) => panel.workflowId === materializationFailure.workflowId
      )
    ) {
      attachments.push({
        id: `workflow:${materializationFailure.workflowId}`,
        anchorTurnId: materializationFailure.sourceTurnId,
        content: (
          <AgentGUITuttiPlanIssueCreateFailedAttachment
            labels={input.labels}
            errorMessage={materializationFailure.errorMessage}
          />
        )
      });
    }
    if (review.tuttiModePlanPanels.error) {
      attachments.push({
        id: "workflow:load-error",
        anchorTurnId: null,
        content: (
          <AgentGUITuttiPlanLoadErrorAttachment
            labels={input.labels}
            review={review}
          />
        )
      });
    }
    return attachments;
  }, [
    input.labels,
    input.stableLinkAction,
    review.cancelPlanIssueExecution,
    review.decidePlanIssueTask,
    review.handlePlanAssignmentDraftChange,
    review.openPlanIssue,
    review.openPlanIssueTaskSession,
    review.pendingPlanPanel,
    review.planAssignmentDrafts,
    review.planIssue,
    review.planIssueCancelAvailable,
    review.planIssueDecideAvailable,
    review.tuttiModePlanPanels
  ]);
  const issueAttachmentId = review.planIssue
    ? `workflow:${review.planIssue.workflowId}`
    : null;
  // The strip stays up whenever the panel itself is outside the viewport —
  // regardless of task-state mix — because in a long conversation it is the
  // only affordance that leads back to the board without manual scrolling.
  const dockIssueStatus =
    review.tuttiPlanIssueStatus &&
    issueAttachmentId &&
    !visibleAttachmentIds.has(issueAttachmentId)
      ? review.tuttiPlanIssueStatus
      : null;

  return {
    dockIssueStatus,
    locatorRef,
    onVisibilityChange,
    review,
    turnAttachments
  };
}
