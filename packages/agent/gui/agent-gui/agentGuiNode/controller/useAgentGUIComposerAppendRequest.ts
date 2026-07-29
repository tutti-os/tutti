import {
  agentComposerDraftFiles,
  agentComposerDraftPrompt,
  emptyAgentComposerDraft,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import type {
  AgentComposerDraft,
  AgentComposerDraftFile
} from "../model/agentGuiNodeTypes";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";

export type AgentGUIComposerAppendRequest =
  | {
      agentSessionId?: string;
      files: readonly AgentComposerDraftFile[];
      prompt?: string;
      sequence: number;
    }
  | {
      agentSessionId?: string;
      files?: never;
      prompt: string;
      sequence: number;
    };

export function appendAgentGUIComposerPrompt(
  draft: AgentComposerDraft,
  incomingPrompt: string
): AgentComposerDraft {
  const currentPrompt = agentComposerDraftPrompt(draft);
  const normalizedPrompt = incomingPrompt.trim();
  if (!normalizedPrompt || currentPrompt.includes(normalizedPrompt)) {
    return draft;
  }
  const separator = currentPrompt && !/\s$/u.test(currentPrompt) ? " " : "";
  return updateAgentComposerDraft(draft, {
    prompt: `${currentPrompt}${separator}${normalizedPrompt} `
  });
}

export function appendAgentGUIComposerFiles(
  draft: AgentComposerDraft,
  incomingFiles: readonly AgentComposerDraftFile[]
): AgentComposerDraft {
  const files = agentComposerDraftFiles(draft);
  const knownIds = new Set(files.map((file) => file.id));
  for (const file of incomingFiles) {
    if (!knownIds.has(file.id)) {
      knownIds.add(file.id);
      files.push({ ...file });
    }
  }
  return updateAgentComposerDraft(draft, { files });
}

export function resolveAgentGUIComposerAppendRequest(input: {
  activeConversationId: string | null;
  draftByScopeKey: Record<string, AgentComposerDraft>;
  handledSequence: number | null;
  request?: AgentGUIComposerAppendRequest | null;
}): {
  draftKey: string;
  nextDraft: AgentComposerDraft;
  sequence: number;
} | null {
  const {
    activeConversationId,
    draftByScopeKey,
    handledSequence,
    request = null
  } = input;
  if (!request || handledSequence === request.sequence) {
    return null;
  }
  const targetAgentSessionId = request.agentSessionId?.trim() ?? "";
  if (
    targetAgentSessionId &&
    targetAgentSessionId !== (activeConversationId?.trim() ?? "")
  ) {
    return null;
  }
  const draftKey = resolveAgentComposerDraftScopeKey({
    agentSessionId: activeConversationId
  });
  const currentDraft = draftByScopeKey[draftKey] ?? emptyAgentComposerDraft();
  return {
    draftKey,
    nextDraft: appendAgentGUIComposerFiles(
      appendAgentGUIComposerPrompt(currentDraft, request.prompt ?? ""),
      request.files ?? []
    ),
    sequence: request.sequence
  };
}
