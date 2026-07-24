import {
  memo,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from "react";
import { ScrollArea } from "@tutti-os/ui-system/components";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import { AgentGUIConversationTimelinePane } from "./AgentGUIConversationTimelinePane";
import styles from "../AgentGUINode.styles";

const TIMELINE_CONTENT_STYLE: CSSProperties = {
  width: "100%",
  minWidth: "100%",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: "24px"
};

interface AgentGUIDetailTimelineProps {
  availableSkills: readonly AgentGUIProviderSkillOption[];
  conversation: AgentConversationVM | null;
  conversationFlowEmpty: React.JSX.Element;
  conversationFlowLabels: {
    thinkingLabel: string;
    toolCallsLabel: (count: number) => string;
    processing: string;
    turnSummary: string;
    userMessageLocator: string;
  };
  hasActiveConversation: boolean;
  homeContent: ReactNode;
  isLoadingOlderMessages: boolean;
  isTimelineScrolledToTop: boolean;
  labels: {
    loadingConversation: string;
  };
  onAuthLogin?: (provider?: string | null) => void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  showTimelineSkeleton: boolean;
  showUnavailableChatEmpty: boolean;
  timelineContentRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}

export const AgentGUIDetailTimeline = memo(function AgentGUIDetailTimeline({
  availableSkills,
  conversation,
  conversationFlowEmpty,
  conversationFlowLabels,
  hasActiveConversation,
  homeContent,
  isLoadingOlderMessages,
  isTimelineScrolledToTop,
  labels,
  onAuthLogin,
  onLinkAction,
  showTimelineSkeleton,
  showUnavailableChatEmpty,
  timelineContentRef,
  timelineRef,
  workspaceAppIcons
}: AgentGUIDetailTimelineProps): React.JSX.Element {
  "use memo";
  return (
    <ScrollArea
      scrollbarMode="native"
      className="flex h-full min-h-0 flex-1 flex-col [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100"
      viewportRef={timelineRef}
      viewportContentRef={timelineContentRef}
      viewportTestId="agent-gui-timeline"
      viewportClassName={`${styles.timeline} ${
        hasActiveConversation
          ? styles.timelineWithComposer
          : styles.timelineCentered
      } ${
        !isTimelineScrolledToTop ? styles.timelineScrolledFromTop : ""
      } ${showUnavailableChatEmpty ? styles.timelineUnavailableChatEmpty : ""}`.trim()}
      viewportContentStyle={TIMELINE_CONTENT_STYLE}
    >
      {hasActiveConversation ? (
        <AgentGUIConversationTimelinePane
          conversation={conversation}
          isLoading={showTimelineSkeleton}
          isLoadingOlderMessages={isLoadingOlderMessages}
          loadingLabel={labels.loadingConversation}
          empty={conversationFlowEmpty}
          onLinkAction={onLinkAction}
          onAuthLogin={onAuthLogin}
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
          labels={conversationFlowLabels}
        />
      ) : (
        homeContent
      )}
    </ScrollArea>
  );
});
