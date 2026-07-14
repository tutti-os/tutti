import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import {
  agentComposerDraftHasContent,
  agentPromptContentToComposerDraft,
  emptyAgentComposerDraft
} from "../model/agentComposerDraft";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import { shouldClearSubmittedDraft } from "./agentGuiController.draftMessageHelpers";

export function clearSubmittedAgentGUIHomeDraft(input: {
  draftKey: string;
  drafts: Record<string, AgentComposerDraft>;
  submittedDraft: AgentComposerDraft;
}): Record<string, AgentComposerDraft> {
  if (
    !shouldClearSubmittedDraft({
      currentDraft: input.drafts[input.draftKey],
      submittedDraft: input.submittedDraft
    })
  ) {
    return input.drafts;
  }
  return {
    ...input.drafts,
    [input.draftKey]: emptyAgentComposerDraft()
  };
}

export function restoreFailedAgentGUIHomeDraft(input: {
  agentSessionId: string;
  content: readonly AgentPromptContentBlock[];
  draftKey: string;
  drafts: Record<string, AgentComposerDraft>;
}): Record<string, AgentComposerDraft> {
  const currentDraft = input.drafts[input.draftKey];
  if (currentDraft && agentComposerDraftHasContent(currentDraft)) {
    return input.drafts;
  }
  return {
    ...input.drafts,
    [input.draftKey]: agentPromptContentToComposerDraft(
      input.content,
      `activation-failure:${input.agentSessionId}`
    )
  };
}
