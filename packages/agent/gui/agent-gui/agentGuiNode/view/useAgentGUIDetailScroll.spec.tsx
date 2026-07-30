import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject, RefObject } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type {
  AgentTranscriptViewportSnapshot,
  AgentTranscriptVirtualScrollController
} from "../../../shared/agentConversation/components/AgentTranscriptView";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import { useAgentGUIDetailScroll } from "./useAgentGUIDetailScroll";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAgentGUIDetailScroll", () => {
  it("starts a Session at the end and delegates explicit end requests", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );

    expect(controller.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 0,
      scrollHeight: 0,
      scrollTop: 0
    });
    controller.scrollToEnd.mockClear();

    act(() => result.current.scrollTimelineToBottom());

    expect(controller.scrollToEnd).toHaveBeenCalledWith({
      behavior: "smooth"
    });
    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 0,
      scrollHeight: 0,
      scrollTop: 0
    });
  });

  it("does not restore a detached position when entering a Session", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a", {
      snapshot: viewportSnapshot({
        distanceFromBottomPx: 2_900,
        scrollTopPx: 2_000
      })
    });
    harness.virtualScrollControllerRef.current = controller;

    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );

    expect(controller.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
    expect(result.current.followEndMode).toBe("following");
  });

  it("restores a reselected virtualized Session's detached scroll position", () => {
    const harness = createHarness();
    const firstController = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = firstController;
    const { result, rerender } = renderHook(
      ({ activeConversationId }) =>
        useAgentGUIDetailScroll(
          harness.input({ activeConversationId, showTimelineSkeleton: false })
        ),
      { initialProps: { activeConversationId: "conversation-a" } }
    );

    act(() => {
      firstController.emitUser("away");
      firstController.emit(
        viewportSnapshot({
          distanceFromBottomPx: 2_900,
          scrollTopPx: 2_000
        })
      );
    });
    expect(result.current.followEndMode).toBe("detached");

    const secondController = virtualScrollController("conversation-b");
    harness.virtualScrollControllerRef.current = secondController;
    rerender({ activeConversationId: "conversation-b" });
    expect(secondController.scrollToEnd).toHaveBeenCalledWith({
      behavior: "auto"
    });

    harness.virtualScrollControllerRef.current = firstController;
    firstController.scrollToEnd.mockClear();
    rerender({ activeConversationId: "conversation-a" });

    expect(firstController.scrollToOffset).toHaveBeenCalledWith(2_000, {
      behavior: "auto"
    });
    expect(firstController.scrollToEnd).not.toHaveBeenCalled();
  });

  it("shows the end control when follow intent is active but geometry is away from the end", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a", {
      snapshot: viewportSnapshot({
        distanceFromBottomPx: 2_900,
        scrollTopPx: 2_000
      })
    });
    harness.virtualScrollControllerRef.current = controller;

    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );

    expect(result.current.followEndMode).toBe("following");
    expect(result.current.isTimelineScrolledToBottom).toBe(false);
  });

  it("treats retained response-spacer distance as the visual end", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a", {
      snapshot: viewportSnapshot({
        contentDistanceFromBottomPx: 0,
        distanceFromBottomPx: 120
      })
    });
    harness.virtualScrollControllerRef.current = controller;

    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );

    expect(result.current.isTimelineScrolledToBottom).toBe(true);
  });

  it("does not use a previous Session controller", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-previous");
    harness.virtualScrollControllerRef.current = controller;
    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-current",
          showTimelineSkeleton: false
        })
      )
    );

    act(() => result.current.scrollTimelineToBottom());

    expect(controller.scrollToEnd).not.toHaveBeenCalled();
  });

  it("returns a submitted prompt to the end", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    const { rerender } = renderHook(
      ({ conversation }) =>
        useAgentGUIDetailScroll(
          harness.input({
            activeConversationId: "conversation-a",
            conversation,
            showTimelineSkeleton: false
          })
        ),
      { initialProps: { conversation: conversationVM("first") } }
    );
    controller.scrollToEnd.mockClear();
    harness.submittedPromptScrollConversationRef.current = "conversation-a";

    rerender({ conversation: conversationVM("second") });

    expect(controller.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it("does not install a second native scroll or timeline ResizeObserver", () => {
    const resizeObservers = installResizeObserverMock();
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    const addEventListener = vi.spyOn(harness.timeline, "addEventListener");

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );

    expect(
      addEventListener.mock.calls.some(([event]) => event === "scroll")
    ).toBe(false);
    expect(
      resizeObservers.some((observer) =>
        observer.observed.has(harness.timelineContent)
      )
    ).toBe(false);
    harness.resetGeometryReadCounts();
    act(() => {
      harness.timeline.dispatchEvent(new Event("scroll"));
    });
    expect(harness.geometryReadCounts()).toEqual({
      clientHeight: 0,
      scrollHeight: 0,
      scrollTop: 0
    });
  });

  it("loads older messages only after the scroll owner reaches the top", async () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          hasOlderMessages: true,
          showTimelineSkeleton: false
        })
      )
    );

    await act(async () => {
      controller.emitUser("away");
      controller.emit(
        viewportSnapshot({
          distanceFromBottomPx: 4_850,
          scrollTopPx: 50
        })
      );
      await controller.triggerTopLoading();
    });

    expect(harness.loadOlderConversationMessages).toHaveBeenCalledOnce();
    expect(harness.pendingPrependScrollAnchorRef.current).toEqual({
      conversationId: "conversation-a",
      scrollHeight: 5_000,
      scrollTop: 50
    });
  });

  it("stops top loading when the previous request did not commit a new viewport", async () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          hasOlderMessages: true,
          showTimelineSkeleton: false
        })
      )
    );
    act(() => {
      controller.emitUser("away");
      controller.emit(
        viewportSnapshot({
          distanceFromBottomPx: 4_850,
          scrollTopPx: 50
        })
      );
    });

    await act(async () => {
      expect(await controller.triggerTopLoading()).toBeUndefined();
      expect(await controller.triggerTopLoading()).toBe("stop");
      expect(await controller.triggerTopLoading()).toBeUndefined();
    });

    expect(harness.loadOlderConversationMessages).toHaveBeenCalledTimes(2);
  });

  it("allows another top page after the committed content height advances", async () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          hasOlderMessages: true,
          showTimelineSkeleton: false
        })
      )
    );
    act(() => {
      controller.emitUser("away");
      controller.emit(
        viewportSnapshot({
          contentHeightPx: 5_000,
          distanceFromBottomPx: 4_850,
          scrollTopPx: 50
        })
      );
    });
    await act(async () => {
      await controller.triggerTopLoading();
    });
    act(() => {
      controller.emit(
        viewportSnapshot({
          contentHeightPx: 7_000,
          distanceFromBottomPx: 6_850,
          scrollTopPx: 50
        })
      );
    });

    await act(async () => {
      expect(await controller.triggerTopLoading()).toBeUndefined();
    });

    expect(harness.loadOlderConversationMessages).toHaveBeenCalledTimes(2);
  });

  it("reattaches only after user intent reaches the end", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );

    act(() => {
      controller.emitUser("away");
      controller.emit(
        viewportSnapshot({
          distanceFromBottomPx: 2_900,
          scrollTopPx: 2_000
        })
      );
    });
    act(() => {
      controller.emit(viewportSnapshot({ distanceFromBottomPx: 24 }));
    });
    expect(result.current.followEndMode).toBe("detached");

    act(() => {
      controller.emitUser("toward-end");
      controller.emit(viewportSnapshot({ distanceFromBottomPx: 24.01 }));
    });
    expect(result.current.followEndMode).toBe("detached");

    act(() => {
      controller.emit(viewportSnapshot({ distanceFromBottomPx: 24 }));
    });
    expect(result.current.followEndMode).toBe("following");
  });

  it("uses controller-owned pointer direction to detach", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );

    act(() => {
      controller.emitUser("away");
    });

    expect(controller.cancelScroll).toHaveBeenCalledOnce();
    expect(result.current.followEndMode).toBe("detached");
  });

  it("uses controller-owned touch direction before the browser scroll event", () => {
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    const { result } = renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );

    act(() => {
      controller.emitUser("away");
    });

    expect(controller.cancelScroll).toHaveBeenCalledOnce();
    expect(result.current.followEndMode).toBe("detached");
  });

  it("routes dock safe-area changes through cached controller geometry", () => {
    const resizeObservers = installResizeObserverMock();
    const harness = createHarness();
    const controller = virtualScrollController("conversation-a");
    harness.virtualScrollControllerRef.current = controller;
    const liftedChrome = document.createElement("div");
    harness.bottomDock.appendChild(liftedChrome);
    harness.bottomDock.getBoundingClientRect = vi.fn(() =>
      mockRect({ bottom: 500, height: 100, top: 400, width: 600 })
    );
    liftedChrome.getBoundingClientRect = vi.fn(() =>
      mockRect({ bottom: 500, height: 50, top: 350, width: 600 })
    );

    renderHook(() =>
      useAgentGUIDetailScroll(
        harness.input({
          activeConversationId: "conversation-a",
          showTimelineSkeleton: false
        })
      )
    );
    expect(controller.syncViewport).toHaveBeenLastCalledWith({
      followEnd: true,
      scrollPaddingBottomAdjustmentPx: 50
    });
    controller.syncViewport.mockClear();
    const dockObserver = resizeObservers.find((observer) =>
      observer.observed.has(harness.bottomDock)
    );

    act(() => {
      controller.emitUser("away");
      dockObserver?.callback([], dockObserver);
    });

    expect(controller.syncViewport).toHaveBeenLastCalledWith({
      followEnd: false,
      scrollPaddingBottomAdjustmentPx: 50
    });
  });

  it("disconnects dock observation while hidden", () => {
    const resizeObservers = installResizeObserverMock();
    const harness = createHarness();
    harness.virtualScrollControllerRef.current =
      virtualScrollController("conversation-a");
    const { rerender } = renderHook(
      ({ isVisible }) =>
        useAgentGUIDetailScroll(
          harness.input({
            activeConversationId: "conversation-a",
            isVisible,
            showTimelineSkeleton: false
          })
        ),
      { initialProps: { isVisible: true } }
    );
    const dockObserver = resizeObservers.find((observer) =>
      observer.observed.has(harness.bottomDock)
    );
    expect(dockObserver).toBeDefined();

    rerender({ isVisible: false });

    expect(dockObserver?.observed.size).toBe(0);
  });
});

function createHarness() {
  const timeline = document.createElement("div");
  const timelineContent = document.createElement("div");
  const bottomDock = document.createElement("div");
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
        return 5_000;
      }
    },
    scrollTop: {
      configurable: true,
      get: () => {
        scrollTopReadCount += 1;
        return 4_900;
      },
      set: () => {}
    }
  });
  const timelineScrollAnchorRef = mutableRef<{
    clientHeight: number;
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const pendingPrependScrollAnchorRef = mutableRef<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const submittedPromptScrollConversationRef = mutableRef<string | null>(null);
  const virtualScrollControllerRef =
    mutableRef<AgentTranscriptVirtualScrollController | null>(null);
  const loadOlderConversationMessages = vi.fn();
  const actions = {
    loadOlderConversationMessages
  } as unknown as AgentGUINodeViewProps["actions"];

  return {
    bottomDock,
    loadOlderConversationMessages,
    pendingPrependScrollAnchorRef,
    submittedPromptScrollConversationRef,
    timeline,
    timelineContent,
    virtualScrollControllerRef,
    geometryReadCounts: () => ({
      clientHeight: clientHeightReadCount,
      scrollHeight: scrollHeightReadCount,
      scrollTop: scrollTopReadCount
    }),
    resetGeometryReadCounts() {
      clientHeightReadCount = 0;
      scrollHeightReadCount = 0;
      scrollTopReadCount = 0;
    },
    input(options: {
      activeConversationId: string;
      bottomDockStoreRevision?: string;
      conversation?: AgentConversationVM;
      hasOlderMessages?: boolean;
      isLoadingOlderMessages?: boolean;
      isVisible?: boolean;
      showTimelineSkeleton: boolean;
      timelineConversationId?: string | null;
    }) {
      return {
        actions,
        bottomDockRef: ref(bottomDock),
        bottomDockStoreRevision: options.bottomDockStoreRevision ?? "stable",
        conversation: options.conversation ?? null,
        isVisible: options.isVisible ?? true,
        pendingPrependScrollAnchorRef,
        showTimelineSkeleton: options.showTimelineSkeleton,
        submittedPromptScrollConversationRef,
        timelineConversationId:
          options.timelineConversationId === undefined
            ? options.activeConversationId
            : options.timelineConversationId,
        timelineRef: ref(timeline),
        timelineScrollAnchorRef,
        virtualScrollControllerRef,
        viewModel: viewModel(
          options.activeConversationId,
          options.hasOlderMessages,
          options.isLoadingOlderMessages
        )
      };
    }
  };
}

interface TestVirtualScrollController extends AgentTranscriptVirtualScrollController {
  cancelScroll: Mock<() => void>;
  emit(snapshot: AgentTranscriptViewportSnapshot): void;
  emitUser(direction: "away" | "toward-end"): void;
  triggerTopLoading(): Promise<"stop" | void>;
  scrollToEnd: Mock<(options?: { behavior?: ScrollBehavior }) => void>;
  scrollToOffset: Mock<
    (offset: number, options?: { behavior?: ScrollBehavior }) => void
  >;
  syncViewport: Mock<
    (options: {
      followEnd: boolean;
      scrollPaddingBottomAdjustmentPx?: number;
    }) => void
  >;
}

function virtualScrollController(
  agentSessionId: string,
  options: {
    snapshot?: AgentTranscriptViewportSnapshot;
  } = {}
): TestVirtualScrollController {
  const listeners = new Set<
    (snapshot: AgentTranscriptViewportSnapshot) => void
  >();
  const userScrollListeners = new Set<
    (direction: "away" | "toward-end") => void
  >();
  let snapshot = options.snapshot ?? viewportSnapshot();
  let topLoadingHandler: (() => Promise<"stop" | void>) | null = null;
  const controller: TestVirtualScrollController = {
    agentSessionId,
    cancelScroll: vi.fn(),
    emit(nextSnapshot) {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener(snapshot);
    },
    emitUser(direction) {
      controller.cancelScroll();
      for (const listener of userScrollListeners) listener(direction);
    },
    enabled: true,
    isAtEnd: vi.fn(
      (threshold = 24) => snapshot.distanceFromBottomPx <= threshold
    ),
    scrollToEnd: vi.fn(),
    scrollToOffset: vi.fn(),
    setTopLoadingHandler: vi.fn((handler) => {
      topLoadingHandler = handler;
    }),
    subscribeUserScroll: vi.fn((listener) => {
      userScrollListeners.add(listener);
      return () => userScrollListeners.delete(listener);
    }),
    subscribeViewport: vi.fn((listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    }),
    syncViewport: vi.fn(),
    triggerTopLoading: () => topLoadingHandler?.() ?? Promise.resolve("stop")
  };
  return controller;
}

function viewportSnapshot(
  overrides: Partial<AgentTranscriptViewportSnapshot> = {}
): AgentTranscriptViewportSnapshot {
  return {
    contentHeightPx: 5_000,
    contentDistanceFromBottomPx: overrides.distanceFromBottomPx ?? 0,
    distanceFromBottomPx: 0,
    scrollPaddingBottomPx: 0,
    scrollPaddingTopPx: 0,
    scrollTopPx: 4_900,
    viewportHeightPx: 100,
    ...overrides
  };
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

function mockRect(input: {
  bottom: number;
  height: number;
  top: number;
  width: number;
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

function conversationVM(id: string): AgentConversationVM {
  return { id } as unknown as AgentConversationVM;
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
