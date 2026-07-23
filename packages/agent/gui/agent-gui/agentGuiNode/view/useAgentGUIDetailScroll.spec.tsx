import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, RefObject } from "react";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import { useAgentGUIDetailScroll } from "./useAgentGUIDetailScroll";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAgentGUIDetailScroll", () => {
  it("starts a newly selected conversation at the bottom", () => {
    const harness = createHarness({ scrollHeight: 5_000 });
    const { rerender } = renderHook(
      ({ activeConversationId }) =>
        useAgentGUIDetailScroll(
          harness.input({ activeConversationId, showTimelineSkeleton: false })
        ),
      { initialProps: { activeConversationId: "conversation-a" } }
    );

    expect(harness.timeline.scrollTop).toBe(4_900);
    act(() => {
      harness.timeline.scrollTop = 2_000;
      harness.timeline.dispatchEvent(new Event("scroll"));
    });
    expect(harness.timeline.scrollTop).toBe(2_000);

    harness.setScrollHeight(8_000);
    rerender({ activeConversationId: "conversation-b" });

    expect(harness.timeline.scrollTop).toBe(7_900);
  });

  it("reads timeline geometry once for a semantic conversation switch", () => {
    const harness = createHarness({ scrollHeight: 5_000 });
    const { rerender } = renderHook(
      ({ activeConversationId }) =>
        useAgentGUIDetailScroll(
          harness.input({ activeConversationId, showTimelineSkeleton: false })
        ),
      { initialProps: { activeConversationId: "conversation-a" } }
    );

    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 1,
      scrollHeight: 1,
      scrollTop: 0
    });

    harness.resetGeometryReadCounts();
    harness.setScrollHeight(8_000);
    rerender({ activeConversationId: "conversation-b" });

    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 1,
      scrollHeight: 1,
      scrollTop: 0
    });
  });

  it("does not scroll the retained previous timeline when selection changes", () => {
    const harness = createHarness({ scrollHeight: 5_000 });
    const { rerender } = renderHook(
      ({ activeConversationId, timelineConversationId }) =>
        useAgentGUIDetailScroll(
          harness.input({
            activeConversationId,
            showTimelineSkeleton: false,
            timelineConversationId
          })
        ),
      {
        initialProps: {
          activeConversationId: "conversation-a",
          timelineConversationId: "conversation-a"
        }
      }
    );

    act(() => {
      harness.timeline.scrollTop = 2_000;
      harness.timeline.dispatchEvent(new Event("scroll"));
    });
    rerender({
      activeConversationId: "conversation-b",
      timelineConversationId: "conversation-a"
    });
    expect(harness.timeline.scrollTop).toBe(2_000);

    harness.setScrollHeight(8_000);
    rerender({
      activeConversationId: "conversation-b",
      timelineConversationId: "conversation-b"
    });
    expect(harness.timeline.scrollTop).toBe(7_900);
  });

  it("does not let a skeleton-era bottom frame override newer user scroll", () => {
    const harness = createHarness({ scrollHeight: 100 });
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });

    const { rerender } = renderHook(
      ({ showTimelineSkeleton }) =>
        useAgentGUIDetailScroll(
          harness.input({
            activeConversationId: "conversation-long",
            showTimelineSkeleton
          })
        ),
      { initialProps: { showTimelineSkeleton: true } }
    );

    expect(animationFrames).toHaveLength(1);

    harness.setScrollHeight(5_000);
    rerender({ showTimelineSkeleton: false });
    expect(harness.timeline.scrollTop).toBe(4_900);

    act(() => {
      harness.timeline.scrollTop = 4_000;
      harness.timeline.dispatchEvent(new Event("scroll"));
    });
    act(() => animationFrames[0]?.(0));

    expect(harness.timeline.scrollTop).toBe(4_000);
  });

  it("keeps a newly selected conversation bottom-locked while layout grows", () => {
    const resizeObservers = installResizeObserverMock();
    const harness = createHarness({ scrollHeight: 100 });
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-growing",
          showTimelineSkeleton: true
        })
      )
    );

    const timelineObserver = resizeObservers.find((observer) =>
      observer.observed.has(harness.timelineContent)
    );
    expect(timelineObserver).toBeDefined();

    harness.setScrollHeight(5_000);
    act(() => {
      timelineObserver?.callback([], timelineObserver);
    });
    expect(harness.timeline.scrollTop).toBe(4_900);

    harness.resetGeometryReadCounts();
    act(() => animationFrames[0]?.(0));

    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 1,
      scrollHeight: 1,
      scrollTop: 0
    });
    expect(harness.timeline.scrollTop).toBe(4_900);
  });

  it("releases the bottom lock after the user scrolls upward", () => {
    const harness = createHarness({ scrollHeight: 5_000 });

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-user-scroll",
          showTimelineSkeleton: false
        })
      )
    );

    act(() => {
      harness.timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      harness.timeline.scrollTop = 4_000;
      harness.timeline.dispatchEvent(new Event("scroll"));
    });
    expect(harness.timeline.scrollTop).toBe(4_000);

    harness.setScrollHeight(6_000);
    act(() => {
      harness.timeline.dispatchEvent(new Event("scroll"));
    });

    expect(harness.timeline.scrollTop).toBe(4_000);
  });

  it("does not synchronously read full timeline geometry during scrolling", () => {
    const harness = createHarness({ scrollHeight: 5_000 });

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-scroll-hot-path",
          showTimelineSkeleton: false
        })
      )
    );
    harness.resetGeometryReadCounts();

    act(() => {
      harness.timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      harness.timeline.scrollTop = 4_000;
      harness.timeline.dispatchEvent(new Event("scroll"));
    });

    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 0,
      scrollHeight: 0,
      scrollTop: 1
    });
  });

  it("does not synchronously read timeline geometry for a streaming update", () => {
    const harness = createHarness({ scrollHeight: 5_000 });
    const { rerender } = renderHook(
      ({ conversation }) =>
        useAgentGUIDetailScroll(
          harness.input({
            activeConversationId: "conversation-streaming",
            conversation,
            showTimelineSkeleton: false
          })
        ),
      { initialProps: { conversation: conversationVM("first") } }
    );
    harness.resetGeometryReadCounts();

    rerender({ conversation: conversationVM("second") });

    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 0,
      scrollHeight: 0,
      scrollTop: 0
    });
  });

  it("prefetches older messages from the initialized anchor without rereading scrollTop", () => {
    const harness = createHarness({ scrollHeight: 100 });

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-prefetch",
          hasOlderMessages: true,
          showTimelineSkeleton: false
        })
      )
    );

    expect(harness.loadOlderConversationMessages).toHaveBeenCalledOnce();
    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 1,
      scrollHeight: 1,
      scrollTop: 0
    });
  });

  it("restores a prepend anchor from one timeline geometry snapshot", () => {
    const harness = createHarness({ scrollHeight: 5_000 });
    const { rerender } = renderHook(
      ({ isLoadingOlderMessages }) =>
        useAgentGUIDetailScroll(
          harness.input({
            activeConversationId: "conversation-prepend",
            isLoadingOlderMessages,
            showTimelineSkeleton: false
          })
        ),
      { initialProps: { isLoadingOlderMessages: false } }
    );

    act(() => {
      harness.timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      harness.timeline.scrollTop = 200;
      harness.timeline.dispatchEvent(new Event("scroll"));
    });
    harness.pendingPrependScrollAnchorRef.current = {
      conversationId: "conversation-prepend",
      scrollHeight: 5_000,
      scrollTop: 200
    };
    harness.setScrollHeight(6_000);
    harness.resetGeometryReadCounts();

    rerender({ isLoadingOlderMessages: true });

    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 1,
      scrollHeight: 1,
      scrollTop: 0
    });
    expect(harness.timeline.scrollTop).toBe(1_200);
  });

  it("reads timeline geometry once for an explicit scroll to bottom", () => {
    const harness = createHarness({ scrollHeight: 5_000 });
    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-scroll-bottom",
          showTimelineSkeleton: false
        })
      )
    );
    harness.timeline.scrollTop = 2_000;
    harness.resetGeometryReadCounts();

    act(() => result.current.scrollTimelineToBottom());

    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 1,
      scrollHeight: 1,
      scrollTop: 0
    });
    expect(harness.timeline.scrollTop).toBe(4_900);
  });

  it("keeps the bottom lock through observed streaming content growth", () => {
    const resizeObservers = installResizeObserverMock();
    const harness = createHarness({ scrollHeight: 5_000 });

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-observed",
          showTimelineSkeleton: false
        })
      )
    );
    const timelineObserver = resizeObservers.find((observer) =>
      observer.observed.has(harness.timelineContent)
    );
    expect(timelineObserver).toBeDefined();

    harness.setScrollHeight(6_000);
    act(() => {
      timelineObserver?.callback([], timelineObserver);
    });

    expect(harness.timeline.scrollTop).toBe(5_900);
  });

  it("preserves user scroll-away through observed streaming content growth", () => {
    const resizeObservers = installResizeObserverMock();
    const harness = createHarness({ scrollHeight: 5_000 });

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-observed-away",
          showTimelineSkeleton: false
        })
      )
    );
    const timelineObserver = resizeObservers.find((observer) =>
      observer.observed.has(harness.timelineContent)
    );
    expect(timelineObserver).toBeDefined();
    act(() => {
      harness.timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      harness.timeline.scrollTop = 4_000;
      harness.timeline.dispatchEvent(new Event("scroll"));
    });

    harness.setScrollHeight(6_000);
    act(() => {
      timelineObserver?.callback([], timelineObserver);
    });

    expect(harness.timeline.scrollTop).toBe(4_000);
  });

  it("moves floating dock controls above a growing composer without reserving timeline space", () => {
    const harness = createHarness({ scrollHeight: 5_000 });
    const composerInputShell = document.createElement("div");
    const promptInputArea = document.createElement("div");
    const clippedEditorContent = document.createElement("div");
    composerInputShell.className = "agent-gui-node__composer-input-shell";
    promptInputArea.className = "agent-gui-node__composer-prompt-input-area";
    promptInputArea.appendChild(clippedEditorContent);
    composerInputShell.appendChild(promptInputArea);
    harness.bottomDock.appendChild(composerInputShell);
    harness.bottomDock.getBoundingClientRect = vi.fn(() =>
      mockRect({ top: 400, bottom: 500, width: 600, height: 100 })
    );
    composerInputShell.getBoundingClientRect = vi.fn(() =>
      mockRect({ top: 320, bottom: 500, width: 600, height: 180 })
    );
    promptInputArea.getBoundingClientRect = vi.fn(() =>
      mockRect({ top: 320, bottom: 450, width: 600, height: 130 })
    );
    clippedEditorContent.getBoundingClientRect = vi.fn(() =>
      mockRect({ top: 240, bottom: 440, width: 560, height: 200 })
    );

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-growing-composer",
          showTimelineSkeleton: false
        })
      )
    );

    expect(
      harness.timeline.style.getPropertyValue(
        "--agent-gui-bottom-dock-safe-area"
      )
    ).toBe("0px");
    expect(
      harness.bottomDock.style.getPropertyValue(
        "--agent-gui-bottom-dock-floating-safe-area"
      )
    ).toBe("80px");
  });
});

function mockRect(input: {
  top: number;
  bottom: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    ...input,
    left: 0,
    right: input.width,
    x: 0,
    y: input.top,
    toJSON: () => ({})
  } as DOMRect;
}

function createHarness(input: { scrollHeight: number }) {
  const timeline = document.createElement("div");
  const timelineContent = document.createElement("div");
  const bottomDock = document.createElement("div");
  let scrollTop = 0;
  let scrollHeight = input.scrollHeight;
  let clientHeightReadCount = 0;
  let scrollHeightReadCount = 0;
  let scrollTopReadCount = 0;
  Object.defineProperties(timeline, {
    clientHeight: {
      configurable: true,
      get: () => {
        clientHeightReadCount += 1;
        return 100;
      }
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        scrollHeightReadCount += 1;
        return scrollHeight;
      }
    },
    scrollTop: {
      configurable: true,
      get: () => {
        scrollTopReadCount += 1;
        return scrollTop;
      },
      set: (value: number) => {
        scrollTop = value;
      }
    }
  });
  timeline.scrollTo = ((options: ScrollToOptions) => {
    scrollTop = options.top ?? scrollTop;
  }) as typeof timeline.scrollTo;

  const timelineScrollAnchorRef = mutableRef<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
  } | null>(null);
  const pendingPrependScrollAnchorRef = mutableRef<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const submittedPromptScrollConversationRef = mutableRef<string | null>(null);
  const loadOlderConversationMessages = vi.fn();
  const actions = {
    loadOlderConversationMessages
  } as unknown as AgentGUINodeViewProps["actions"];

  return {
    bottomDock,
    loadOlderConversationMessages,
    pendingPrependScrollAnchorRef,
    timeline,
    timelineContent,
    resetGeometryReadCounts() {
      clientHeightReadCount = 0;
      scrollHeightReadCount = 0;
      scrollTopReadCount = 0;
    },
    geometryReadCounts() {
      return {
        clientHeight: clientHeightReadCount,
        scrollHeight: scrollHeightReadCount,
        scrollTop: scrollTopReadCount
      };
    },
    setScrollHeight(value: number) {
      scrollHeight = value;
    },
    input(options: {
      activeConversationId: string;
      conversation?: AgentConversationVM;
      hasOlderMessages?: boolean;
      isLoadingOlderMessages?: boolean;
      showTimelineSkeleton: boolean;
      timelineConversationId?: string;
    }) {
      return {
        actions,
        bottomDockRef: ref(bottomDock),
        bottomDockStoreRevision: "stable",
        conversation: options.conversation ?? null,
        pendingPrependScrollAnchorRef,
        showTimelineSkeleton: options.showTimelineSkeleton,
        submittedPromptScrollConversationRef,
        timelineConversationId:
          options.timelineConversationId ?? options.activeConversationId,
        timelineContentRef: ref(timelineContent),
        timelineRef: ref(timeline),
        timelineScrollAnchorRef,
        viewModel: viewModel(
          options.activeConversationId,
          options.hasOlderMessages,
          options.isLoadingOlderMessages
        )
      };
    }
  };
}

function conversationVM(id: string): AgentConversationVM {
  return { id } as unknown as AgentConversationVM;
}

interface ResizeObserverMock extends ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed: Set<Element>;
}

function installResizeObserverMock(): ResizeObserverMock[] {
  const observers: ResizeObserverMock[] = [];
  class TestResizeObserver implements ResizeObserverMock {
    readonly observed = new Set<Element>();

    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
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
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  return observers;
}

function viewModel(
  activeConversationId: string,
  hasOlderMessages = false,
  isLoadingOlderMessages = false
): AgentGUINodeViewModel {
  return {
    rail: { activeConversationId },
    detail: {
      hasOlderMessages,
      isLoadingOlderMessages
    }
  } as unknown as AgentGUINodeViewModel;
}

function mutableRef<T>(current: T): MutableRefObject<T> {
  return { current };
}

function ref<T>(current: T): RefObject<T> {
  return { current };
}
