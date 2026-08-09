import type { Editor } from "@tiptap/core";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { AgentCapabilityTokenOption } from "./agentCapabilityTokenExtension";
import { plainTextToAgentRichTextInlineContent } from "./agentRichTextDocument";
import {
  classifyAgentRichTextTextPaste,
  insertAgentRichTextClipboardHtml
} from "./agentRichTextEditorSupport";
import { handleAgentRichTextAbsolutePathPaste } from "./handleAgentRichTextAbsolutePathPaste";

type MentionSuggestionSuppression = {
  suppressTextInsertion: (text: string) => void;
};

export function routeAgentRichTextTextPaste(input: {
  availableCapabilities: readonly AgentCapabilityTokenOption[];
  availableSkills: readonly AgentGUIProviderSkillOption[];
  editorRef: { current: Editor | null };
  html: string;
  mentionSuggestionSuppression: MentionSuggestionSuppression;
  onPasteLargeText?: ((text: string) => void) | null;
  resolvePastedPath?:
    | ((text: string) => Promise<WorkspaceFileReference | null>)
    | null;
  text: string;
}): boolean {
  const textPasteKind = classifyAgentRichTextTextPaste(
    input.text,
    input.html,
    Boolean(input.onPasteLargeText)
  );
  if (textPasteKind === "empty") {
    return false;
  }
  if (textPasteKind === "large-text") {
    input.onPasteLargeText?.(input.text);
    return true;
  }
  if (textPasteKind === "structured-mention") {
    const currentEditor = input.editorRef.current;
    if (!currentEditor) {
      return true;
    }
    if (insertAgentRichTextClipboardHtml(currentEditor, input.html)) {
      input.mentionSuggestionSuppression.suppressTextInsertion(input.text);
    }
    return true;
  }
  if (
    handleAgentRichTextAbsolutePathPaste({
      availableCapabilities: input.availableCapabilities,
      availableSkills: input.availableSkills,
      editorRef: input.editorRef,
      mentionSuggestionSuppression: input.mentionSuggestionSuppression,
      resolvePastedPath: input.resolvePastedPath,
      text: input.text
    })
  ) {
    return true;
  }
  const currentEditor = input.editorRef.current;
  if (!currentEditor) {
    return true;
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
  return true;
}
