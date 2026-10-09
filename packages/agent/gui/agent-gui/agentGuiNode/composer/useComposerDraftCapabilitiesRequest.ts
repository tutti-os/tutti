import { useCallback, useRef } from "react";
import type { AgentRichTextEditorHandle } from "../agentRichText/AgentRichTextEditor";
import { agentComposerDraftPrompt } from "../model/agentComposerDraft";
import { getAgentComposerTriggerQueryMatch } from "../model/agentComposerTriggerQueries";
import type { AgentComposerProps } from "./AgentComposer.types";

interface UseComposerDraftCapabilitiesRequestOptions {
  capabilitiesScopeKey: string;
  editorHandleRef: { current: AgentRichTextEditorHandle | null };
  onDraftContentChange: AgentComposerProps["onDraftContentChange"];
  onRetryComposerOptions: AgentComposerProps["onRetryComposerOptions"];
}

export function useComposerDraftCapabilitiesRequest({
  capabilitiesScopeKey,
  editorHandleRef,
  onDraftContentChange,
  onRetryComposerOptions
}: UseComposerDraftCapabilitiesRequestOptions): AgentComposerProps["onDraftContentChange"] {
  const requestedKeyRef = useRef<string | null>(null);

  return useCallback(
    (nextDraft, sourceScopeKey) => {
      const promptBeforeSelection =
        editorHandleRef.current?.getPromptTextBeforeSelection() ?? "";
      const nextPrompt = (
        promptBeforeSelection || agentComposerDraftPrompt(nextDraft)
      ).trimStart();
      if (
        onRetryComposerOptions &&
        getAgentComposerTriggerQueryMatch(nextPrompt)
      ) {
        if (requestedKeyRef.current !== capabilitiesScopeKey) {
          requestedKeyRef.current = capabilitiesScopeKey;
          onRetryComposerOptions({ section: "capabilities" });
        }
      } else {
        requestedKeyRef.current = null;
      }
      onDraftContentChange(nextDraft, sourceScopeKey);
    },
    [
      capabilitiesScopeKey,
      editorHandleRef,
      onDraftContentChange,
      onRetryComposerOptions
    ]
  );
}
