import { Button as SystemButton } from "@tutti-os/ui-system";
import { AgentConversationListSkeleton } from "../AgentConversationListSkeleton";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import { AgentGUIConversationRailLoadError } from "./AgentGUIConversationRailLoadError";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import styles from "../AgentGUINode.styles";

export function AgentGUIConversationRailContentState({
  children,
  conversationQuery,
  conversations,
  hasRailContent,
  isLoading,
  labels,
  onRetry,
  onRetrySearch,
  railError,
  searchError,
  showEmptyState
}: {
  children: React.ReactNode;
  conversationQuery: string;
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  hasRailContent: boolean;
  isLoading: boolean;
  labels: AgentGUIConversationRailLabels;
  onRetry: () => void;
  onRetrySearch: () => void;
  railError: boolean;
  searchError: boolean;
  showEmptyState: boolean;
}): React.JSX.Element {
  const content = isLoading ? (
    <AgentConversationListSkeleton label={labels.loadingConversations} />
  ) : searchError ? (
    <div className={styles.emptyState}>
      <span>{labels.searchFailed}</span>
      <SystemButton
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetrySearch}
      >
        {labels.retrySearch}
      </SystemButton>
    </div>
  ) : showEmptyState ? (
    <div className={styles.emptyState}>
      <span>
        {conversationQuery.trim()
          ? labels.searchNoConversations
          : conversations.length === 0
            ? labels.noConversations
            : labels.conversationUnavailable}
      </span>
    </div>
  ) : (
    <>{children}</>
  );

  return (
    <>
      {railError && !hasRailContent ? (
        <AgentGUIConversationRailLoadError
          errorLabel={labels.conversationsLoadFailed}
          onRetry={onRetry}
          retryLabel={labels.retryConversations}
        />
      ) : null}
      {railError && !hasRailContent ? null : content}
    </>
  );
}
