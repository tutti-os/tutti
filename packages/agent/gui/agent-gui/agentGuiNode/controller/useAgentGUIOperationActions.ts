import { selectEngineSession } from "@tutti-os/agent-activity-core";
import { useCallback } from "react";
import { textPromptContent } from "../model/agentComposerDraft";
import { resolveConversationSummaryById } from "./useAgentConversationSelection";
import { useAgentGUIComposerSettingsActions } from "./useAgentGUIComposerSettingsActions";
import { useAgentGUIContinueConversation } from "./useAgentGUIContinueConversation";
import { useAgentGUIConversationBatchDeletion } from "./useAgentGUIConversationBatchDeletion";
import { useAgentGUIConversationDeletion } from "./useAgentGUIConversationDeletion";
import { useAgentGUIConversationHome } from "./useAgentGUIConversationHome";
import { useAgentGUIConversationMetadataActions } from "./useAgentGUIConversationMetadataActions";
import { useAgentGUINewConversationActivation } from "./useAgentGUINewConversationActivation";
import { useAgentGUIPlanActions } from "./useAgentGUIPlanActions";
import { useAgentGUIQueueActions } from "./useAgentGUIQueueActions";
import { useAgentGUISubmitInteractionActions } from "./useAgentGUISubmitInteractionActions";

type SubmitInput = Parameters<typeof useAgentGUISubmitInteractionActions>[0];
type HomeInput = Parameters<typeof useAgentGUIConversationHome>[0];
type NewConversationInput = Parameters<
  typeof useAgentGUINewConversationActivation
>[0];

type UseAgentGUIOperationActionsInput = Omit<
  SubmitInput,
  "isSessionMarkedNonResumable" | "startConversation"
> &
  Omit<HomeInput, "submitPrefillPrompt"> &
  Omit<NewConversationInput, "getCachedComposerOptions"> &
  Omit<
    Parameters<typeof useAgentGUIContinueConversation>[0],
    "createConversation"
  > &
  Parameters<typeof useAgentGUIComposerSettingsActions>[0] &
  Parameters<typeof useAgentGUIPlanActions>[0] &
  Parameters<typeof useAgentGUIConversationDeletion>[0] &
  Parameters<typeof useAgentGUIQueueActions>[0] &
  Parameters<typeof useAgentGUIConversationMetadataActions>[0] &
  Parameters<typeof useAgentGUIConversationBatchDeletion>[0] & {
    providerComposerOptions: ReturnType<
      NewConversationInput["getCachedComposerOptions"]
    >;
  };

/**
 * Composes the vertical command owners used by the Agent GUI. This hook owns no
 * durable state; Session/Turn/Interaction state remains inside the engine.
 */
export function useAgentGUIOperationActions(
  input: UseAgentGUIOperationActionsInput
) {
  const startConversation = useAgentGUINewConversationActivation({
    ...input,
    getCachedComposerOptions: () => input.providerComposerOptions
  });

  const { createConversation } = useAgentGUIConversationHome({
    ...input,
    submitPrefillPrompt: (prompt) => {
      queueMicrotask(() => {
        input.submitPromptRef.current(textPromptContent(prompt));
      });
    }
  });

  const continueInNewConversation = useAgentGUIContinueConversation({
    ...input,
    createConversation
  });

  const isSessionMarkedNonResumable = useCallback(
    (agentSessionId: string): boolean => {
      if (
        selectEngineSession(input.sessionEngine.getSnapshot(), agentSessionId)
          ?.resumable === false
      ) {
        return true;
      }
      const conversation = resolveConversationSummaryById(
        input.conversationsRef.current,
        agentSessionId,
        input.transientConversation
      );
      return conversation?.resumable === false;
    },
    [input.sessionEngine, input.conversationsRef, input.transientConversation]
  );

  const submitActions = useAgentGUISubmitInteractionActions({
    ...input,
    isSessionMarkedNonResumable,
    startConversation
  });
  const settingsActions = useAgentGUIComposerSettingsActions(input);

  useAgentGUIPlanActions(input);

  const deletionActions = useAgentGUIConversationDeletion(input);
  const queueActions = useAgentGUIQueueActions(input);
  const metadataActions = useAgentGUIConversationMetadataActions(input);
  const batchDeletionActions = useAgentGUIConversationBatchDeletion(input);

  return {
    ...submitActions,
    ...settingsActions,
    ...deletionActions,
    ...queueActions,
    ...metadataActions,
    ...batchDeletionActions,
    continueInNewConversation,
    createConversation
  };
}
