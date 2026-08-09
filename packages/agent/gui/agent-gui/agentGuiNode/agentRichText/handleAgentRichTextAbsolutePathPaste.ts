import type { Editor } from "@tiptap/core";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { AgentCapabilityTokenOption } from "./agentCapabilityTokenExtension";
import { plainTextToAgentRichTextInlineContent } from "./agentRichTextDocument";
import {
  isAgentRichTextAbsolutePathPasteCandidate,
  isPromptVisualLineStart
} from "./agentRichTextEditorSupport";
import { createAgentFileMentionContent } from "./agentWorkspaceFileReferences";

type MentionSuggestionSuppression = {
  suppressTextInsertion: (text: string) => void;
};

export function handleAgentRichTextAbsolutePathPaste(input: {
  availableCapabilities: readonly AgentCapabilityTokenOption[];
  availableSkills: readonly AgentGUIProviderSkillOption[];
  editorRef: { current: Editor | null };
  mentionSuggestionSuppression: MentionSuggestionSuppression;
  resolvePastedPath?:
    | ((text: string) => Promise<WorkspaceFileReference | null>)
    | null;
  text: string;
}): boolean {
  const pathCandidate = input.text.trim();
  const resolvePastedPath = input.resolvePastedPath;
  if (
    !resolvePastedPath ||
    !isAgentRichTextAbsolutePathPasteCandidate(pathCandidate)
  ) {
    return false;
  }

  const insertPlainPasteText = (): void => {
    const currentEditor = input.editorRef.current;
    if (!currentEditor || currentEditor.isDestroyed) {
      return;
    }
    if (!currentEditor.isFocused) {
      currentEditor.commands.setTextSelection(
        currentEditor.state.doc.content.size
      );
    }
    input.mentionSuggestionSuppression.suppressTextInsertion(input.text);
    currentEditor.commands.insertContent(
      plainTextToAgentRichTextInlineContent(input.text, {
        capabilities: input.availableCapabilities,
        skills: input.availableSkills
      })
    );
  };

  void resolvePastedPath(pathCandidate)
    .then((reference) => {
      const currentEditor = input.editorRef.current;
      if (!currentEditor || currentEditor.isDestroyed) {
        return;
      }
      if (!reference) {
        insertPlainPasteText();
        return;
      }
      if (!currentEditor.isFocused) {
        currentEditor.commands.setTextSelection(
          currentEditor.state.doc.content.size
        );
      }
      input.mentionSuggestionSuppression.suppressTextInsertion(pathCandidate);
      currentEditor.commands.insertContent(
        createAgentFileMentionContent([reference], {
          prefixCaretAnchor: isPromptVisualLineStart(
            currentEditor,
            currentEditor.state.selection.from
          )
        })
      );
    })
    .catch(() => {
      insertPlainPasteText();
    });
  return true;
}
