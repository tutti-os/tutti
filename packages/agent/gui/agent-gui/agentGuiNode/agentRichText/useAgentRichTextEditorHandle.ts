import { useImperativeHandle, type ForwardedRef, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { AgentCapabilityTokenOption } from "./agentCapabilityTokenExtension";
import type { AgentRichTextEditorHandle } from "./AgentRichTextEditor.types";
import {
  editorToPromptText,
  plainTextToAgentRichTextInlineContent
} from "./agentRichTextDocument";
import {
  createAgentFileMentionContent,
  createAgentMentionContent
} from "./agentWorkspaceFileReferences";
import {
  isMentionTriggerBoundaryBeforeSelection,
  isPromptVisualLineStart
} from "./agentRichTextEditorSupport";

export function useAgentRichTextEditorHandle(input: {
  availableCapabilitiesRef: RefObject<readonly AgentCapabilityTokenOption[]>;
  availableSkillsRef: RefObject<readonly AgentGUIProviderSkillOption[]>;
  editorRef: RefObject<Editor | null>;
  ref: ForwardedRef<AgentRichTextEditorHandle>;
}): void {
  useImperativeHandle(
    input.ref,
    () => ({
      focusAtStart() {
        const currentEditor = input.editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed) {
          return;
        }
        currentEditor
          .chain()
          .focus()
          .setTextSelection(1)
          .scrollIntoView()
          .run();
      },
      focusAtEnd() {
        const currentEditor = input.editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed) {
          return;
        }
        const end = currentEditor.state.doc.content.size;
        currentEditor.chain().focus().setTextSelection(end).run();
      },
      getPromptTextBeforeSelection() {
        const currentEditor = input.editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed) {
          return "";
        }
        return currentEditor.state.doc.textBetween(
          0,
          currentEditor.state.selection.from,
          "\n",
          "\n"
        );
      },
      openMentionPalette() {
        const currentEditor = input.editorRef.current;
        if (
          !currentEditor ||
          currentEditor.isDestroyed ||
          !currentEditor.isEditable
        ) {
          return;
        }
        const triggerText = isMentionTriggerBoundaryBeforeSelection(
          currentEditor
        )
          ? "@"
          : " @";
        currentEditor.chain().focus().insertContent(triggerText).run();
      },
      insertWorkspaceReferences(items) {
        const currentEditor = input.editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed || items.length === 0) {
          return;
        }
        currentEditor
          .chain()
          .focus()
          .insertContent(
            createAgentFileMentionContent(items, {
              prefixCaretAnchor: isPromptVisualLineStart(
                currentEditor,
                currentEditor.state.selection.from
              )
            })
          )
          .run();
      },
      insertMentionItems(items) {
        const currentEditor = input.editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed || items.length === 0) {
          return;
        }
        currentEditor
          .chain()
          .focus()
          .insertContent(
            createAgentMentionContent(items, {
              prefixCaretAnchor: isPromptVisualLineStart(
                currentEditor,
                currentEditor.state.selection.from
              )
            })
          )
          .run();
      },
      replaceTextBeforeSelection(length, text) {
        const currentEditor = input.editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed || length <= 0) {
          return null;
        }
        const to = currentEditor.state.selection.from;
        const from = Math.max(1, to - length);
        currentEditor
          .chain()
          .focus()
          .insertContentAt(
            { from, to },
            plainTextToAgentRichTextInlineContent(text, {
              capabilities: input.availableCapabilitiesRef.current,
              skills: input.availableSkillsRef.current
            })
          )
          .run();
        return editorToPromptText(currentEditor);
      }
    }),
    []
  );
}
