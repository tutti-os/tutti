import { AlertCircle } from "lucide-react";
import { Button as SystemButton } from "@tutti-os/ui-system";
import styles from "../AgentGUINode.styles";

export function AgentGUIConversationRailLoadError({
  errorLabel,
  onRetry,
  retryLabel
}: {
  errorLabel: string;
  onRetry: () => void;
  retryLabel: string;
}): React.JSX.Element {
  return (
    <div
      aria-live="polite"
      className={styles.conversationRailLoadError}
      data-testid="agent-gui-conversation-rail-load-error"
      role="status"
    >
      <AlertCircle
        aria-hidden="true"
        className={styles.conversationRailLoadErrorIcon}
      />
      <span>{errorLabel}</span>
      <SystemButton type="button" variant="outline" size="sm" onClick={onRetry}>
        {retryLabel}
      </SystemButton>
    </div>
  );
}
