import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerLayout } from "./useComposerLayout";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useComposerLayout", () => {
  it("does not probe a locked project while its session is still being created", () => {
    const { result } = renderHook(() =>
      useComposerLayout(
        createComposerLayoutInput({
          projectMissingProbeEnabled: false,
          composerSettings: {
            ...createComposerLayoutInput({}).composerSettings,
            projectLocked: true
          },
          selectedProjectPath: "/workspace/project"
        })
      )
    );

    expect(result.current.showProjectMissingProbe).toBe(false);
  });

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
      useComposerLayout(
        createComposerLayoutInput({
          isHeroLayout: true,
          promptTips: [{ id: "tip-1", label: "Label", prompt: "Prompt" }],
          promptTipRef: { current: promptTip },
          setIsPromptTipOverflowing
        })
      )
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

  it("measures dock content only after ResizeObserver delivers layout", () => {
    const resizeObservers: ResizeObserverMock[] = [];
    class ResizeObserverMock implements ResizeObserver {
      readonly observed = new Set<Element>();

      constructor(readonly callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }

      observe(target: Element): void {
        this.observed.add(target);
      }

      unobserve(target: Element): void {
        this.observed.delete(target);
      }

      disconnect(): void {
        this.observed.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const inputArea = document.createElement("div");
    const editor = document.createElement("div");
    editor.className = "agent-gui-node__composer-textarea";
    inputArea.appendChild(editor);
    const editorScrollHeight = vi
      .spyOn(editor, "scrollHeight", "get")
      .mockReturnValue(48);
    const inputAreaScrollHeight = vi
      .spyOn(inputArea, "scrollHeight", "get")
      .mockReturnValue(74);
    const setDockComposerInputHeight = vi.fn();
    const setDockComposerInputMaxHeight = vi.fn();
    const setDockComposerAttachmentHeight = vi.fn();
    const setDockComposerTextHeight = vi.fn();

    const input = createComposerLayoutInput({
      promptInputAreaRef: { current: inputArea },
      setDockComposerInputHeight,
      setDockComposerInputMaxHeight,
      setDockComposerAttachmentHeight,
      setDockComposerTextHeight
    });

    const rendered = renderHook(
      ({ paletteOpen }) =>
        useComposerLayout({
          ...input,
          showFileMentionPalette: paletteOpen
        }),
      { initialProps: { paletteOpen: false } }
    );

    expect(editorScrollHeight).not.toHaveBeenCalled();
    expect(inputAreaScrollHeight).not.toHaveBeenCalled();
    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0]?.observed).toEqual(new Set([inputArea, editor]));

    act(() => {
      resizeObservers[0]?.callback([], resizeObservers[0]);
    });

    expect(editorScrollHeight).toHaveBeenCalledTimes(1);
    expect(inputAreaScrollHeight).toHaveBeenCalledTimes(1);
    expect(applyLastNumericStateUpdate(setDockComposerInputHeight, 56)).toBe(
      76
    );
    expect(
      applyLastNumericStateUpdate(setDockComposerInputMaxHeight, 110)
    ).toBe(110);
    expect(
      applyLastNumericStateUpdate(setDockComposerAttachmentHeight, 0)
    ).toBe(0);
    expect(applyLastNumericStateUpdate(setDockComposerTextHeight, 56)).toBe(62);

    editorScrollHeight.mockClear();
    inputAreaScrollHeight.mockClear();
    rendered.rerender({ paletteOpen: true });

    expect(editorScrollHeight).not.toHaveBeenCalled();
    expect(inputAreaScrollHeight).not.toHaveBeenCalled();
    expect(resizeObservers).toHaveLength(1);
  });
});

function applyLastNumericStateUpdate(
  setter: ReturnType<typeof vi.fn>,
  value: number
) {
  const update = setter.mock.calls.at(-1)?.[0] as
    | number
    | ((current: number) => number)
    | undefined;
  if (typeof update === "function") {
    return update(value);
  }
  return update;
}

type ComposerLayoutInput = Parameters<typeof useComposerLayout>[0];

function createComposerLayoutInput(
  overrides: Partial<ComposerLayoutInput>
): ComposerLayoutInput {
  return {
    isHeroLayout: false,
    inputDisabled: false,
    projectMissingProbeEnabled: true,
    showFileMentionPalette: false,
    showFloatingCommandMenu: false,
    previewMode: false,
    promptTips: [],
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
    promptTipRef: { current: null },
    promptInputAreaRef: { current: null },
    setIsPromptTipOverflowing: vi.fn(),
    dockComposerInputHeight: 56,
    setDockComposerInputHeight: vi.fn(),
    dockComposerInputMaxHeight: 110,
    setDockComposerInputMaxHeight: vi.fn(),
    dockComposerAttachmentHeight: 0,
    setDockComposerAttachmentHeight: vi.fn(),
    dockComposerTextHeight: 56,
    setDockComposerTextHeight: vi.fn(),
    draftImages: [],
    draftLargeTexts: [],
    ...overrides
  };
}
