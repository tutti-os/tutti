import { BareIconButton } from "@tutti-os/ui-system/components";
import {
  ActivityViewLinedIcon,
  CreateChatIcon
} from "@tutti-os/ui-system/icons";
import { Button } from "../../../app/renderer/components/ui/button";
import { TaskSearchField } from "../../RoomIssueNode/TaskSearchField";
import type { AgentGUIConversationActivityViewController } from "../controller/useAgentGUIConversationActivityView";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import styles from "../AgentGUINode.styles";

export function AgentGUIConversationRailToolbar({
  activityView,
  conversationQuery,
  createConversationDisabled,
  labels,
  onConversationQueryChange,
  onCreateConversation
}: {
  activityView: AgentGUIConversationActivityViewController;
  conversationQuery: string;
  createConversationDisabled: boolean;
  labels: AgentGUIConversationRailLabels;
  onConversationQueryChange: (query: string) => void;
  onCreateConversation: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.railToolbar}>
      <TaskSearchField
        value={conversationQuery}
        placeholder={labels.searchPlaceholder}
        onChange={onConversationQueryChange}
      />
      <Button
        type="button"
        variant="secondary"
        size="dialog"
        className={styles.newConversationIconButton}
        data-testid="agent-gui-new-conversation"
        title={labels.newConversation}
        disabled={createConversationDisabled}
        onClick={onCreateConversation}
      >
        <CreateChatIcon aria-hidden="true" />
        <span>{labels.newConversation}</span>
      </Button>
      {activityView.available ? (
        <BareIconButton
          aria-label={
            activityView.enabled
              ? labels.turnOffActivityView
              : activityView.needsAttention
                ? labels.viewActivityNeedsAttention
                : labels.viewActivity
          }
          aria-pressed={activityView.enabled}
          className={styles.activityToggleButton}
          data-active={activityView.enabled}
          data-testid="agent-gui-activity-view-toggle"
          size="md"
          title={
            activityView.enabled
              ? labels.turnOffActivityView
              : labels.viewActivity
          }
          onClick={activityView.toggle}
        >
          <ActivityViewLinedIcon aria-hidden="true" />
          {!activityView.enabled && activityView.needsAttention ? (
            <span aria-hidden="true" className={styles.activityToggleDot} />
          ) : null}
        </BareIconButton>
      ) : null}
    </div>
  );
}
