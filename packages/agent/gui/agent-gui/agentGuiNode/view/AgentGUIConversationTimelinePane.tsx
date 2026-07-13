import { memo } from "react";
import { AgentConversationFlow } from "../../../shared/agentConversation/components/AgentConversationFlow";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";

const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];

interface AgentGUIConversationTimelinePaneProps {
  conversation: AgentConversationVM | null;
  isLoading: boolean;
  isLoadingOlderMessages: boolean;
  loadingLabel: string;
  empty: React.JSX.Element;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
  labels: {
    thinkingLabel: string;
    toolCallsLabel: (count: number) => string;
    processing: string;
    turnSummary: string;
    userMessageLocator: string;
  };
}

export const AgentGUIConversationTimelinePane = memo(
  function AgentGUIConversationTimelinePane({
    conversation,
    isLoading,
    isLoadingOlderMessages,
    loadingLabel,
    empty,
    onLinkAction,
    onAuthLogin,
    availableSkills,
    workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
    previewMode = false,
    labels
  }: AgentGUIConversationTimelinePaneProps): React.JSX.Element {
    "use memo";

    return (
      <>
        {isLoadingOlderMessages && !isLoading ? (
          <div
            className="mx-auto flex h-8 items-center justify-center text-[12px] text-[var(--text-secondary)]"
            data-testid="agent-gui-older-messages-loading"
            role="status"
          >
            <span className="tsh-inline-loading-ellipsis">{loadingLabel}</span>
          </div>
        ) : null}
        <AgentConversationFlow
          conversation={conversation}
          isLoading={isLoading}
          loadingLabel={loadingLabel}
          empty={empty}
          onLinkAction={onLinkAction}
          onAuthLogin={onAuthLogin}
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
          previewMode={previewMode}
          labels={labels}
        />
      </>
    );
  }
);

export function setTimelineScrollTopInstantly(
  element: HTMLElement,
  top: number
): void {
  // Timeline anchoring runs for high-frequency streaming updates. Smooth scrolling
  // queues animations that can overlap with incoming layout commits and make the transcript flicker.
  element.scrollTop = top;
}

export function setTimelineScrollTopWithUserTransition(
  element: HTMLElement,
  top: number
): void {
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof element.scrollTo === "function") {
    element.scrollTo({
      top,
      behavior: reducedMotion ? "auto" : "smooth"
    });
    return;
  }
  element.scrollTop = top;
}
