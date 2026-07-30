import {
  memo,
  useMemo,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject
} from "react";
import { GitFork } from "lucide-react";
import { ScrollArea } from "@tutti-os/ui-system/components";
import type { AgentActivitySessionForkLineage } from "@tutti-os/agent-activity-core";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import { AgentGUIConversationTimelinePane } from "./AgentGUIConversationTimelinePane";
import styles from "../AgentGUINode.styles";
import type { AgentTranscriptVirtualScrollController } from "../../../shared/agentConversation/components/AgentTranscriptView";
import type { AgentConversationFollowEndMode } from "../../../shared/agentConversation/agentConversationFollowEndController";
import type { AgentTranscriptEditRetryControl } from "../../../shared/agentConversation/components/useAgentTranscriptEditRetryProjection";
import type { AgentActivityEditRetryRecoveryAction } from "@tutti-os/agent-activity-core";
import type { AgentGUIEditRetryPresentation } from "../model/agentGUIEditRetryModel";
import { AgentGUIEditRetryStatus } from "./AgentGUIEditRetryStatus";

const TIMELINE_CONTENT_STYLE: CSSProperties = {
  width: "100%",
  minWidth: "100%",
  minHeight: "100%",
  flexShrink: 0,
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: "24px"
};

interface AgentGUIDetailTimelineProps {
  availableSkills: readonly AgentGUIProviderSkillOption[];
  conversation: AgentConversationVM | null;
  editRetry?: {
    control?: AgentTranscriptEditRetryControl;
    presentation: AgentGUIEditRetryPresentation;
    recover: (action: AgentActivityEditRetryRecoveryAction) => Promise<void>;
  };
  conversationFlowEmpty: React.JSX.Element;
  conversationFlowLabels: {
    thinkingLabel: string;
    toolCallsLabel: (count: number) => string;
    processing: string;
    turnSummary: string;
    userMessageLocator: string;
  };
  hasActiveConversation: boolean;
  followEndMode: AgentConversationFollowEndMode;
  forkedFrom?: AgentActivitySessionForkLineage | null;
  forkThroughTurnPendingTurnIds?: readonly string[];
  homeContent: ReactNode;
  isConversationHistoryComplete?: boolean;
  isLoadingOlderMessages: boolean;
  isVisible: boolean;
  isTimelineScrolledToTop: boolean;
  labels: {
    loadingConversation: string;
    continuedFromTask: string;
  };
  onAuthLogin?: (provider?: string | null) => void;
  onForkThroughTurn?: (turnId: string) => void;
  onOpenForkSourceSession?: (agentSessionId: string) => void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  showTimelineSkeleton: boolean;
  showUnavailableChatEmpty: boolean;
  timelineContentRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  virtualScrollControllerRef: Ref<AgentTranscriptVirtualScrollController>;
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}

export const AgentGUIDetailTimeline = memo(function AgentGUIDetailTimeline({
  availableSkills,
  conversation,
  editRetry,
  conversationFlowEmpty,
  conversationFlowLabels,
  hasActiveConversation,
  followEndMode,
  forkedFrom,
  forkThroughTurnPendingTurnIds,
  homeContent,
  isConversationHistoryComplete = true,
  isLoadingOlderMessages,
  isVisible,
  isTimelineScrolledToTop,
  labels,
  onAuthLogin,
  onForkThroughTurn,
  onOpenForkSourceSession,
  onLinkAction,
  showTimelineSkeleton,
  showUnavailableChatEmpty,
  timelineContentRef,
  timelineRef,
  virtualScrollControllerRef,
  workspaceAppIcons
}: AgentGUIDetailTimelineProps): React.JSX.Element {
  "use memo";
  const forkLineageAttachments = useMemo(
    () =>
      forkedFrom?.targetTurnId
        ? [
            {
              id: `fork-lineage:${forkedFrom.operationId}`,
              anchorTurnId: forkedFrom.targetTurnId,
              missingAnchorBehavior: "hide" as const,
              content: (
                <div
                  className="my-3 flex w-full items-center gap-3 text-[14px] font-medium text-[var(--tutti-purple)]"
                  data-testid="agent-gui-fork-lineage"
                >
                  <span
                    className="h-px min-w-0 flex-1 bg-[var(--line-2,var(--tutti-line-2))]"
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className="flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tutti-purple)]"
                    onClick={() =>
                      onOpenForkSourceSession?.(forkedFrom.sourceAgentSessionId)
                    }
                  >
                    <GitFork width={16} height={16} aria-hidden="true" />
                    {labels.continuedFromTask}
                  </button>
                  <span
                    className="h-px min-w-0 flex-1 bg-[var(--line-2,var(--tutti-line-2))]"
                    aria-hidden="true"
                  />
                </div>
              )
            }
          ]
        : [],
    [
      forkedFrom?.operationId,
      forkedFrom?.sourceAgentSessionId,
      forkedFrom?.targetTurnId,
      labels.continuedFromTask,
      onOpenForkSourceSession
    ]
  );
  return (
    <ScrollArea
      scrollbarMode="native"
      className="flex h-full min-h-0 flex-1 flex-col [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100"
      viewportRef={timelineRef}
      viewportProps={{ tabIndex: 0 }}
      viewportContentRef={timelineContentRef}
      viewportTestId="agent-gui-timeline"
      viewportClassName={`${styles.timeline} ${
        hasActiveConversation
          ? `${styles.timelineWithComposer} ${styles.timelineBottomOrigin}`
          : styles.timelineCentered
      } ${
        !isTimelineScrolledToTop ? styles.timelineScrolledFromTop : ""
      } ${showUnavailableChatEmpty ? styles.timelineUnavailableChatEmpty : ""}`.trim()}
      viewportContentStyle={TIMELINE_CONTENT_STYLE}
    >
      {hasActiveConversation ? (
        <>
          <AgentGUIConversationTimelinePane
            conversation={conversation}
            turnAttachments={forkLineageAttachments}
            isConversationHistoryComplete={isConversationHistoryComplete}
            editRetry={editRetry?.control}
            followEndMode={followEndMode}
            isLoading={showTimelineSkeleton}
            isLoadingOlderMessages={isLoadingOlderMessages}
            isVisible={isVisible}
            loadingLabel={labels.loadingConversation}
            empty={conversationFlowEmpty}
            onLinkAction={onLinkAction}
            onAuthLogin={onAuthLogin}
            onForkThroughTurn={onForkThroughTurn}
            forkThroughTurnPendingTurnIds={forkThroughTurnPendingTurnIds}
            availableSkills={availableSkills}
            workspaceAppIcons={workspaceAppIcons}
            labels={conversationFlowLabels}
            virtualScrollControllerRef={virtualScrollControllerRef}
          />
          {editRetry ? (
            <AgentGUIEditRetryStatus
              presentation={editRetry.presentation}
              onRecover={editRetry.recover}
            />
          ) : null}
        </>
      ) : (
        homeContent
      )}
    </ScrollArea>
  );
});
