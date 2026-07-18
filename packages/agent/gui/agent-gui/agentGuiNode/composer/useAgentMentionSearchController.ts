import { useEffect, useMemo, useRef, useState } from "react";
import { useRichTextMentionService } from "@tutti-os/ui-rich-text/editor";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import type { AgentContextMentionProvider } from "../agentContextMentionProvider";
import {
  AgentMentionSearchController,
  type AgentMentionSearchState
} from "../AgentMentionSearchController";
import { DEFAULT_AGENT_MENTION_FILTER } from "../agentMentionSearchHelpers";
import type { AgentComposerReferenceProvenanceFilter } from "./AgentComposer.types";

const EMPTY_AGENT_CONTEXT_MENTION_PROVIDERS: readonly AgentContextMentionProvider[] =
  [];

export function useAgentMentionSearchController(
  referenceProvenanceFilter: AgentComposerReferenceProvenanceFilter | null
): {
  mentionControllerRef: React.RefObject<AgentMentionSearchController | null>;
  mentionSearchState: AgentMentionSearchState;
} {
  const mentionService = useRichTextMentionService();
  const contextMentionProviders = useMemo(
    () =>
      mentionService?.listProviders().filter(isAgentContextMentionProvider) ??
      EMPTY_AGENT_CONTEXT_MENTION_PROVIDERS,
    [mentionService]
  );
  const [mentionSearchState, setMentionSearchState] =
    useState<AgentMentionSearchState>(INITIAL_AGENT_MENTION_SEARCH_STATE);
  const mentionControllerRef = useRef<AgentMentionSearchController | null>(
    null
  );

  useEffect(() => {
    const controller = new AgentMentionSearchController({
      contextMentionProviders
    });
    controller.setProvenanceCatalog(
      referenceProvenanceFilter?.snapshot.catalog ?? null
    );
    controller.setProvenanceFilter(
      referenceProvenanceFilter?.snapshot.value ?? null
    );
    mentionControllerRef.current = controller;
    const unsubscribe = controller.subscribe(setMentionSearchState);
    return () => {
      unsubscribe();
      controller.dispose();
      mentionControllerRef.current = null;
    };
  }, [contextMentionProviders]);

  useEffect(() => {
    mentionControllerRef.current?.setProvenanceCatalog(
      referenceProvenanceFilter?.snapshot.catalog ?? null
    );
    mentionControllerRef.current?.setProvenanceFilter(
      referenceProvenanceFilter?.snapshot.value ?? null
    );
  }, [
    referenceProvenanceFilter?.snapshot.catalog,
    referenceProvenanceFilter?.snapshot.value
  ]);

  return { mentionControllerRef, mentionSearchState };
}

function isAgentContextMentionProvider(
  provider: RichTextTriggerProvider
): provider is AgentContextMentionProvider {
  return provider.trigger === "@";
}

const INITIAL_AGENT_MENTION_SEARCH_STATE: AgentMentionSearchState = {
  status: "idle",
  query: "",
  mode: "browse",
  filter: DEFAULT_AGENT_MENTION_FILTER,
  categories: [],
  groups: [],
  error: null
};
