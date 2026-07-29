import { ConfirmationDialog } from "@tutti-os/ui-system";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import type { AgentGUIProjectActionDialog } from "./AgentGUIConversationRailPane";

const DIALOG_CLASS_NAME =
  "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]";

export function AgentGUIProjectActionConfirmationDialog(props: {
  action: AgentGUIProjectActionDialog | null;
  isDeletingProjectConversations: boolean;
  isInteractionLocked: () => boolean;
  labels: AgentGUIConversationRailLabels;
  onConfirmDeleteConversations: (sessionIds: string[]) => void;
  onRemoveProject: (path: string) => void;
  setAction: (action: AgentGUIProjectActionDialog | null) => void;
}): React.JSX.Element {
  const { action, labels } = props;
  return (
    <ConfirmationDialog
      cancelLabel={labels.cancel}
      className={DIALOG_CLASS_NAME}
      confirmBusy={
        (action?.kind === "batch-delete" ||
          action?.kind === "batch-delete-conversations") &&
        props.isDeletingProjectConversations
      }
      confirmDisabled={props.isInteractionLocked()}
      confirmLabel={
        action?.kind === "batch-delete"
          ? labels.batchDeleteProjectSessionsConfirm
          : action?.kind === "batch-delete-conversations"
            ? labels.batchDeleteConversationsConfirm
            : labels.removeProject
      }
      description={
        action?.kind === "batch-delete"
          ? labels.batchDeleteProjectSessionsBody(
              action.conversationCount,
              action.label
            )
          : action?.kind === "batch-delete-conversations"
            ? labels.batchDeleteConversationsBody(action.conversationCount)
            : action
              ? labels.removeProjectConfirmDescription(action.label)
              : undefined
      }
      onCancel={() => props.setAction(null)}
      onConfirm={() => {
        if (props.isInteractionLocked()) return;
        props.setAction(null);
        if (!action) return;
        if (
          action.kind === "batch-delete" ||
          action.kind === "batch-delete-conversations"
        ) {
          props.onConfirmDeleteConversations(action.sessionIds);
          return;
        }
        props.onRemoveProject(action.path);
      }}
      onOpenChange={(open) => {
        if (!open) props.setAction(null);
      }}
      open={action !== null}
      overlayClassName={DIALOG_CLASS_NAME}
      title={
        action?.kind === "batch-delete"
          ? labels.batchDeleteProjectSessionsTitle
          : action?.kind === "batch-delete-conversations"
            ? labels.batchDeleteConversationsTitle
            : labels.removeProjectConfirmTitle
      }
      tone="destructive"
    />
  );
}
