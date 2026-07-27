import { useCallback, useRef, type RefObject } from "react";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import { snapshotAgentComposerDraft } from "../model/agentComposerDraft";
import {
  EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE,
  navigateAgentComposerInputHistory,
  recordAgentComposerInputHistory,
  type AgentComposerInputHistoryState,
  type AgentComposerInputHistoryStore
} from "../model/agentComposerInputHistory";

interface Input {
  currentDraft: AgentComposerDraft;
  draftByScopeKeyRef: RefObject<Record<string, AgentComposerDraft>>;
  draftScopeKey: string;
  inputHistoryStore?: AgentComposerInputHistoryStore;
  onDraftContentChange: (
    draft: AgentComposerDraft,
    sourceScopeKey?: string
  ) => void;
}

export function useComposerInputHistory(input: Input): {
  onHistoryNavigation: (direction: "older" | "newer") => boolean;
  recordSubmittedDraft: (draft: AgentComposerDraft) => void;
} {
  const cursorRef = useRef<AgentComposerInputHistoryState>(
    EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE
  );
  const ownerScopeRef = useRef(input.draftScopeKey);
  const ownerStoreRef = useRef(input.inputHistoryStore);
  if (
    ownerScopeRef.current !== input.draftScopeKey ||
    ownerStoreRef.current !== input.inputHistoryStore
  ) {
    ownerScopeRef.current = input.draftScopeKey;
    ownerStoreRef.current = input.inputHistoryStore;
    cursorRef.current = EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE;
  }

  const restoreDraft = useCallback(
    (draft: AgentComposerDraft) => {
      const restoredDraft = snapshotAgentComposerDraft(draft);
      input.draftByScopeKeyRef.current[input.draftScopeKey] = restoredDraft;
      input.onDraftContentChange(restoredDraft, input.draftScopeKey);
    },
    [input.draftByScopeKeyRef, input.draftScopeKey, input.onDraftContentChange]
  );

  const recordSubmittedDraft = useCallback(
    (draft: AgentComposerDraft): void => {
      if (!input.inputHistoryStore) {
        return;
      }
      recordAgentComposerInputHistory(input.inputHistoryStore, draft);
      cursorRef.current = EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE;
    },
    [input.inputHistoryStore]
  );

  const onHistoryNavigation = useCallback(
    (direction: "older" | "newer"): boolean => {
      if (!input.inputHistoryStore) {
        return false;
      }
      const navigation = navigateAgentComposerInputHistory({
        currentDraft:
          input.draftByScopeKeyRef.current[input.draftScopeKey] ??
          input.currentDraft,
        direction,
        entries: input.inputHistoryStore.entries,
        state: cursorRef.current
      });
      cursorRef.current = navigation.state;
      if (navigation.draft) {
        restoreDraft(navigation.draft);
      }
      return navigation.handled;
    },
    [
      input.currentDraft,
      input.draftByScopeKeyRef,
      input.draftScopeKey,
      input.inputHistoryStore,
      restoreDraft
    ]
  );

  return {
    onHistoryNavigation,
    recordSubmittedDraft
  };
}
