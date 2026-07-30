import { act, renderHook } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasActiveAgentTranscriptScroll,
  setAgentTranscriptScrollTop
} from "./agentTranscriptScrollController";
import { useAgentTranscriptLayoutPreservation } from "./useAgentTranscriptLayoutPreservation";
import {
  useAgentTranscriptVirtualizer,
  type AgentTranscriptViewportSnapshot,
  type AgentTranscriptVirtualScrollController
} from "./useAgentTranscriptVirtualizer";

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  disconnect(): void {
    this.observed.clear();
  }
  observe(target: Element): void {
    this.observed.add(target);
  }
  unobserve(target: Element): void {
    this.observed.delete(target);
  }
  emit(target: Element, height: number): void {
    this.callback(
      [
        {
          borderBoxSize: [
            { blockSize: height, inlineSize: 0 } as ResizeObserverSize
          ],
          contentBoxSize: [],
          contentRect: { height } as DOMRectReadOnly,
          devicePixelContentBoxSize: [],
          target
        } as ResizeObserverEntry
      ],
      this
    );
  }
}

describe("useAgentTranscriptVirtualizer", () => {
  beforeEach(() => {
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cancels a pending scrollToKey mount wait immediately", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(performance, "now").mockReturnValue(0);
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-cancel",
        entries: [{ gapAfterPx: 0, key: "turn-1" }]
      })
    );
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
    });
    const abortController = new AbortController();

    const targetPromise = result.current.rowVirtualizer.scrollToKey(
      "turn-1",
      () => null,
      { signal: abortController.signal }
    );
    expect(animationFrames).toHaveLength(1);
    abortController.abort();

    await expect(targetPromise).resolves.toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("stops waiting when the virtualizer host disconnects", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(performance, "now").mockReturnValue(0);
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-disconnect",
        entries: [{ gapAfterPx: 0, key: "turn-1" }]
      })
    );
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
    });

    const targetPromise = result.current.rowVirtualizer.scrollToKey(
      "turn-1",
      () => null
    );
    host.remove();
    act(() => animationFrames.shift()?.(16));

    await expect(targetPromise).resolves.toBeNull();
    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("finishes scrollToKey with exact mounted-target alignment", async () => {
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    const target = document.createElement("div");
    host.append(target);
    timeline.append(host);
    document.body.append(timeline);
    timeline.getBoundingClientRect = () => rect(0, 480);
    target.getBoundingClientRect = () => rect(-120 - timeline.scrollTop, 40);
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-exact-locate",
        entries: [{ gapAfterPx: 0, key: "turn-1" }]
      })
    );
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
    });

    await act(async () => {
      await result.current.rowVirtualizer.scrollToKey("turn-1", () => target, {
        align: "top",
        behavior: "auto"
      });
    });

    expect(timeline.scrollTop).toBe(-120);
    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("builds the rendered range from the scrollTop accepted by the browser", () => {
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    let actualScrollTop = 0;
    Object.defineProperty(timeline, "scrollTop", {
      configurable: true,
      get: () => actualScrollTop,
      set: (next: number) => {
        actualScrollTop = Math.max(-7_000, Math.min(0, next));
      }
    });
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    const entries = Array.from({ length: 120 }, (_, index) => ({
      gapAfterPx: 0,
      key: `turn-${index}`
    }));
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-clamped-scroll",
        entries,
        virtualScrollControllerRef: controller
      })
    );
    let snapshot = null as AgentTranscriptViewportSnapshot | null;
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
      controller.current?.subscribeViewport((next) => {
        snapshot = next;
      });
      result.current.rowVirtualizer.scrollToIndex(0, {
        align: "top",
        behavior: "auto"
      });
    });

    expect(actualScrollTop).toBe(-7_000);
    expect(snapshot?.distanceFromBottomPx).toBe(7_000);
    expect(
      result.current.rowVirtualizer
        .getVirtualItems()
        .some((item) => item.key === "turn-0")
    ).toBe(false);

    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("publishes exact scrolling without rerendering a stable virtual window", () => {
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    const entries = Array.from({ length: 120 }, (_, index) => ({
      gapAfterPx: 0,
      key: `turn-${index}`
    }));
    let renderCount = 0;
    const { result, unmount } = renderHook(() => {
      renderCount += 1;
      return useAgentTranscriptVirtualizer({
        agentSessionId: "session-stable-scroll-window",
        entries,
        virtualScrollControllerRef: controller
      });
    });
    let snapshot = null as AgentTranscriptViewportSnapshot | null;
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
      controller.current?.subscribeViewport((next) => {
        snapshot = next;
      });
    });
    const connectedRenderCount = renderCount;
    const initialTurnKeys = result.current.virtualItems.map((item) => item.key);

    act(() => {
      timeline.scrollTop = -10;
      timeline.dispatchEvent(new Event("scroll"));
    });

    expect(snapshot?.distanceFromBottomPx).toBe(10);
    expect(renderCount).toBe(connectedRenderCount);
    expect(result.current.virtualItems.map((item) => item.key)).toEqual(
      initialTurnKeys
    );

    act(() => {
      timeline.scrollTop = -2_000;
      timeline.dispatchEvent(new Event("scroll"));
    });

    expect(snapshot?.distanceFromBottomPx).toBe(2_000);
    expect(renderCount).toBeGreaterThan(connectedRenderCount);
    expect(result.current.virtualItems.map((item) => item.key)).not.toEqual(
      initialTurnKeys
    );

    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("keeps the rendered window on stable turn keys during a prepend render", () => {
    const baseEntries = Array.from({ length: 20 }, (_, index) => ({
      gapAfterPx: 0,
      key: `turn-${index}`
    }));
    const { result, rerender, unmount } = renderHook(
      ({ entries }) =>
        useAgentTranscriptVirtualizer({
          agentSessionId: "session-prepend-projection",
          entries
        }),
      { initialProps: { entries: baseEntries } }
    );
    const firstRenderedKey = result.current.virtualItems[0]?.key;

    rerender({
      entries: [{ gapAfterPx: 0, key: "older" }, ...baseEntries]
    });

    expect(result.current.virtualItems[0]?.key).toBe(firstRenderedKey);
    unmount();
  });

  it("publishes measured height, layout, and rendered items in one commit", async () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      gapAfterPx: 0,
      key: `turn-${index}`
    }));
    const element = document.createElement("div");
    element.dataset.agentTranscriptVirtualTurn = "turn-5";
    vi.spyOn(element, "offsetHeight", "get").mockReturnValue(500);
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-measurement-commit",
        entries
      })
    );

    act(() => {
      result.current.rowVirtualizer.measureElement("turn-5", element);
      result.current.rowVirtualizer.syncMeasurements();
    });

    expect(result.current.totalHeightPx).toBe(5 * 280 + 500);
    expect(
      result.current.virtualItems.find((item) => item.key === "turn-5")
    ).toMatchObject({ measured: true, size: 500 });
    unmount();
  });

  it.each([
    {
      expectedScrollTop: -120,
      followEndMode: "following" as const,
      initialScrollTop: 0,
      isLatestTurnInProgress: true
    },
    {
      expectedScrollTop: -420,
      followEndMode: "detached" as const,
      initialScrollTop: -300,
      isLatestTurnInProgress: false
    }
  ])(
    "uses Codex measurement compensation while $followEndMode",
    async ({
      expectedScrollTop,
      followEndMode,
      initialScrollTop,
      isLatestTurnInProgress
    }) => {
      const timeline = document.createElement("div");
      timeline.style.scrollPaddingBottom = "120px";
      const host = document.createElement("div");
      const latestTurn = document.createElement("div");
      latestTurn.dataset.agentTranscriptVirtualTurn = "turn-1";
      host.append(latestTurn);
      timeline.append(host);
      document.body.append(timeline);
      let latestTurnHeight = 280;
      vi.spyOn(latestTurn, "offsetHeight", "get").mockImplementation(
        () => latestTurnHeight
      );
      latestTurn.getBoundingClientRect = () =>
        rect(
          100 - (latestTurnHeight - 280) - timeline.scrollTop,
          latestTurnHeight
        );
      const { result, unmount } = renderHook(() =>
        useAgentTranscriptVirtualizer({
          agentSessionId: `session-measurement-${followEndMode}`,
          entries: [
            { gapAfterPx: 0, key: "turn-0" },
            { gapAfterPx: 0, key: "turn-1" }
          ],
          followEndMode,
          isLatestTurnInProgress,
          latestTurnKey: "turn-1"
        })
      );
      act(() => {
        result.current.setVirtualizerHostElement(host);
        result.current.rowVirtualizer.connectScrollElement(timeline);
        result.current.rowVirtualizer.measureElement("turn-1", latestTurn);
        result.current.rowVirtualizer.syncMeasurements();
      });
      if (initialScrollTop !== 0) {
        act(() => {
          timeline.dispatchEvent(
            new WheelEvent("wheel", { deltaY: initialScrollTop })
          );
          timeline.scrollTop = initialScrollTop;
          timeline.dispatchEvent(new Event("scroll"));
        });
      }
      const anchorTopBeforeExpansion = latestTurn.getBoundingClientRect().top;
      const turnObserver = TestResizeObserver.instances.find((observer) =>
        observer.observed.has(latestTurn)
      );

      act(() => {
        latestTurnHeight = 400;
        turnObserver?.emit(latestTurn, latestTurnHeight);
      });
      await act(async () => Promise.resolve());
      act(() => result.current.rowVirtualizer.syncLayout());

      expect(timeline.scrollTop).toBe(expectedScrollTop);
      expect(latestTurn.getBoundingClientRect().top).toBe(
        anchorTopBeforeExpansion
      );
      act(() => result.current.setVirtualizerHostElement(null));
      unmount();
      timeline.remove();
    }
  );

  it("dismisses the response spacer until a new Session or Turn starts", async () => {
    const timeline = document.createElement("div");
    timeline.style.scrollPaddingBottom = "120px";
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    const { result, rerender, unmount } = renderHook(
      ({ agentSessionId, followEndMode, inProgress, turnKey }) =>
        useAgentTranscriptVirtualizer({
          agentSessionId,
          entries: [{ gapAfterPx: 0, key: turnKey }],
          followEndMode,
          isLatestTurnInProgress: inProgress,
          latestTurnKey: turnKey,
          virtualScrollControllerRef: controller
        }),
      {
        initialProps: {
          agentSessionId: "session-response-spacer",
          followEndMode: "following" as "detached" | "following",
          inProgress: true,
          turnKey: "turn-1"
        }
      }
    );

    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
    });
    await act(async () => Promise.resolve());

    expect(result.current.responseSpacerHeightPx).toBe(120);
    act(() => controller.current?.scrollToEnd());
    expect(result.current.responseSpacerHeightPx).toBe(0);
    act(() => controller.current?.syncViewport({ followEnd: true }));
    expect(result.current.responseSpacerHeightPx).toBe(0);

    rerender({
      agentSessionId: "session-next",
      followEndMode: "following",
      inProgress: true,
      turnKey: "turn-1"
    });
    act(() => controller.current?.syncViewport({ followEnd: true }));
    expect(result.current.responseSpacerHeightPx).toBe(120);
    act(() => controller.current?.scrollToEnd());
    expect(result.current.responseSpacerHeightPx).toBe(0);

    rerender({
      agentSessionId: "session-next",
      followEndMode: "following",
      inProgress: true,
      turnKey: "turn-2"
    });
    act(() => controller.current?.syncViewport({ followEnd: true }));
    expect(result.current.responseSpacerHeightPx).toBe(120);

    rerender({
      agentSessionId: "session-next",
      followEndMode: "following",
      inProgress: false,
      turnKey: "turn-2"
    });
    expect(result.current.responseSpacerHeightPx).toBe(120);
    act(() => controller.current?.scrollToEnd());
    expect(result.current.responseSpacerHeightPx).toBe(0);

    rerender({
      agentSessionId: "session-next",
      followEndMode: "detached",
      inProgress: true,
      turnKey: "turn-3"
    });
    act(() => controller.current?.scrollToEnd());
    expect(result.current.responseSpacerHeightPx).toBe(0);
    rerender({
      agentSessionId: "session-next",
      followEndMode: "following",
      inProgress: true,
      turnKey: "turn-3"
    });
    act(() => controller.current?.syncViewport({ followEnd: true }));
    expect(result.current.responseSpacerHeightPx).toBe(0);

    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("scrolls instantly while the latest Turn is running or a response spacer exists", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    const { result, rerender, unmount } = renderHook(
      ({ inProgress }) =>
        useAgentTranscriptVirtualizer({
          agentSessionId: "session-running-instant-end",
          entries: [{ gapAfterPx: 0, key: "turn-1" }],
          isLatestTurnInProgress: inProgress,
          latestTurnKey: "turn-1",
          virtualScrollControllerRef: controller
        }),
      { initialProps: { inProgress: true } }
    );
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
    });
    await act(async () => Promise.resolve());
    expect(result.current.responseSpacerHeightPx).toBeGreaterThan(0);

    rerender({ inProgress: false });
    timeline.scrollTop = -1_000;
    frames.length = 0;
    act(() => controller.current?.scrollToEnd({ behavior: "smooth" }));

    expect(frames).toHaveLength(0);
    expect(timeline.scrollTop).toBe(0);
    expect(result.current.responseSpacerHeightPx).toBe(0);

    rerender({ inProgress: true });
    timeline.scrollTop = -1_000;
    frames.length = 0;
    act(() => controller.current?.scrollToEnd({ behavior: "smooth" }));

    expect(frames).toHaveLength(0);
    expect(timeline.scrollTop).toBe(0);
    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("does not place a response spacer when opening settled session history", async () => {
    const timeline = document.createElement("div");
    timeline.style.scrollPaddingBottom = "120px";
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    const { result, rerender, unmount } = renderHook(
      ({ agentSessionId, inProgress }) =>
        useAgentTranscriptVirtualizer({
          agentSessionId,
          entries: [{ gapAfterPx: 0, key: "turn-1" }],
          isLatestTurnInProgress: inProgress,
          latestTurnKey: "turn-1"
        }),
      {
        initialProps: {
          agentSessionId: "session-running",
          inProgress: true
        }
      }
    );

    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
    });
    await act(async () => Promise.resolve());
    expect(result.current.responseSpacerHeightPx).toBe(120);

    rerender({
      agentSessionId: "session-settled",
      inProgress: false
    });
    expect(result.current.responseSpacerHeightPx).toBe(0);

    rerender({
      agentSessionId: "session-running",
      inProgress: false
    });
    expect(result.current.responseSpacerHeightPx).toBe(0);

    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("owns normalized user-scroll intent for the connected viewport", () => {
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    const input = document.createElement("input");
    timeline.append(host, input);
    document.body.append(timeline);
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      value: 1_200
    });
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    const listener = vi.fn();
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-user-intent",
        entries: [{ gapAfterPx: 0, key: "turn-1" }],
        virtualScrollControllerRef: controller
      })
    );
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
    });
    const unsubscribe = controller.current!.subscribeUserScroll(listener);

    act(() => {
      timeline.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: -1
        })
      );
      timeline.scrollTop = -100;
      timeline.dispatchEvent(new Event("scroll"));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" })
      );
      timeline.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "PageDown" })
      );
      timeline.scrollTop = -50;
      timeline.dispatchEvent(new Event("scroll"));
    });

    expect(listener.mock.calls).toEqual([["away"], ["toward-end"]]);
    unsubscribe();
    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("stops top loading after committed DOM content moves the viewport away", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    let scrollHeight = 520;
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    const loadOlder = vi.fn(async () => {
      scrollHeight = 1_200;
    });
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-top-loading",
        entries: Array.from({ length: 8 }, (_, index) => ({
          gapAfterPx: 0,
          key: `turn-${index}`
        })),
        virtualScrollControllerRef: controller
      })
    );
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
      controller.current?.setTopLoadingHandler(loadOlder);
      timeline.scrollTop = -40;
      timeline.dispatchEvent(new Event("scroll"));
      timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
    });
    await act(async () => {
      await Promise.resolve();
      animationFrames.shift()?.(16);
      await Promise.resolve();
    });

    expect(loadOlder).toHaveBeenCalledOnce();

    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it("finishes a smooth end scroll across newly measured virtual Turns", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    const measuredTurn = document.createElement("div");
    measuredTurn.dataset.agentTranscriptVirtualTurn = "turn-8";
    vi.spyOn(measuredTurn, "offsetHeight", "get").mockReturnValue(600);
    host.append(measuredTurn);
    timeline.append(host);
    document.body.append(timeline);
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-smooth-measurement",
        entries: Array.from({ length: 9 }, (_, index) => ({
          gapAfterPx: 12,
          key: `turn-${index}`
        })),
        virtualScrollControllerRef: controller
      })
    );
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
      timeline.scrollTop = -2_000;
      controller.current?.scrollToEnd({ behavior: "smooth" });
    });
    act(() => frames.shift()?.(130));
    expect(timeline.scrollTop).toBeGreaterThan(-2_000);
    expect(timeline.scrollTop).toBeLessThan(0);

    act(() => {
      result.current.rowVirtualizer.measureElement("turn-8", measuredTurn);
      result.current.rowVirtualizer.syncMeasurements();
    });
    act(() => result.current.rowVirtualizer.syncLayout());
    act(() => frames.shift()?.(260));

    expect(timeline.scrollTop).toBe(0);
    act(() => result.current.setVirtualizerHostElement(null));
    unmount();
    timeline.remove();
  });

  it.each(["resize", "syncViewport"] as const)(
    "does not let %s interrupt an active smooth end scroll",
    (interruption) => {
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(performance, "now").mockReturnValue(0);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frames.push(callback);
          return frames.length;
        }
      );
      const timeline = document.createElement("div");
      const host = document.createElement("div");
      timeline.append(host);
      document.body.append(timeline);
      const controller = createRef<AgentTranscriptVirtualScrollController>();
      const { result, unmount } = renderHook(() =>
        useAgentTranscriptVirtualizer({
          agentSessionId: `session-smooth-${interruption}`,
          entries: Array.from({ length: 9 }, (_, index) => ({
            gapAfterPx: 12,
            key: `turn-${index}`
          })),
          followEndMode: "detached",
          virtualScrollControllerRef: controller
        })
      );
      act(() => {
        result.current.setVirtualizerHostElement(host);
        result.current.rowVirtualizer.connectScrollElement(timeline);
        timeline.scrollTop = -2_000;
        controller.current?.scrollToEnd({ behavior: "smooth" });
      });
      act(() => frames.shift()?.(130));
      expect(timeline.scrollTop).toBeGreaterThan(-2_000);
      expect(timeline.scrollTop).toBeLessThan(0);

      act(() => {
        if (interruption === "resize") {
          const viewportObserver = TestResizeObserver.instances.find(
            (observer) => observer.observed.has(timeline)
          );
          viewportObserver?.emit(timeline, 520);
        } else {
          controller.current?.syncViewport({ followEnd: false });
        }
      });
      expect(hasActiveAgentTranscriptScroll(timeline)).toBe(true);
      act(() => frames.shift()?.(260));

      expect(timeline.scrollTop).toBe(0);
      act(() => result.current.setVirtualizerHostElement(null));
      unmount();
      timeline.remove();
    }
  );

  it("does not let pending layout preservation interrupt an active smooth scroll", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const timeline = document.createElement("div");
    let scrollHeight = 1_000;
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    timeline.scrollTop = -500;
    const scrollElementRef = {
      current: timeline
    } as RefObject<HTMLElement | null>;
    const scrollPaddingBottomRef = {
      current: 0
    } as RefObject<number>;
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptLayoutPreservation({
        getDistanceFromBottomPx: () => -timeline.scrollTop,
        scrollElementRef,
        scrollPaddingBottomRef
      })
    );
    act(() => result.current.preserveForNextLayout());
    act(() => setAgentTranscriptScrollTop(timeline, 0, "smooth"));
    scrollHeight = 1_200;

    let restoredDistance: number | null = null;
    act(() => {
      restoredDistance = result.current.restoreAfterScrollHeightChange();
    });

    expect(restoredDistance).toBeNull();
    expect(hasActiveAgentTranscriptScroll(timeline)).toBe(true);
    act(() => frames[1]?.(260));
    expect(timeline.scrollTop).toBe(0);
    unmount();
  });

  it("cancels an active smooth scroll when the viewport disconnects", async () => {
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(performance, "now").mockReturnValue(0);
    const timeline = document.createElement("div");
    const host = document.createElement("div");
    timeline.append(host);
    document.body.append(timeline);
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptVirtualizer({
        agentSessionId: "session-scroll-cleanup",
        entries: Array.from({ length: 4 }, (_, index) => ({
          gapAfterPx: 12,
          key: `turn-${index}`
        })),
        virtualScrollControllerRef: controller
      })
    );
    act(() => {
      result.current.setVirtualizerHostElement(host);
      result.current.rowVirtualizer.connectScrollElement(timeline);
      timeline.scrollTop = -400;
      controller.current?.scrollToEnd({ behavior: "smooth" });
    });
    expect(frames).toHaveLength(1);

    await act(async () => {
      result.current.setVirtualizerHostElement(null);
      await Promise.resolve();
    });

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    unmount();
    timeline.remove();
  });
});

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}
