import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsibleReveal } from "./CollapsibleReveal";

describe("CollapsibleReveal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts collapsed first, then expands on the next frame for push animation", async () => {
    let scheduledFrame: FrameRequestCallback | null = null;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 42
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined
    );

    const { rerender } = render(
      <CollapsibleReveal expanded={false}>
        <div>detail content</div>
      </CollapsibleReveal>
    );

    expect(screen.queryByText("detail content")).toBeNull();

    rerender(
      <CollapsibleReveal expanded>
        <div>detail content</div>
      </CollapsibleReveal>
    );

    expect(screen.queryByText("detail content")).toBeNull();

    act(() => {
      scheduledFrame?.(8);
    });

    const reveal = screen
      .getByText("detail content")
      .closest(".agent-collapsible-reveal");
    expect(reveal).toHaveAttribute("data-expanded", "false");
    expect(reveal).toHaveStyle({ height: "0px" });

    act(() => {
      scheduledFrame?.(16);
    });

    expect(reveal).toHaveAttribute("data-expanded", "true");
    expect(reveal).toHaveStyle({ height: "42px" });
    fireEvent.transitionEnd(reveal as HTMLElement, { propertyName: "height" });
    await waitFor(() => expect(reveal).toHaveStyle({ height: "auto" }));

    rerender(
      <CollapsibleReveal expanded={false}>
        <div>detail content</div>
      </CollapsibleReveal>
    );

    expect(reveal).toHaveAttribute("data-expanded", "false");
    expect(reveal).toHaveStyle({ height: "42px" });
    act(() => {
      scheduledFrame?.(32);
    });
    expect(reveal).toHaveStyle({ height: "0px" });
    fireEvent.transitionEnd(reveal as HTMLElement, { propertyName: "height" });

    expect(screen.queryByText("detail content")).toBeNull();
  });

  it("pre-mounts collapsed content on idle without starting the reveal animation", () => {
    let idleCallback: IdleRequestCallback | null = null;
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", () => undefined);
    vi.spyOn(window, "requestAnimationFrame");

    render(
      <CollapsibleReveal expanded={false} preMountOnIdle>
        <div>detail content</div>
      </CollapsibleReveal>
    );

    expect(screen.queryByText("detail content")).toBeNull();

    act(() => {
      idleCallback?.({
        didTimeout: false,
        timeRemaining: () => 50
      });
    });

    const reveal = screen
      .getByText("detail content")
      .closest(".agent-collapsible-reveal");
    expect(reveal).toHaveAttribute("data-expanded", "false");
    expect(reveal).toHaveAttribute("aria-hidden", "true");
    expect(reveal).toHaveStyle({ height: "0px" });
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("collapses pre-mounted content without re-reading a stale layout height", async () => {
    let scheduledFrame: FrameRequestCallback | null = null;
    let scrollHeightReads = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return 42;
      }
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined
    );

    const { rerender } = render(
      <CollapsibleReveal expanded={false} preMountOnIdle>
        <div>detail content</div>
      </CollapsibleReveal>
    );

    rerender(
      <CollapsibleReveal expanded preMountOnIdle>
        <div>detail content</div>
      </CollapsibleReveal>
    );

    act(() => {
      scheduledFrame?.(8);
    });

    const reveal = screen
      .getByText("detail content")
      .closest(".agent-collapsible-reveal");
    act(() => {
      scheduledFrame?.(16);
    });

    expect(reveal).toHaveStyle({ height: "42px" });
    const readsAfterExpansion = scrollHeightReads;
    expect(readsAfterExpansion).toBeGreaterThan(0);

    fireEvent.transitionEnd(reveal as HTMLElement, { propertyName: "height" });
    await waitFor(() => expect(reveal).toHaveStyle({ height: "auto" }));

    rerender(
      <CollapsibleReveal expanded={false} preMountOnIdle>
        <div>detail content</div>
      </CollapsibleReveal>
    );

    expect(reveal).toHaveStyle({ height: "42px" });
    expect(scrollHeightReads).toBe(readsAfterExpansion);
    act(() => {
      scheduledFrame?.(32);
    });
    expect(reveal).toHaveStyle({ height: "0px" });
    fireEvent.transitionEnd(reveal as HTMLElement, { propertyName: "height" });
    expect(screen.getByText("detail content")).toBeInTheDocument();
  });

  it("tracks resize updates at auto height without animating and collapses from the latest size", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn().mockImplementation(function ResizeObserverMock(
        callback: ResizeObserverCallback
      ) {
        resizeCallback = callback;
        return { observe, disconnect };
      })
    );
    vi.spyOn(window, "requestAnimationFrame");

    const { rerender } = render(
      <CollapsibleReveal expanded>
        <div>streaming detail content</div>
      </CollapsibleReveal>
    );

    const reveal = screen
      .getByText("streaming detail content")
      .closest(".agent-collapsible-reveal");
    const inner = reveal?.querySelector(".agent-collapsible-reveal__inner");
    Object.defineProperty(inner as Element, "scrollHeight", {
      configurable: true,
      value: 84
    });

    expect(reveal).toHaveStyle({ height: "auto" });
    expect(observe).toHaveBeenCalled();

    act(() => {
      resizeCallback?.(
        [
          {
            contentRect: { height: 84 }
          } as ResizeObserverEntry
        ],
        {} as ResizeObserver
      );
    });

    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(reveal).toHaveStyle({ height: "auto" });

    rerender(
      <CollapsibleReveal expanded={false}>
        <div>streaming detail content</div>
      </CollapsibleReveal>
    );

    expect(reveal).toHaveStyle({ height: "84px" });
  });

  it("reports a collapsing height transition once when content unmounts", () => {
    const onHeightTransitionEnd = vi.fn();
    const { rerender } = render(
      <CollapsibleReveal expanded onHeightTransitionEnd={onHeightTransitionEnd}>
        <div>detail content</div>
      </CollapsibleReveal>
    );
    const reveal = screen
      .getByText("detail content")
      .closest(".agent-collapsible-reveal");

    rerender(
      <CollapsibleReveal
        expanded={false}
        onHeightTransitionEnd={onHeightTransitionEnd}
      >
        <div>detail content</div>
      </CollapsibleReveal>
    );
    fireEvent.transitionEnd(reveal as HTMLElement, { propertyName: "height" });

    expect(onHeightTransitionEnd).toHaveBeenCalledTimes(1);
  });

  it("reports an expansion canceled before its mount frame", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const onHeightTransitionEnd = vi.fn();
    const { rerender } = render(
      <CollapsibleReveal
        expanded={false}
        onHeightTransitionEnd={onHeightTransitionEnd}
      >
        <div>detail content</div>
      </CollapsibleReveal>
    );

    rerender(
      <CollapsibleReveal expanded onHeightTransitionEnd={onHeightTransitionEnd}>
        <div>detail content</div>
      </CollapsibleReveal>
    );
    rerender(
      <CollapsibleReveal
        expanded={false}
        onHeightTransitionEnd={onHeightTransitionEnd}
      >
        <div>detail content</div>
      </CollapsibleReveal>
    );

    expect(onHeightTransitionEnd).toHaveBeenCalledTimes(1);
  });
});
