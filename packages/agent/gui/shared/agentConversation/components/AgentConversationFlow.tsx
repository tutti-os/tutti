import { memo, type ReactNode, type JSX, type Ref } from "react";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentConversationParticipantPresentation } from "../contracts/agentConversationParticipantPresentation";
import type { AgentConversationUnavailableImageRenderer } from "../contracts/agentConversationUnavailableImage";
import type { AgentConversationFollowEndMode } from "../agentConversationFollowEndController";
import { AgentTranscriptSkeleton } from "./AgentTranscriptSkeleton";
import {
  AgentTranscriptView,
  type AgentTranscriptAttachmentLocator,
  type AgentTranscriptTurnAttachment,
  type AgentTranscriptVirtualScrollController
} from "./AgentTranscriptView";
import type { AgentTranscriptEditRetryControl } from "./useAgentTranscriptEditRetryProjection";
import { AgentTurnDisclosureProvider } from "./AgentTurnDisclosureContext";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";

export interface AgentConversationFlowProps {
  conversation: AgentConversationVM | null;
  editRetry?: AgentTranscriptEditRetryControl;
  turnAttachments?: readonly AgentTranscriptTurnAttachment[];
  turnAttachmentLocatorRef?: Ref<AgentTranscriptAttachmentLocator>;
  onTurnAttachmentVisibilityChange?: (
    attachmentId: string,
    visible: boolean
  ) => void;
  isLoading: boolean;
  isVisible?: boolean;
  loadingLabel: string;
  loadingTestId?: string;
  empty: ReactNode;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  onForkThroughTurn?: (turnId: string) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  showRawTimelineJson?: boolean;
  participantPresentation?: AgentConversationParticipantPresentation;
  /** Host-owned presentation for transcript images that cannot be rendered. */
  renderUnavailableImage?: AgentConversationUnavailableImageRenderer;
  followEndMode?: AgentConversationFollowEndMode;
  forkThroughTurnPendingTurnIds?: readonly string[];
  virtualListLayoutRevision?: number;
  virtualScrollControllerRef?: Ref<AgentTranscriptVirtualScrollController>;
  labels: {
    toolCallsLabel: (count: number) => string;
    thinkingLabel: string;
    processing: string;
    turnSummary: string;
    rawTimelineJson?: string;
    userMessageLocator?: string;
  };
}

export const AgentConversationFlow = memo(function AgentConversationFlow({
  conversation,
  editRetry,
  turnAttachments,
  turnAttachmentLocatorRef,
  onTurnAttachmentVisibilityChange,
  isLoading,
  isVisible = true,
  loadingLabel,
  loadingTestId,
  empty,
  onLinkAction,
  onAuthLogin,
  onForkThroughTurn,
  availableSkills,
  workspaceAppIcons,
  showRawTimelineJson = false,
  participantPresentation,
  renderUnavailableImage,
  followEndMode,
  forkThroughTurnPendingTurnIds,
  virtualListLayoutRevision,
  virtualScrollControllerRef,
  labels
}: AgentConversationFlowProps): JSX.Element {
  "use memo";

  let content: JSX.Element;
  if (isLoading) {
    content = (
      <AgentTranscriptSkeleton label={loadingLabel} testId={loadingTestId} />
    );
  } else if (
    !conversation ||
    (conversation.rows.length === 0 && !turnAttachments?.length)
  ) {
    content = <>{empty}</>;
  } else {
    content = (
      <AgentTranscriptView
        conversation={conversation}
        isVisible={isVisible}
        editRetry={editRetry}
        turnAttachments={turnAttachments}
        turnAttachmentLocatorRef={turnAttachmentLocatorRef}
        onTurnAttachmentVisibilityChange={onTurnAttachmentVisibilityChange}
        onLinkAction={onLinkAction}
        onAuthLogin={onAuthLogin}
        onForkThroughTurn={onForkThroughTurn}
        forkThroughTurnPendingTurnIds={forkThroughTurnPendingTurnIds}
        availableSkills={availableSkills}
        workspaceAppIcons={workspaceAppIcons}
        labels={labels}
        showRawTimelineJson={showRawTimelineJson}
        followEndMode={followEndMode}
        participantPresentation={participantPresentation}
        renderUnavailableImage={renderUnavailableImage}
        virtualListLayoutRevision={virtualListLayoutRevision}
        virtualScrollControllerRef={virtualScrollControllerRef}
      />
    );
  }

  return <AgentTurnDisclosureProvider>{content}</AgentTurnDisclosureProvider>;
});
