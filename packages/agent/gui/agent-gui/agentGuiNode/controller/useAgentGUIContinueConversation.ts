import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type { AgentHostAccountUserProfile } from "../../../shared/contracts/dto";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { resolveAgentGUIExplicitConversationTitle } from "../model/agentGuiProviderIdentity";
import { nodeDefaultDraftKey } from "./agentGuiController.composerHelpers";
import { buildContinueInNewConversationPrompt } from "./agentGuiController.conversationHelpers";
import { reportAgentGUIActiveConversationCleared } from "./agentGuiController.reporting";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import {
  resolveConversationSummaryById,
  type ConversationIntent
} from "./useAgentConversationSelection";

interface CurrentValue<T> {
  current: T;
}

interface UseAgentGUIContinueConversationInput {
  accountProfilesByUserId: Readonly<
    Record<string, AgentHostAccountUserProfile>
  >;
  activeConversationIdRef: CurrentValue<string | null>;
  agentActivityRuntime: AgentActivityRuntime;
  conversations: readonly AgentGUIConversationSummary[];
  createConversation(): void;
  currentUserId: string | null | undefined;
  draftBySessionId: Record<string, AgentComposerDraft>;
  isComposerHomeRef: CurrentValue<boolean>;
  loadDraftComposerOptions(): void;
  persistActiveConversation(agentSessionId: string | null): void;
  selectedComposerTargetDataRef: CurrentValue<AgentGUIComposerTargetData>;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setDraftBySessionId: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  setIsComposerHome: Dispatch<SetStateAction<boolean>>;
  setIsLoadingMessages: Dispatch<SetStateAction<boolean>>;
  transientConversation: AgentGUIConversationSummary | null;
  unactivate(agentSessionId: string): Promise<void>;
  workspaceId: string;
}

export function useAgentGUIContinueConversation(
  input: UseAgentGUIContinueConversationInput
) {
  const inputRef = useRef(input);
  inputRef.current = input;
  return useCallback(() => {
    const current = inputRef.current;
    const currentConversationId = current.activeConversationIdRef.current;
    if (!currentConversationId) return;
    const activeConversation = resolveConversationSummaryById(
      current.conversations,
      currentConversationId,
      current.transientConversation
    );
    if (!activeConversation) {
      current.createConversation();
      return;
    }
    const nextDraftPrompt = buildContinueInNewConversationPrompt({
      workspaceId: current.workspaceId,
      agentSessionId: activeConversation.id,
      conversationUserId: activeConversation.userId,
      currentUserId: current.currentUserId,
      userProfilesByUserId: current.accountProfilesByUserId,
      provider: activeConversation.provider,
      agentTargetId: activeConversation.agentTargetId,
      conversationTitle:
        resolveAgentGUIExplicitConversationTitle(activeConversation) ??
        translate("agentHost.workspaceAgentsUntitledTask"),
      existingDraftPrompt:
        current.draftBySessionId[currentConversationId]?.prompt ?? ""
    });
    reportAgentGUIActiveConversationCleared({
      details: { sourceConversationId: activeConversation.id },
      previousAgentSessionId: currentConversationId,
      reason: "continue_in_new_conversation",
      runtime: current.agentActivityRuntime,
      workspaceId: current.workspaceId
    });
    void current.unactivate(currentConversationId);
    current.setIntent({ tag: "home" });
    current.isComposerHomeRef.current = true;
    current.setIsComposerHome(true);
    current.activeConversationIdRef.current = null;
    current.setActiveConversationId(null);
    current.setIsLoadingMessages(false);
    current.setDetailError(null);
    const targetData = current.selectedComposerTargetDataRef.current;
    current.setDraftBySessionId((drafts) => ({
      ...drafts,
      [nodeDefaultDraftKey(targetData.provider, targetData.agentTargetId)]: {
        prompt: nextDraftPrompt,
        images: []
      }
    }));
    current.persistActiveConversation(null);
    current.loadDraftComposerOptions();
  }, []);
}
