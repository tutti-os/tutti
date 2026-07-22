import { memo, useCallback, type JSX } from "react";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import { resolveAgentConversationLinkAction } from "../actions/agentConversationLinkActions";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import { AgentGeneratedImageRow } from "./AgentGeneratedImageRow";
import { AgentGoalControlRow } from "./AgentGoalControlRow";
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
  provider?: string | null;
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
  provider,
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
    case "generated-image":
      return <AgentGeneratedImageRow row={row} />;
    case "goal-control":
      return (
        <AgentGoalControlRow
          row={row}
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
        />
      );
    case "message":
      return (
        <AgentMessageBlock
          workspaceRoot={workspaceRoot}
          basePath={basePath}
          row={row}
          onLinkAction={onLinkAction}
          onAuthLogin={onAuthLogin}
          provider={provider}
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
          basePath={basePath}
          label={labels.turnSummary}
          onLinkAction={onLinkAction}
          previewMode={previewMode}
        />
      );
    case "processing":
      return <AgentProcessingRow row={row} label={labels.processing} />;
  }
});
