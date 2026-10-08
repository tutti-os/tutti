import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { handleAgentRichTextKeyDownCapture } from "./agentRichTextKeyboard";

describe("handleAgentRichTextKeyDownCapture input history", () => {
  it("handles bare arrows at a whole-document boundary", () => {
    const onHistoryNavigation = vi.fn(() => true);
    const event = keyboardEvent("ArrowUp");

    handleAgentRichTextKeyDownCapture(
      event as unknown as ReactKeyboardEvent<HTMLDivElement>,
      keyboardInput({
        editor: editorAt({ from: 4, to: 4, documentSize: 5 }),
        onHistoryNavigation
      })
    );

    expect(onHistoryNavigation).toHaveBeenCalledWith("older");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it.each(["ArrowUp", "ArrowDown"])(
    "leaves %s in the middle of multiline input alone",
    (key) => {
      const onHistoryNavigation = vi.fn(() => true);
      const event = keyboardEvent(key);

      handleAgentRichTextKeyDownCapture(
        event as unknown as ReactKeyboardEvent<HTMLDivElement>,
        keyboardInput({
          editor: editorAt({ from: 2, to: 2, documentSize: 5 }),
          onHistoryNavigation
        })
      );

      expect(onHistoryNavigation).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  );

  it("gives an open palette priority over input history", () => {
    const onHistoryNavigation = vi.fn(() => true);
    const event = keyboardEvent("ArrowUp");
    const input = keyboardInput({
      editor: editorAt({ from: 1, to: 1, documentSize: 5 }),
      onHistoryNavigation
    });
    input.onKeyDownForPaletteRef.current = () => true;

    handleAgentRichTextKeyDownCapture(
      event as unknown as ReactKeyboardEvent<HTMLDivElement>,
      input
    );

    expect(onHistoryNavigation).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each(["ArrowUp", "ArrowDown"])(
    "does not enter input history on %s while IME composition is active",
    (key) => {
      const onHistoryNavigation = vi.fn(() => true);
      const event = keyboardEvent(key);
      event.nativeEvent.isComposing = true;

      handleAgentRichTextKeyDownCapture(
        event as unknown as ReactKeyboardEvent<HTMLDivElement>,
        keyboardInput({
          editor: editorAt({ from: 1, to: 1, documentSize: 5 }),
          onHistoryNavigation
        })
      );

      expect(onHistoryNavigation).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
  );
});

function keyboardInput(input: {
  editor: Editor;
  onHistoryNavigation: (direction: "older" | "newer") => boolean;
}) {
  return {
    disabled: false,
    editorRef: { current: input.editor },
    onKeyDownForPaletteRef: {
      current: undefined as ((event: KeyboardEvent) => boolean) | undefined
    },
    onHistoryNavigationRef: { current: input.onHistoryNavigation },
    onSubmitGuidanceRef: { current: undefined },
    onSubmitRef: { current: vi.fn() },
    submitOnEnter: true
  };
}

function editorAt(input: {
  documentSize: number;
  from: number;
  to: number;
}): Editor {
  return {
    isDestroyed: false,
    state: {
      doc: { content: { size: input.documentSize } },
      selection: {
        empty: input.from === input.to,
        from: input.from,
        to: input.to
      }
    }
  } as unknown as Editor;
}

function keyboardEvent(key: string) {
  return {
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: false,
    nativeEvent: {
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      key,
      metaKey: false,
      shiftKey: false
    },
    preventDefault: vi.fn(),
    shiftKey: false,
    stopPropagation: vi.fn()
  };
}
