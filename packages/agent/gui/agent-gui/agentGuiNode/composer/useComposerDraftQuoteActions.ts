import { useCallback } from "react";
import { updateAgentComposerDraft } from "../model/agentComposerDraft";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";

export function useComposerDraftQuoteActions(
  draftScopeKey: string,
  updateScopedDraft: (
    sourceScopeKey: string,
    update: (current: AgentComposerDraft) => AgentComposerDraft
  ) => AgentComposerDraft | null
) {
  const removeDraftQuotes = useCallback(() => {
    updateScopedDraft(draftScopeKey, (currentDraft) =>
      updateAgentComposerDraft(currentDraft, { quotes: [] })
    );
  }, [draftScopeKey, updateScopedDraft]);

  return { removeDraftQuotes };
}
