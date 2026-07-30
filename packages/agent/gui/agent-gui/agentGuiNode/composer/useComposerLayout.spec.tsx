import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerLayout } from "./useComposerLayout";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useComposerLayout", () => {
  it("runs hero composer animations only while the AgentGUI window is active", () => {
    const promptTips = [
      { id: "tip-1", label: "First", prompt: "Prompt one" },
      { id: "tip-2", label: "Second", prompt: "Prompt two" }
    ];
    const { result, rerender } = renderHook(
      ({ isActive }) =>
        useComposerLayout(
          createComposerLayoutInput({
            isActive,
            isHeroLayout: true,
            promptTips
          })
        ),
      { initialProps: { isActive: false } }
    );

    expect(result.current.rotatingPromptTips).toEqual([promptTips[0]]);
    expect(result.current.promptTipStyle).toBeUndefined();
    expect(result.current.showEdgeGlow).toBe(false);

    rerender({ isActive: true });

    expect(result.current.rotatingPromptTips).toEqual([
      ...promptTips,
      promptTips[0]
    ]);
    expect(result.current.promptTipStyle).toMatchObject({
      "--agent-gui-prompt-tip-count": 2,
      "--agent-gui-prompt-tip-cycle-duration": "10400ms"
    });
    expect(result.current.showEdgeGlow).toBe(true);
  });

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

  it("consumes observed editor height without active geometry reads", () => {
    const resizeObservers: ResizeObserverMock[] = [];
    const animationFrames: FrameRequestCallback[] = [];
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
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const inputArea = document.createElement("div");
    const editor = document.createElement("div");
    editor.className = "agent-gui-node__composer-textarea";
    editor.style.paddingTop = "12px";
    inputArea.appendChild(editor);
    const editorScrollHeight = vi.spyOn(editor, "scrollHeight", "get");
    const editorRect = vi.spyOn(editor, "getBoundingClientRect");
    const getComputedStyle = vi.spyOn(window, "getComputedStyle");
    const setDockComposerMetrics = vi.fn();

    const input = createComposerLayoutInput({
      promptInputAreaRef: { current: inputArea },
      setDockComposerMetrics
    });

    renderHook(() => useComposerLayout(input));

    expect(editorScrollHeight).not.toHaveBeenCalled();
    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0]?.observed).toEqual(new Set([editor]));
    expect(animationFrames).toHaveLength(0);

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(editor, 100, 36)],
        resizeObservers[0]
      );
    });

    expect(editorScrollHeight).not.toHaveBeenCalled();
    expect(
      applyLastMetricsStateUpdate(setDockComposerMetrics, {
        attachmentHeight: 0,
        inputHeight: 56,
        inputMaxHeight: 110,
        textHeight: 56
      })
    ).toEqual({
      attachmentHeight: 0,
      inputHeight: 56,
      inputMaxHeight: 110,
      textHeight: 56
    });

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(editor, 100, 84)],
        resizeObservers[0]
      );
    });

    expect(
      applyLastMetricsStateUpdate(setDockComposerMetrics, {
        attachmentHeight: 0,
        inputHeight: 56,
        inputMaxHeight: 110,
        textHeight: 56
      }).inputHeight
    ).toBe(98);

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(editor, 100, 36)],
        resizeObservers[0]
      );
    });

    expect(
      applyLastMetricsStateUpdate(setDockComposerMetrics, {
        attachmentHeight: 0,
        inputHeight: 98,
        inputMaxHeight: 110,
        textHeight: 98
      }).inputHeight
    ).toBe(56);
    expect(editorScrollHeight).not.toHaveBeenCalled();
    expect(editorRect).not.toHaveBeenCalled();
    expect(getComputedStyle).not.toHaveBeenCalled();
  });

  it("does not observe the width host", () => {
    const resizeObservers: ResizeObserverMock[] = [];
    const animationFrames: FrameRequestCallback[] = [];
    class ResizeObserverMock implements ResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const inputShell = document.createElement("div");
    const inputArea = document.createElement("div");
    inputShell.appendChild(inputArea);

    renderHook(() =>
      useComposerLayout(
        createComposerLayoutInput({
          promptInputAreaRef: { current: inputArea }
        })
      )
    );
    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(inputShell, 600)],
        resizeObservers[0]
      );
    });
    expect(animationFrames).toHaveLength(0);

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(inputShell, 600)],
        resizeObservers[0]
      );
    });
    expect(animationFrames).toHaveLength(0);

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(inputShell, 540)],
        resizeObservers[0]
      );
    });
    expect(animationFrames).toHaveLength(0);
  });

  it("does not schedule geometry reads from continuing width observations", () => {
    const resizeObservers: ResizeObserverMock[] = [];
    const animationFrames: FrameRequestCallback[] = [];
    class ResizeObserverMock implements ResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const inputShell = document.createElement("div");
    const inputArea = document.createElement("div");
    const editor = document.createElement("div");
    editor.className = "agent-gui-node__composer-textarea";
    inputArea.appendChild(editor);
    inputShell.appendChild(inputArea);
    const editorScrollHeight = vi.spyOn(editor, "scrollHeight", "get");
    const editorRect = vi.spyOn(editor, "getBoundingClientRect");
    const getComputedStyle = vi.spyOn(window, "getComputedStyle");

    renderHook(() =>
      useComposerLayout(
        createComposerLayoutInput({
          promptInputAreaRef: { current: inputArea }
        })
      )
    );
    act(() => {
      animationFrames.shift()?.(0);
    });
    editorScrollHeight.mockClear();
    editorRect.mockClear();
    getComputedStyle.mockClear();

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(inputShell, 540)],
        resizeObservers[0]
      );
    });

    expect(animationFrames).toHaveLength(0);
    expect(editorScrollHeight).not.toHaveBeenCalled();
    expect(editorRect).not.toHaveBeenCalled();
    expect(getComputedStyle).not.toHaveBeenCalled();
  });
});

function applyLastMetricsStateUpdate(
  setter: ReturnType<typeof vi.fn>,
  value: ComposerLayoutInput["dockComposerMetrics"]
) {
  const update = setter.mock.calls.at(-1)?.[0] as
    | ComposerLayoutInput["dockComposerMetrics"]
    | ((
        current: ComposerLayoutInput["dockComposerMetrics"]
      ) => ComposerLayoutInput["dockComposerMetrics"])
    | undefined;
  if (typeof update === "function") {
    return update(value);
  }
  return update ?? value;
}

function createRect({ bottom, top }: { bottom: number; top: number }): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({})
  };
}

function createResizeObserverEntry(
  target: Element,
  width: number,
  height = 0
): ResizeObserverEntry {
  return {
    borderBoxSize: [],
    contentBoxSize: [],
    contentRect: {
      ...createRect({ bottom: height, top: 0 }),
      right: width,
      width
    },
    devicePixelContentBoxSize: [],
    target
  };
}

type ComposerLayoutInput = Parameters<typeof useComposerLayout>[0];

function createComposerLayoutInput(
  overrides: Partial<ComposerLayoutInput>
): ComposerLayoutInput {
  return {
    isActive: true,
    isHeroLayout: false,
    inputDisabled: false,
    projectMissingProbeEnabled: true,
    showFileMentionPalette: false,
    showFloatingCommandMenu: false,
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
    dockComposerMetrics: {
      attachmentHeight: 0,
      inputHeight: 56,
      inputMaxHeight: 110,
      textHeight: 56
    },
    setDockComposerMetrics: vi.fn(),
    draftImages: [],
    draftLargeTexts: [],
    ...overrides
  };
}
