import { memo, type ReactNode, type JSX, type Ref } from "react";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentConversationParticipantPresentation } from "../contracts/agentConversationParticipantPresentation";
import { AgentTranscriptSkeleton } from "./AgentTranscriptSkeleton";
import {
  AgentTranscriptView,
  type AgentTranscriptAttachmentLocator,
  type AgentTranscriptTurnAttachment
} from "./AgentTranscriptView";
import { AgentTurnDisclosureProvider } from "./AgentTurnDisclosureContext";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";

export interface AgentConversationFlowProps {
  conversation: AgentConversationVM | null;
  turnAttachments?: readonly AgentTranscriptTurnAttachment[];
  turnAttachmentLocatorRef?: Ref<AgentTranscriptAttachmentLocator>;
  onTurnAttachmentVisibilityChange?: (
    attachmentId: string,
    visible: boolean
  ) => void;
  isLoading: boolean;
  loadingLabel: string;
  loadingTestId?: string;
  empty: ReactNode;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  showRawTimelineJson?: boolean;
  participantPresentation?: AgentConversationParticipantPresentation;
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
  turnAttachments,
  turnAttachmentLocatorRef,
  onTurnAttachmentVisibilityChange,
  isLoading,
  loadingLabel,
  loadingTestId,
  empty,
  onLinkAction,
  onAuthLogin,
  availableSkills,
  workspaceAppIcons,
  showRawTimelineJson = false,
  participantPresentation,
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
        turnAttachments={turnAttachments}
        turnAttachmentLocatorRef={turnAttachmentLocatorRef}
        onTurnAttachmentVisibilityChange={onTurnAttachmentVisibilityChange}
        onLinkAction={onLinkAction}
        onAuthLogin={onAuthLogin}
        availableSkills={availableSkills}
        workspaceAppIcons={workspaceAppIcons}
        labels={labels}
        showRawTimelineJson={showRawTimelineJson}
        participantPresentation={participantPresentation}
      />
    );
  }

  return <AgentTurnDisclosureProvider>{content}</AgentTurnDisclosureProvider>;
});
