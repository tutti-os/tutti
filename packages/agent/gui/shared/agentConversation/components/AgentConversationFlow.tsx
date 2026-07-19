import { memo, type ReactNode, type JSX } from "react";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import { AgentTranscriptSkeleton } from "./AgentTranscriptSkeleton";
import { AgentTranscriptView } from "./AgentTranscriptView";
import {
  AgentTurnDisclosureProvider,
  useAgentTurnDisclosureStore
} from "./AgentTurnDisclosureContext";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import { useAgentConversationExport } from "../export/useAgentConversationExport";
import { AgentConversationExportToolbar } from "./AgentConversationExportToolbar";
import { AgentConversationPrintSurface } from "./AgentConversationPrintSurface";

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

export const AgentConversationFlow = memo(function AgentConversationFlow(
  props: AgentConversationFlowProps
): JSX.Element {
  return (
    <AgentTurnDisclosureProvider>
      <AgentConversationFlowContent {...props} />
    </AgentTurnDisclosureProvider>
  );
});

function AgentConversationFlowContent({
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
  const turnDisclosureStore = useAgentTurnDisclosureStore();
  const conversationExport = useAgentConversationExport({
    conversation,
    previewMode,
    toolCallsLabel: labels.toolCallsLabel,
    turnExpandedOverrides: turnDisclosureStore.expandedOverrides
  });

  let content: JSX.Element;
  if (isLoading) {
    content = (
      <AgentTranscriptSkeleton label={loadingLabel} testId={loadingTestId} />
    );
  } else if (!conversation || conversation.rows.length === 0) {
    content = <>{empty}</>;
  } else {
    content = (
      <AgentTranscriptView
        conversation={conversation}
        onLinkAction={onLinkAction}
        onAuthLogin={onAuthLogin}
        availableSkills={availableSkills}
        workspaceAppIcons={workspaceAppIcons}
        previewMode={previewMode}
        labels={labels}
        showRawTimelineJson={showRawTimelineJson}
        exportSelection={conversationExport.selection}
        onToolGroupExpandedChange={conversationExport.onToolGroupExpandedChange}
      />
    );
  }

  const printRequest = conversationExport.printRequest;
  return (
    <>
      {content}
      <AgentConversationExportToolbar
        exportingFormat={conversationExport.exportingFormat}
        onClear={conversationExport.clearSelection}
        onCopyMarkdown={conversationExport.copyMarkdown}
        onExport={conversationExport.exportConversation}
        selectedCount={conversationExport.selectedCount}
      />
      {printRequest ? (
        <AgentConversationPrintSurface
          availableSkills={availableSkills}
          conversation={printRequest.conversation}
          expandedToolRowKeys={printRequest.expandedToolRowKeys}
          labels={labels}
          onReady={conversationExport.onPrintSurfaceReady}
          requestId={printRequest.requestId}
          turnExpandedOverrides={printRequest.turnExpandedOverrides}
          workspaceAppIcons={workspaceAppIcons}
        />
      ) : null}
    </>
  );
}
