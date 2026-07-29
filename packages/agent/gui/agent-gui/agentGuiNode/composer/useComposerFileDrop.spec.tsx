import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useComposerFileDrop } from "./useComposerFileDrop";

function fileDropEvent(files: readonly File[]): DragEvent {
  const event = new Event("drop", {
    bubbles: true,
    cancelable: true
  }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: {
      files,
      dropEffect: "none"
    }
  });
  return event;
}

describe("useComposerFileDrop", () => {
  it("routes dropped images through file preparation when prompt images are unsupported", () => {
    const form = document.createElement("form");
    document.body.append(form);
    const addDraftFiles = vi.fn();
    const addDraftImages = vi.fn();
    const onPromptImagesUnsupported = vi.fn();
    const image = new File(["image"], "screen.png", { type: "image/png" });
    const rendered = renderHook(() =>
      useComposerFileDrop({
        composerRef: { current: form },
        editorHandleRef: { current: { focusAtEnd: vi.fn() } as never },
        inputDisabled: false,
        promptFilesSupported: true,
        promptImagesSupported: false,
        addDraftImages,
        addDraftFiles,
        scheduleComposerFocus: vi.fn(),
        onPromptImagesUnsupported
      })
    );

    form.dispatchEvent(fileDropEvent([image]));

    expect(addDraftFiles).toHaveBeenCalledWith([image]);
    expect(addDraftImages).not.toHaveBeenCalled();
    expect(onPromptImagesUnsupported).not.toHaveBeenCalled();
    rendered.unmount();
    form.remove();
  });
});
