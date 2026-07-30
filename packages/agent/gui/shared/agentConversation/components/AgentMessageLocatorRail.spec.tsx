import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessageLocatorItem } from "./agentTranscriptModel";
import {
  AgentMessageLocatorRail,
  type AgentMessageLocatorLocateOptions
} from "./AgentMessageLocatorRail";
import { useAgentTranscriptLocateOperation } from "./useAgentTranscriptLocateOperation";

class TestIntersectionObserver implements IntersectionObserver {
  static current: TestIntersectionObserver | null = null;
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  private readonly callback: IntersectionObserverCallback;
  private readonly targets = new Set<Element>();

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    this.callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    TestIntersectionObserver.current = this;
  }

  disconnect(): void {
    this.targets.clear();
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  emit(intersectingKeys: ReadonlySet<string>): void {
    const entries = [...this.targets].map((target) => {
      const element = target as HTMLElement;
      return {
        isIntersecting: intersectingKeys.has(
          element.dataset.agentMessageLocatorKey ??
            element.dataset.testLocatorKey ??
            ""
        ),
        target
      } as IntersectionObserverEntry;
    });
    this.callback(entries, this as IntersectionObserver);
  }
}

class TestMutationObserver implements MutationObserver {
  disconnect(): void {}
  observe(): void {}
  takeRecords(): MutationRecord[] {
    return [];
  }
}

const ITEMS: readonly AgentMessageLocatorItem[] = Array.from(
  { length: 4 },
  (_, index) => ({
    hasAgentResponse: true,
    key: `message-${index + 1}`,
    rowIndex: index,
    rowKey: `row-${index + 1}`,
    summary: `Message ${index + 1}`,
    turnGroupIndex: index
  })
);
const MANY_ITEMS: readonly AgentMessageLocatorItem[] = Array.from(
  { length: 24 },
  (_, index) => ({
    hasAgentResponse: true,
    key: `many-message-${index + 1}`,
    rowIndex: index,
    rowKey: `many-row-${index + 1}`,
    summary: `Many message ${index + 1}`,
    turnGroupIndex: index
  })
);
const VIEWPORT_SOURCE = {
  subscribeViewport(
    listener: Parameters<
      ComponentProps<
        typeof AgentMessageLocatorRail
      >["viewportSource"]["subscribeViewport"]
    >[0]
  ) {
    listener({
      contentHeightPx: 1_000,
      contentDistanceFromBottomPx: 0,
      distanceFromBottomPx: 0,
      scrollPaddingBottomPx: 0,
      scrollPaddingTopPx: 0,
      scrollTopPx: 0,
      viewportHeightPx: 600
    });
    return () => {};
  }
};

beforeEach(() => {
  TestIntersectionObserver.current = null;
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  vi.stubGlobal("MutationObserver", TestMutationObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentMessageLocatorRail", () => {
  it("stays hidden until history is complete and two messages exist", () => {
    const onLocate = vi.fn();
    const { rerender } = renderRail({
      items: ITEMS.slice(0, 1),
      onLocate
    });
    expect(screen.queryByTestId("agent-message-locator")).toBeNull();

    rerender(
      <RailHarness
        items={ITEMS}
        isConversationHistoryComplete={false}
        onLocate={onLocate}
      />
    );
    expect(screen.queryByTestId("agent-message-locator")).toBeNull();

    rerender(
      <RailHarness
        items={ITEMS.slice(0, 1)}
        isConversationHistoryComplete
        onLocate={onLocate}
      />
    );
    expect(screen.queryByTestId("agent-message-locator")).toBeNull();

    rerender(
      <RailHarness
        items={ITEMS.slice(0, 2)}
        isConversationHistoryComplete
        onLocate={onLocate}
      />
    );
    expect(screen.getByTestId("agent-message-locator")).toBeTruthy();
  });

  it("marks the contiguous range between visible messages", () => {
    renderRail({ items: ITEMS, onLocate: vi.fn() });

    act(() => {
      TestIntersectionObserver.current?.emit(
        new Set(["message-1", "message-3"])
      );
    });

    const ticks = screen
      .getByTestId("agent-message-locator")
      .querySelectorAll(".agent-gui-message-locator__tick");
    expect(ticks[0]).toHaveAttribute("aria-current", "true");
    expect(ticks[1]).toHaveAttribute("aria-current", "true");
    expect(ticks[2]).toHaveAttribute("aria-current", "true");
    expect(ticks[3]).not.toHaveAttribute("aria-current");
  });

  it("uses the first visible Turn as the active dot", () => {
    renderRail({ items: ITEMS, onLocate: vi.fn() });

    act(() => {
      TestIntersectionObserver.current?.emit(
        new Set(["message-1", "message-2", "message-3"])
      );
    });

    const ticks = screen
      .getByTestId("agent-message-locator")
      .querySelectorAll(".agent-gui-message-locator__tick");
    expect(ticks[0]).toHaveAttribute("data-active", "true");
    expect(ticks[1]).not.toHaveAttribute("data-active");

    act(() => {
      TestIntersectionObserver.current?.emit(new Set(["message-3"]));
    });
    expect(ticks[0]).not.toHaveAttribute("data-active");
    expect(ticks[2]).toHaveAttribute("data-active", "true");
  });

  it("does not let hover selection override the visible Turn", () => {
    renderRail({ items: ITEMS, onLocate: vi.fn() });

    act(() => {
      TestIntersectionObserver.current?.emit(new Set(["message-1"]));
    });

    const ticks = screen
      .getByTestId("agent-message-locator")
      .querySelectorAll(".agent-gui-message-locator__tick");
    fireEvent.mouseEnter(ticks[1]!);

    expect(ticks[0]).toHaveAttribute("data-active", "true");
    expect(ticks[1]).not.toHaveAttribute("data-active");
  });

  it("does not pull the locator viewport back to the selected message on hover", () => {
    renderRail({ items: MANY_ITEMS, onLocate: vi.fn() });

    act(() => {
      TestIntersectionObserver.current?.emit(new Set(["many-message-2"]));
    });

    const locator = screen.getByTestId("agent-message-locator");
    const viewport = screen.getByTestId("agent-message-locator-viewport");
    const ticks = locator.querySelectorAll<HTMLElement>(
      ".agent-gui-message-locator__tick"
    );
    viewport.scrollTop = 64;

    fireEvent.mouseEnter(ticks[10]!);

    expect(viewport.scrollTop).toBe(64);
  });

  it("keeps the previous active Turn across a virtualized empty frame", () => {
    renderRail({ items: ITEMS, onLocate: vi.fn() });

    act(() => {
      TestIntersectionObserver.current?.emit(new Set(["message-1"]));
    });

    const ticks = screen
      .getByTestId("agent-message-locator")
      .querySelectorAll(".agent-gui-message-locator__tick");
    expect(ticks[0]).toHaveAttribute("data-active", "true");

    act(() => {
      TestIntersectionObserver.current?.emit(new Set());
    });

    expect(ticks[0]).toHaveAttribute("data-active", "true");
    expect(ticks[3]).not.toHaveAttribute("data-active");
  });

  it("does not connect a visible mounted message to an unmounted last message", () => {
    render(
      <RailHarness
        items={ITEMS}
        mountedItems={ITEMS.slice(0, 1)}
        onLocate={vi.fn()}
      />
    );

    act(() => {
      TestIntersectionObserver.current?.emit(new Set(["message-1"]));
    });

    const ticks = screen
      .getByTestId("agent-message-locator")
      .querySelectorAll(".agent-gui-message-locator__tick");
    expect(ticks[0]).toHaveAttribute("aria-current", "true");
    expect(ticks[1]).not.toHaveAttribute("aria-current");
    expect(ticks[2]).not.toHaveAttribute("aria-current");
    expect(ticks[3]).not.toHaveAttribute("aria-current");
  });

  it("observes each user message independently inside one virtual turn", () => {
    render(
      <div ref={setTimelineGeometry} data-testid="agent-gui-timeline">
        <RailWithOperation items={ITEMS} onLocate={vi.fn()} />
        <div
          ref={setContentGeometry}
          data-agent-transcript-virtual-turn="turn-1"
        >
          {ITEMS.slice(0, 2).map((item) => (
            <div key={item.key} data-agent-message-locator-key={item.key} />
          ))}
        </div>
      </div>
    );

    act(() => {
      TestIntersectionObserver.current?.emit(new Set(["message-2"]));
    });

    const ticks = screen
      .getByTestId("agent-message-locator")
      .querySelectorAll(".agent-gui-message-locator__tick");
    expect(ticks[0]).not.toHaveAttribute("aria-current");
    expect(ticks[1]).toHaveAttribute("aria-current", "true");
  });

  it("uses Alt+Arrow keys to locate the next mounted message at the top", () => {
    const onLocate = vi.fn();
    renderRail({ items: ITEMS, onLocate });
    const timeline = screen.getByTestId("agent-gui-timeline");
    timeline.getBoundingClientRect = () => rect(0);
    const rows = ITEMS.map((item) =>
      timeline.querySelector<HTMLElement>(
        `[data-agent-message-locator-key="${item.key}"]`
      )
    );
    rows.forEach((row, index) => {
      if (row) row.getBoundingClientRect = () => rect(index * 100);
    });

    fireEvent.keyDown(timeline, { altKey: true, key: "ArrowDown" });

    expect(onLocate).not.toHaveBeenCalled();
    expect(rows[1]?.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });
  });

  it("routes Alt+Arrow only to the timeline containing the event target", () => {
    const firstLocate = vi.fn();
    const secondLocate = vi.fn();
    render(
      <>
        <RailHarness items={ITEMS} onLocate={firstLocate} />
        <RailHarness items={ITEMS} onLocate={secondLocate} />
      </>
    );
    const timelines = screen.getAllByTestId("agent-gui-timeline");
    timelines.forEach((timeline) => {
      timeline.getBoundingClientRect = () => rect(0);
      timeline
        .querySelectorAll<HTMLElement>("[data-agent-message-locator-key]")
        .forEach((row, index) => {
          row.getBoundingClientRect = () => rect(index * 100);
        });
    });

    fireEvent.keyDown(timelines[1]!, {
      altKey: true,
      key: "ArrowDown"
    });

    expect(firstLocate).not.toHaveBeenCalled();
    expect(secondLocate).not.toHaveBeenCalled();
    const secondTimelineRows = timelines[1]!.querySelectorAll<HTMLElement>(
      "[data-agent-message-locator-key]"
    );
    expect(secondTimelineRows[1]?.scrollIntoView).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { altKey: true, key: "ArrowDown" });
    expect(firstLocate).not.toHaveBeenCalled();
    expect(secondLocate).not.toHaveBeenCalled();
    const firstTimelineRows = timelines[0]!.querySelectorAll<HTMLElement>(
      "[data-agent-message-locator-key]"
    );
    expect(firstTimelineRows[1]?.scrollIntoView).toHaveBeenCalledOnce();
    expect(secondTimelineRows[1]?.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("reveals an unmounted keyboard target, waits for its DOM, then scrolls it natively", async () => {
    const revealedTarget: { current: HTMLElement | null } = { current: null };
    const onLocate = vi.fn((item: AgentMessageLocatorItem) => {
      const target = document.createElement("div");
      target.dataset.agentMessageLocatorKey = item.key;
      target.scrollIntoView = vi.fn();
      screen.getByTestId("agent-gui-timeline").append(target);
      revealedTarget.current = target;
      return Promise.resolve(target);
    });
    render(<RailHarness items={ITEMS} mountedItems={[]} onLocate={onLocate} />);
    const timeline = screen.getByTestId("agent-gui-timeline");

    fireEvent.keyDown(timeline, { altKey: true, key: "ArrowDown" });
    await act(async () => undefined);

    expect(onLocate).toHaveBeenCalledWith(
      ITEMS[0],
      expect.objectContaining({
        align: "top",
        behavior: "smooth",
        signal: expect.any(AbortSignal)
      })
    );
    expect(revealedTarget.current?.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });
  });

  it("scrolls a mounted click target natively without revealing it again", async () => {
    const onLocate = vi.fn();
    renderRail({ items: ITEMS, onLocate });
    const timeline = screen.getByTestId("agent-gui-timeline");
    timeline.scrollTop = -200;
    const target = timeline.querySelector<HTMLElement>(
      '[data-agent-message-locator-key="message-2"]'
    );

    fireEvent.click(screen.getByRole("button", { name: "Message 2" }));
    await act(async () => undefined);

    expect(onLocate).not.toHaveBeenCalled();
    expect(target?.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });
    expect(timeline.scrollTop).toBe(-200);
  });

  it("reveals an unmounted click target without smooth virtual scrolling", async () => {
    const onLocate = vi.fn(() => Promise.resolve(null));
    render(<RailHarness items={ITEMS} mountedItems={[]} onLocate={onLocate} />);

    fireEvent.click(screen.getByRole("button", { name: "Message 1" }));
    await act(async () => undefined);

    expect(onLocate).toHaveBeenCalledWith(
      ITEMS[0],
      expect.objectContaining({
        align: "top",
        behavior: "auto",
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("defers mounting the rail until the browser is idle", () => {
    let idleCallback: IdleRequestCallback | null = null;
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallback = callback;
        return 7;
      })
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    renderRail({ items: ITEMS, onLocate: vi.fn() });
    expect(screen.queryByTestId("agent-message-locator")).toBeNull();

    act(() => {
      idleCallback?.({
        didTimeout: false,
        timeRemaining: () => 10
      });
    });
    expect(screen.getByTestId("agent-message-locator")).toBeTruthy();
  });

  it("scrubs locator items with instant top-aligned locating", () => {
    const onLocate = vi.fn();
    renderRail({ items: ITEMS, onLocate });
    const viewport = screen.getByTestId("agent-message-locator-viewport");
    viewport.getBoundingClientRect = () => rect(0, 126);
    viewport.scrollTop = 0;
    const buttons = viewport.querySelectorAll<HTMLElement>(
      "[data-agent-message-locator-item-key]"
    );
    buttons.forEach((button) => {
      Object.assign(button, {
        hasPointerCapture: vi.fn(() => true),
        releasePointerCapture: vi.fn(),
        setPointerCapture: vi.fn()
      });
    });
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => buttons[2] ?? null);

    try {
      fireEvent.pointerDown(buttons[0]!, {
        button: 0,
        buttons: 1,
        clientY: 5,
        pointerId: 1
      });
      expect(onLocate).not.toHaveBeenCalled();
      expect(buttons[0]).toHaveAttribute("data-scrub-target", "true");
      viewport.scrollTop = 60;
      act(() => {
        TestIntersectionObserver.current?.emit(new Set(["message-1"]));
      });
      expect(viewport.scrollTop).toBe(60);
      fireEvent.pointerMove(viewport, {
        buttons: 1,
        clientY: 25,
        pointerId: 1
      });
      fireEvent.pointerUp(viewport, { clientY: 25, pointerId: 1 });
      expect(viewport.scrollTop).toBe(0);

      expect(onLocate).not.toHaveBeenCalled();
      const transcriptTarget = screen
        .getByTestId("agent-gui-timeline")
        .querySelector<HTMLElement>(
          '[data-agent-message-locator-key="message-3"]'
        );
      expect(transcriptTarget?.scrollIntoView).toHaveBeenCalledWith({
        behavior: "instant",
        block: "start"
      });
      expect(buttons[2]).not.toHaveAttribute("data-scrub-target");
    } finally {
      document.elementFromPoint = originalElementFromPoint;
    }
  });

  it("cancels stale locate results and keeps only the latest operation", async () => {
    const pending = new Map<
      string,
      {
        resolve: (element: HTMLElement | null) => void;
        signal: AbortSignal;
      }
    >();
    const onLocate = vi.fn(
      (
        item: AgentMessageLocatorItem,
        options?: AgentMessageLocatorLocateOptions
      ) =>
        new Promise<HTMLElement | null>((resolve) => {
          pending.set(item.key, {
            resolve,
            signal: options?.signal as AbortSignal
          });
        })
    );
    render(<RailHarness items={ITEMS} mountedItems={[]} onLocate={onLocate} />);
    const buttons = screen
      .getByTestId("agent-message-locator")
      .querySelectorAll<HTMLElement>("[data-agent-message-locator-item-key]");

    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(pending.get("message-1")?.signal.aborted).toBe(true);

    await act(async () => {
      pending.get("message-2")?.resolve(null);
      pending.get("message-1")?.resolve(null);
    });
    expect(onLocate).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending locate when the timeline becomes hidden", () => {
    let signal: AbortSignal | undefined;
    const onLocate = vi.fn(
      (
        _item: AgentMessageLocatorItem,
        options?: AgentMessageLocatorLocateOptions
      ) => {
        signal = options?.signal;
        return new Promise<HTMLElement | null>(() => {});
      }
    );
    const rendered = render(
      <RailHarness
        items={ITEMS}
        isVisible
        mountedItems={[]}
        onLocate={onLocate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Message 1" }));
    expect(signal?.aborted).toBe(false);

    rendered.rerender(
      <RailHarness
        items={ITEMS}
        isVisible={false}
        mountedItems={[]}
        onLocate={onLocate}
      />
    );

    expect(signal?.aborted).toBe(true);
  });

  it("highlights a revealed target once after locating resolves", async () => {
    const target = document.createElement("div");
    target.dataset.agentMessageLocatorKey = ITEMS[0]!.key;
    const bubble = document.createElement("div");
    bubble.className = "agent-gui-conversation__user-message-bubble";
    bubble.animate = vi.fn();
    target.scrollIntoView = vi.fn();
    target.append(bubble);
    target.getBoundingClientRect = () => rect(200);
    const onLocate = vi.fn(() => {
      screen.getByTestId("agent-gui-timeline").append(target);
      return Promise.resolve(target);
    });
    render(<RailHarness items={ITEMS} mountedItems={[]} onLocate={onLocate} />);
    fireEvent.click(screen.getByRole("button", { name: "Message 1" }));
    await act(async () => undefined);

    expect(bubble.animate).toHaveBeenCalledOnce();
  });

  it("expands the complete message list without letting hover move the active dot", () => {
    renderRail({ items: ITEMS, onLocate: vi.fn() });
    act(() => {
      TestIntersectionObserver.current?.emit(new Set(["message-1"]));
    });
    const locator = screen.getByTestId("agent-message-locator");
    fireEvent.mouseEnter(locator);

    const panel = screen.getByTestId("agent-message-locator-panel");
    expect(
      panel.querySelectorAll(".agent-gui-message-locator__panel-item")
    ).toHaveLength(ITEMS.length);
    const panelItems = panel.querySelectorAll<HTMLElement>(
      ".agent-gui-message-locator__panel-item"
    );
    const dots = locator.querySelectorAll<HTMLElement>(
      ".agent-gui-message-locator__tick"
    );

    fireEvent.mouseEnter(panelItems[2]!);
    expect(panelItems[2]).toHaveAttribute("data-active", "true");
    expect(panelItems[2]).not.toHaveAttribute("data-selected");
    expect(panelItems[0]).toHaveAttribute("data-selected", "true");
    expect(panelItems[0]).toHaveAttribute("aria-current", "true");
    expect(dots[0]).toHaveAttribute("data-active", "true");
    expect(dots[2]).not.toHaveAttribute("data-active");

    fireEvent.mouseEnter(dots[1]!);
    expect(panelItems[1]).toHaveAttribute("data-active", "true");
    expect(dots[0]).toHaveAttribute("data-active", "true");
    expect(dots[1]).not.toHaveAttribute("data-active");
  });

  it("waits 120ms after leaving the rail and list before collapsing", () => {
    vi.useFakeTimers();
    try {
      renderRail({ items: ITEMS, onLocate: vi.fn() });
      const locator = screen.getByTestId("agent-message-locator");
      fireEvent.mouseEnter(locator);
      const panel = screen.getByTestId("agent-message-locator-panel");
      expect(panel).toHaveAttribute("data-open", "true");

      fireEvent.mouseLeave(locator);
      act(() => vi.advanceTimersByTime(119));
      expect(panel).toHaveAttribute("data-open", "true");
      act(() => vi.advanceTimersByTime(1));
      expect(panel).not.toHaveAttribute("data-open");
    } finally {
      vi.useRealTimers();
    }
  });
});

function renderRail({
  items,
  onLocate
}: {
  items: readonly AgentMessageLocatorItem[];
  onLocate: (
    item: AgentMessageLocatorItem,
    options?: AgentMessageLocatorLocateOptions
  ) => void | Promise<HTMLElement | null>;
}) {
  return render(<RailHarness items={items} onLocate={onLocate} />);
}

function RailHarness({
  isConversationHistoryComplete = true,
  isVisible = true,
  items,
  mountedItems = items,
  onLocate
}: {
  isConversationHistoryComplete?: boolean;
  isVisible?: boolean;
  items: readonly AgentMessageLocatorItem[];
  mountedItems?: readonly AgentMessageLocatorItem[];
  onLocate: (
    item: AgentMessageLocatorItem,
    options?: AgentMessageLocatorLocateOptions
  ) => void | Promise<HTMLElement | null>;
}) {
  const locateOperation = useAgentTranscriptLocateOperation(isVisible);
  return (
    <div ref={setTimelineGeometry} data-testid="agent-gui-timeline">
      <AgentMessageLocatorRail
        isConversationHistoryComplete={isConversationHistoryComplete}
        isVisible={isVisible}
        items={items}
        locateOperation={locateOperation}
        onLocate={onLocate}
        viewportSource={VIEWPORT_SOURCE}
      />
      <div ref={setContentGeometry}>
        {mountedItems.map((item) => (
          <div
            key={item.key}
            data-agent-transcript-virtual-turn
            data-test-locator-key={item.key}
          >
            <div
              ref={(element) => {
                if (element) element.scrollIntoView = vi.fn();
              }}
              data-agent-message-locator-key={item.key}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function RailWithOperation({
  items,
  onLocate
}: {
  items: readonly AgentMessageLocatorItem[];
  onLocate: (
    item: AgentMessageLocatorItem,
    options?: AgentMessageLocatorLocateOptions
  ) => void | Promise<HTMLElement | null>;
}) {
  const locateOperation = useAgentTranscriptLocateOperation(true);
  return (
    <AgentMessageLocatorRail
      items={items}
      locateOperation={locateOperation}
      onLocate={onLocate}
      viewportSource={VIEWPORT_SOURCE}
    />
  );
}

function rect(top: number, height = 40): DOMRect {
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
  };
}

function setTimelineGeometry(element: HTMLDivElement | null): void {
  if (!element) return;
  Object.defineProperty(element, "offsetWidth", {
    configurable: true,
    value: 1_000
  });
  element.getBoundingClientRect = () => rectWithWidth(0, 1_000);
}

function setContentGeometry(element: HTMLDivElement | null): void {
  if (!element) return;
  Object.defineProperty(element, "offsetWidth", {
    configurable: true,
    value: 900
  });
  element.getBoundingClientRect = () => rectWithWidth(0, 900);
}

function rectWithWidth(top: number, width: number): DOMRect {
  return {
    ...rect(top),
    right: width,
    width
  } as DOMRect;
}
