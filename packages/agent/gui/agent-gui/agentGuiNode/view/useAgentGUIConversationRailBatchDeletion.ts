import type { Dispatch, SetStateAction } from "react";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import type { AgentGUIProjectActionDialog } from "./agentGUIConversationRailTypes";
import { useStableEventCallback } from "./agentGUIViewUtils";

export function useAgentGUIConversationRailBatchDeletion({
  batchDeletionAvailable,
  isDeletingProjectConversations,
  isInteractionLocked,
  isRequestingBatchDeletion,
  onConfirmDeleteProjectConversations,
  sectionAgentTargetId,
  setIsRequestingBatchDeletion,
  setPendingProjectAction
}: {
  batchDeletionAvailable: boolean;
  isDeletingProjectConversations: boolean;
  isInteractionLocked: () => boolean;
  isRequestingBatchDeletion: boolean;
  onConfirmDeleteProjectConversations: (
    sectionKey?: string,
    agentTargetId?: string | null
  ) => Promise<string[]>;
  sectionAgentTargetId: string;
  setIsRequestingBatchDeletion: Dispatch<SetStateAction<boolean>>;
  setPendingProjectAction: Dispatch<
    SetStateAction<AgentGUIProjectActionDialog | null>
  >;
}): {
  requestProjectRemoval: (
    section: ConversationSection,
    path: string,
    label: string
  ) => void;
  requestSectionBatchDeletion: (section: ConversationSection) => void;
} {
  const requestSectionBatchDeletion = useStableEventCallback(
    (section: ConversationSection) => {
      if (
        !batchDeletionAvailable ||
        isInteractionLocked() ||
        isDeletingProjectConversations ||
        isRequestingBatchDeletion
      ) {
        return;
      }
      setIsRequestingBatchDeletion(true);
      void onConfirmDeleteProjectConversations(
        section.id,
        sectionAgentTargetId || undefined
      )
        .then((sessionIds) => {
          if (isInteractionLocked() || sessionIds.length === 0) return;
          setPendingProjectAction({
            kind:
              section.kind === "project"
                ? "batch-delete"
                : "batch-delete-conversations",
            conversationCount: sessionIds.length,
            label: section.label,
            sessionIds: [...sessionIds]
          });
        })
        .finally(() => setIsRequestingBatchDeletion(false));
    }
  );
  const requestProjectRemoval = useStableEventCallback(
    (section: ConversationSection, path: string, label: string) => {
      if (
        !batchDeletionAvailable ||
        isInteractionLocked() ||
        isDeletingProjectConversations ||
        isRequestingBatchDeletion
      ) {
        return;
      }
      setPendingProjectAction({
        kind: "remove",
        label,
        path,
        sectionKey: section.id
      });
    }
  );
  return { requestProjectRemoval, requestSectionBatchDeletion };
}
