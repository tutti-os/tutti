import {
  agentComposerDraftFiles,
  agentComposerDraftPrompt,
  updateAgentComposerDraft
} from "./agentComposerDraft";
import type { AgentComposerDraft } from "./agentGuiNodeTypes";
import { agentComposerFileMentionReferences } from "../agentRichText/agentMentionMarkdown";

export function updateDraftPromptAndReconcileFiles(
  draft: AgentComposerDraft,
  prompt: string
): AgentComposerDraft {
  const previousReferencedIds = new Set(
    agentComposerFileMentionReferences(agentComposerDraftPrompt(draft)).map(
      (reference) => reference.id
    )
  );
  const nextReferencedIds = new Set(
    agentComposerFileMentionReferences(prompt).map((reference) => reference.id)
  );
  return updateAgentComposerDraft(draft, {
    prompt,
    files: agentComposerDraftFiles(draft).filter(
      (file) =>
        !previousReferencedIds.has(file.id) || nextReferencedIds.has(file.id)
    )
  });
}
