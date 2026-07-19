import { useMemo, type JSX } from "react";
import type { WorkspaceLinkAction } from "../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import { translate } from "../i18n/index";
import { AgentConversationFlow } from "./agentConversation/components/AgentConversationFlow";
import { useProjectedAgentConversation } from "./agentConversation/projection/useProjectedAgentConversation";
import type { WorkspaceAgentSessionDetailViewModel } from "./workspaceAgentSessionDetailViewModel";

interface WorkspaceAgentSessionDetailProps {
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
  showRawTimelineJson = false
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
      turnProgressAwaiting: translate(
        "agentHost.agentGui.turnProgressAwaiting"
      ),
      turnProgressStreaming: translate(
        "agentHost.agentGui.turnProgressStreaming"
      ),
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
      turnProgressAwaiting: translate(
        "agentHost.agentGui.turnProgressAwaiting"
      ),
      turnProgressStreaming: translate(
        "agentHost.agentGui.turnProgressStreaming"
      ),
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
