import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerLayout } from "./useComposerLayout";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useComposerLayout", () => {
  it("keeps embedded drafts in normal flow without dock measurement styles", () => {
    const { result } = renderHook(() =>
      useComposerLayout(
        createComposerLayoutInput({
          dockComposerMetrics: {
            attachmentHeight: 72,
            inputHeight: 152,
            inputMaxHeight: 182,
            textHeight: 56
          },
          isDockLayout: false,
          isHeroLayout: false
        })
      )
    );

    expect(result.current.composerStyle).toBeUndefined();
    expect(result.current.promptInputAreaStyle).toBeUndefined();
    expect(result.current.showProjectRow).toBe(false);
  });

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

  it("coalesces content invalidations and does not observe animated heights", () => {
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
    const inputShell = document.createElement("div");
    const inputArea = document.createElement("div");
    const editor = document.createElement("div");
    editor.className = "agent-gui-node__composer-textarea";
    editor.style.paddingTop = "12px";
    const firstParagraph = document.createElement("p");
    const lastParagraph = document.createElement("p");
    editor.append(firstParagraph, lastParagraph);
    inputArea.appendChild(editor);
    inputShell.appendChild(inputArea);
    let contentHeight = 24;
    vi.spyOn(firstParagraph, "getBoundingClientRect").mockImplementation(() =>
      createRect({ bottom: 24, top: 0 })
    );
    vi.spyOn(lastParagraph, "getBoundingClientRect").mockImplementation(() =>
      createRect({ bottom: contentHeight, top: contentHeight - 24 })
    );
    const editorScrollHeight = vi.spyOn(editor, "scrollHeight", "get");
    const setDockComposerMetrics = vi.fn();

    const input = createComposerLayoutInput({
      promptInputAreaRef: { current: inputArea },
      setDockComposerMetrics
    });

    const rendered = renderHook(() => useComposerLayout(input));

    expect(editorScrollHeight).not.toHaveBeenCalled();
    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0]?.observed).toEqual(new Set([inputShell]));
    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(0);
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

    contentHeight = 72;
    act(() => {
      rendered.result.current.invalidateComposerMeasurement();
      rendered.result.current.invalidateComposerMeasurement();
    });

    expect(animationFrames).toHaveLength(2);

    act(() => {
      animationFrames[1]?.(16);
    });

    expect(
      applyLastMetricsStateUpdate(setDockComposerMetrics, {
        attachmentHeight: 0,
        inputHeight: 56,
        inputMaxHeight: 110,
        textHeight: 56
      }).inputHeight
    ).toBe(98);

    contentHeight = 24;
    act(() => {
      rendered.result.current.invalidateComposerMeasurement();
    });
    expect(animationFrames).toHaveLength(3);

    act(() => {
      animationFrames[2]?.(32);
    });

    expect(
      applyLastMetricsStateUpdate(setDockComposerMetrics, {
        attachmentHeight: 0,
        inputHeight: 98,
        inputMaxHeight: 110,
        textHeight: 98
      }).inputHeight
    ).toBe(56);
  });

  it("remeasures only when the stable host width changes", () => {
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
      animationFrames[0]?.(0);
    });

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(inputShell, 600)],
        resizeObservers[0]
      );
    });
    expect(animationFrames).toHaveLength(2);
    act(() => {
      animationFrames[1]?.(16);
    });

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(inputShell, 600)],
        resizeObservers[0]
      );
    });
    expect(animationFrames).toHaveLength(2);

    act(() => {
      resizeObservers[0]?.callback(
        [createResizeObserverEntry(inputShell, 540)],
        resizeObservers[0]
      );
    });
    expect(animationFrames).toHaveLength(3);
  });

  it("measures mixed draft attachments as one dock grid row", () => {
    const animationFrames: FrameRequestCallback[] = [];
    const observed = new Set<Element>();
    class ResizeObserverMock implements ResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) {}

      observe(target: Element): void {
        observed.add(target);
      }

      unobserve(target: Element): void {
        observed.delete(target);
      }

      disconnect(): void {
        observed.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const inputShell = document.createElement("div");
    const inputArea = document.createElement("div");
    const attachmentDrafts = document.createElement("div");
    attachmentDrafts.dataset.testid = "agent-gui-composer-attachment-drafts";
    const quoteDrafts = document.createElement("div");
    quoteDrafts.dataset.testid = "agent-gui-composer-quote-drafts";
    const imageDrafts = document.createElement("div");
    imageDrafts.dataset.testid = "agent-gui-composer-image-drafts";
    attachmentDrafts.append(quoteDrafts, imageDrafts);
    vi.spyOn(attachmentDrafts, "scrollHeight", "get").mockReturnValue(84);
    const editor = document.createElement("div");
    editor.className = "agent-gui-node__composer-textarea";
    const paragraph = document.createElement("p");
    editor.appendChild(paragraph);
    vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue(
      createRect({ bottom: 24, top: 0 })
    );
    inputArea.append(attachmentDrafts, editor);
    inputShell.appendChild(inputArea);
    const setDockComposerMetrics = vi.fn();

    renderHook(() =>
      useComposerLayout(
        createComposerLayoutInput({
          draftQuoteCount: 1,
          promptInputAreaRef: { current: inputArea },
          setDockComposerMetrics
        })
      )
    );

    expect(inputArea.children).toHaveLength(2);
    expect(observed).toEqual(new Set([inputShell, attachmentDrafts]));
    act(() => animationFrames[0]?.(0));
    expect(
      applyLastMetricsStateUpdate(setDockComposerMetrics, {
        attachmentHeight: 0,
        inputHeight: 56,
        inputMaxHeight: 110,
        textHeight: 56
      })
    ).toEqual({
      attachmentHeight: 84,
      inputHeight: 164,
      inputMaxHeight: 218,
      textHeight: 56
    });
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
  width: number
): ResizeObserverEntry {
  return {
    borderBoxSize: [],
    contentBoxSize: [],
    contentRect: {
      ...createRect({ bottom: 0, top: 0 }),
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
  const isHeroLayout = overrides.isHeroLayout ?? false;
  return {
    isActive: true,
    isDockLayout: !isHeroLayout,
    isHeroLayout,
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
