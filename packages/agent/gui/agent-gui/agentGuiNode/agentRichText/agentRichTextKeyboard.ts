import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { isAgentRichTextImeComposing } from "./agentRichTextIme";
import { moveSelectionOverCaretAnchor } from "./agentRichTextEditorSupport";

export function handleAgentRichTextKeyDownCapture(
  event: ReactKeyboardEvent<HTMLDivElement>,
  input: {
    disabled: boolean;
    editorRef: RefObject<Editor | null>;
    onKeyDownForPaletteRef: RefObject<
      ((event: KeyboardEvent) => boolean) | undefined
    >;
    onSubmitGuidanceRef: RefObject<(() => void) | undefined>;
    onSubmitRef: RefObject<() => void>;
    submitOnEnter: boolean;
  }
): void {
  if (isAgentRichTextImeComposing(event.nativeEvent)) {
    return;
  }
  if (input.disabled) {
    return;
  }
  if (input.onKeyDownForPaletteRef.current?.(event.nativeEvent)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (
    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    const currentEditor = input.editorRef.current;
    if (
      currentEditor &&
      !currentEditor.isDestroyed &&
      moveSelectionOverCaretAnchor(
        currentEditor.state,
        (transaction) => currentEditor.view.dispatch(transaction),
        event.key
      )
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
  if (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (!input.submitOnEnter) {
      return;
    }
    input.onSubmitGuidanceRef.current?.();
    return;
  }
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (!input.submitOnEnter) {
    return;
  }
  input.onSubmitRef.current();
}
