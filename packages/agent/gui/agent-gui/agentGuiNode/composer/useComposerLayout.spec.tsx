import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerLayout } from "./useComposerLayout";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useComposerLayout", () => {
  it("measures prompt-tip overflow only after ResizeObserver delivers layout", () => {
    const resizeObservers: ResizeObserverMock[] = [];
    class ResizeObserverMock implements ResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const promptTip = document.createElement("span");
    const promptTipParent = document.createElement("div");
    promptTipParent.appendChild(promptTip);
    const scrollWidth = vi
      .spyOn(promptTip, "scrollWidth", "get")
      .mockReturnValue(160);
    const clientWidth = vi
      .spyOn(promptTip, "clientWidth", "get")
      .mockReturnValue(120);
    const setIsPromptTipOverflowing = vi.fn();

    renderHook(() =>
      useComposerLayout({
        isHeroLayout: true,
        inputDisabled: false,
        paletteDraftPrompt: "",
        showFileMentionPalette: false,
        showFloatingCommandMenu: false,
        previewMode: false,
        promptTips: [{ id: "tip-1", label: "Label", prompt: "Prompt" }],
        promptTipsPrefix: "Tip: ",
        composerSettings: {
          sessionSettings: null,
          draftSettings: {
            model: null,
            reasoningEffort: null,
            speed: null,
            planMode: false
          },
          supportsModel: false,
          supportsReasoningEffort: false,
          supportsSpeed: false,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          speedUnavailable: false,
          availableModels: [],
          availableReasoningEfforts: [],
          availableSpeeds: [],
          projectLocked: false,
          projectPathIsRemote: false
        },
        selectedProjectPath: "",
        promptTipRef: { current: promptTip },
        promptInputAreaRef: { current: null },
        setIsPromptTipOverflowing,
        dockComposerInputHeight: 56,
        setDockComposerInputHeight: vi.fn(),
        dockComposerInputMaxHeight: 110,
        setDockComposerInputMaxHeight: vi.fn(),
        dockComposerAttachmentHeight: 0,
        setDockComposerAttachmentHeight: vi.fn(),
        dockComposerTextHeight: 56,
        setDockComposerTextHeight: vi.fn(),
        draftImages: [],
        draftLargeTexts: []
      })
    );

    expect(scrollWidth).not.toHaveBeenCalled();
    expect(clientWidth).not.toHaveBeenCalled();
    expect(resizeObservers).toHaveLength(1);

    act(() => {
      resizeObservers[0]?.callback([], resizeObservers[0]);
    });

    expect(scrollWidth).toHaveBeenCalledTimes(1);
    expect(clientWidth).toHaveBeenCalledTimes(1);
    expect(setIsPromptTipOverflowing).toHaveBeenLastCalledWith(true);
  });
});
