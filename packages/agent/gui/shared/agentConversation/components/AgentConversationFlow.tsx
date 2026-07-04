import { memo, type ReactNode, type JSX } from "react";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import { AgentTranscriptSkeleton } from "./AgentTranscriptSkeleton";
import { AgentTranscriptView } from "./AgentTranscriptView";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";

interface AgentConversationFlowProps {
  conversation: AgentConversationVM | null;
  isLoading: boolean;
  loadingLabel: string;
  loadingTestId?: string;
  empty: ReactNode;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
  showRawTimelineJson?: boolean;
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
  isLoading,
  loadingLabel,
  loadingTestId,
  empty,
  onLinkAction,
  onAuthLogin,
  availableSkills,
  workspaceAppIcons,
  previewMode = false,
  showRawTimelineJson = false,
  labels
}: AgentConversationFlowProps): JSX.Element {
  "use memo";

  if (isLoading) {
    return (
      <AgentTranscriptSkeleton label={loadingLabel} testId={loadingTestId} />
    );
  }

  if (!conversation || conversation.rows.length === 0) {
    return <>{empty}</>;
  }

  return (
    <AgentTranscriptView
      conversation={conversation}
      onLinkAction={onLinkAction}
      onAuthLogin={onAuthLogin}
      availableSkills={availableSkills}
      workspaceAppIcons={workspaceAppIcons}
      previewMode={previewMode}
      labels={labels}
      showRawTimelineJson={showRawTimelineJson}
    />
  );
});
