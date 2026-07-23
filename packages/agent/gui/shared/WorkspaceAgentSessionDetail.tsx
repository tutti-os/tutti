import { useMemo, type JSX } from "react";
import type { WorkspaceLinkAction } from "../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import { translate } from "../i18n/index";
import { AgentConversationFlow } from "./agentConversation/components/AgentConversationFlow";
import type { AgentConversationParticipantPresentation } from "./agentConversation/contracts/agentConversationParticipantPresentation";
import { useProjectedAgentConversation } from "./agentConversation/projection/useProjectedAgentConversation";
import type { WorkspaceAgentSessionDetailViewModel } from "./workspaceAgentSessionDetailViewModel";

export interface WorkspaceAgentSessionDetailProps {
  detail: WorkspaceAgentSessionDetailViewModel;
  avoidGroupingEdits?: boolean;
  isLoading: boolean;
  timelineItemCount: number;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  toolCallsLabel: (count: number) => string;
  thinkingLabel?: string;
  loadingLabel?: string;
  rawTimelineJsonLabel?: string;
  showRawTimelineJson?: boolean;
  participantPresentation?: AgentConversationParticipantPresentation;
}

export function WorkspaceAgentSessionDetail({
  detail,
  avoidGroupingEdits = false,
  isLoading,
  timelineItemCount,
  onLinkAction,
  toolCallsLabel,
  thinkingLabel = translate("agentHost.workspaceAgentSessionDetailThinking"),
  loadingLabel = translate("common.loading"),
  rawTimelineJsonLabel,
  showRawTimelineJson = false,
  participantPresentation
}: WorkspaceAgentSessionDetailProps): JSX.Element {
  const conversation = useProjectedAgentConversation({
    detail,
    avoidGroupingEdits
  });
  const showLoadingSkeleton =
    detail.turns.length === 0 &&
    (isLoading ||
      detail.activity.status === "waiting" ||
      detail.activity.status === "working");
  const emptySummary =
    detail.activity.latestActivitySummary ||
    (timelineItemCount > 0
      ? translate("agentHost.workspaceAgentSessionDetailEmptyWithTimeline")
      : translate("agentHost.workspaceAgentSessionDetailEmptyNoTimeline"));
  const flowLabels = useMemo(
    () => ({
      thinkingLabel,
      toolCallsLabel,
      processing: translate("agentHost.agentGui.processing"),
      turnSummary: translate("agentHost.agentGui.turnSummary"),
      rawTimelineJson: rawTimelineJsonLabel
    }),
    [rawTimelineJsonLabel, thinkingLabel, toolCallsLabel]
  );
  const emptyState = useMemo(
    () => (
      <div className="workspace-agents-status-panel__detail-empty">
        {emptySummary}
      </div>
    ),
    [emptySummary]
  );

  return (
    <div className="workspace-agents-status-panel__detail">
      <AgentConversationFlow
        conversation={detail.turns.length > 0 ? conversation : null}
        isLoading={showLoadingSkeleton}
        loadingLabel={loadingLabel}
        empty={emptyState}
        onLinkAction={onLinkAction}
        showRawTimelineJson={showRawTimelineJson}
        participantPresentation={participantPresentation}
        labels={flowLabels}
      />
    </div>
  );
}

export function WorkspaceAgentSessionDetailSkeleton({
  loading = true,
  loadingLabel = translate("common.loading")
}: {
  loading?: boolean;
  loadingLabel?: string;
}): JSX.Element {
  const flowLabels = useMemo(
    () => ({
      thinkingLabel: translate("agentHost.workspaceAgentSessionDetailThinking"),
      toolCallsLabel: (count: number) =>
        translate("agentHost.workspaceAgentSessionDetailToolCalls", { count }),
      processing: translate("agentHost.agentGui.processing"),
      turnSummary: translate("agentHost.agentGui.turnSummary")
    }),
    []
  );

  if (!loading) {
    return <></>;
  }

  return (
    <div
      className="workspace-agents-status-panel__detail-skeleton"
      data-testid="workspace-agents-status-panel-detail-skeleton"
      role="status"
      aria-busy="true"
      aria-label={loadingLabel}
    >
      <AgentConversationFlow
        conversation={null}
        isLoading
        loadingLabel={loadingLabel}
        loadingTestId="workspace-agents-status-panel-detail-skeleton"
        empty={null}
        labels={flowLabels}
      />
    </div>
  );
}
