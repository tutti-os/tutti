import { memo, useCallback, type JSX } from "react";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import { resolveAgentConversationLinkAction } from "../actions/agentConversationLinkActions";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import { AgentMessageBlock } from "./AgentMessageBlock";
import { AgentProcessingRow } from "./AgentProcessingRow";
import { AgentToolGroupRow } from "./AgentToolGroupRow";
import { AgentTurnSummaryRow } from "./AgentTurnSummaryRow";

interface AgentTranscriptItemViewProps {
  workspaceRoot: string | null;
  basePath: string;
  row: AgentTranscriptRowVM;
  labels: {
    toolCallsLabel: (count: number) => string;
    thinkingLabel: string;
    processing: string;
    turnSummary: string;
    rawTimelineJson?: string;
  };
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
  showRawTimelineJson?: boolean;
  toolGroupExpanded?: boolean;
  toolGroupExpansionKey?: string;
  onToolGroupExpandedChange?: (key: string, expanded: boolean) => void;
}

export const AgentTranscriptItemView = memo(function AgentTranscriptItemView({
  workspaceRoot,
  basePath,
  row,
  labels,
  onLinkAction,
  onAuthLogin,
  availableSkills,
  workspaceAppIcons,
  previewMode = false,
  showRawTimelineJson = false,
  toolGroupExpanded,
  toolGroupExpansionKey,
  onToolGroupExpandedChange
}: AgentTranscriptItemViewProps): JSX.Element {
  "use memo";

  const handleLinkClick = useCallback(
    (href: string) => {
      const action = resolveAgentConversationLinkAction({
        workspaceRoot,
        basePath,
        href,
        source: "agent-markdown"
      });
      if (action) {
        onLinkAction?.(action);
      }
    },
    [basePath, onLinkAction, workspaceRoot]
  );
  switch (row.kind) {
    case "message":
      return (
        <AgentMessageBlock
          workspaceRoot={workspaceRoot}
          basePath={basePath}
          row={row}
          onLinkAction={onLinkAction}
          onAuthLogin={onAuthLogin}
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
          previewMode={previewMode}
          thinkingLabel={labels.thinkingLabel}
          showRawTimelineJson={showRawTimelineJson}
          rawTimelineJsonLabel={labels.rawTimelineJson}
        />
      );
    case "tool-group":
      return (
        <AgentToolGroupRow
          row={row}
          label={labels.toolCallsLabel}
          thinkingLabel={labels.thinkingLabel}
          onLinkClick={handleLinkClick}
          previewMode={previewMode}
          showRawTimelineJson={showRawTimelineJson}
          rawTimelineJsonLabel={labels.rawTimelineJson}
          expanded={row.grouped ? toolGroupExpanded : undefined}
          onExpandedChange={row.grouped ? onToolGroupExpandedChange : undefined}
          expansionKey={toolGroupExpansionKey}
        />
      );
    case "turn-summary":
      return (
        <AgentTurnSummaryRow
          row={row}
          workspaceRoot={workspaceRoot}
          label={labels.turnSummary}
          onLinkAction={onLinkAction}
          previewMode={previewMode}
        />
      );
    case "processing":
      return <AgentProcessingRow row={row} label={labels.processing} />;
  }
});
