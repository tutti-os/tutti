import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentTranscriptDistanceFromBottom,
  agentTranscriptKeyboardScrollDirection,
  agentTranscriptNativeScrollTopForDistance,
  cancelAgentTranscriptScroll,
  connectAgentTranscriptScrollInput,
  normalizeAgentTranscriptWheelDelta,
  setAgentTranscriptScrollTop
} from "./agentTranscriptScrollController";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agentTranscriptScrollController", () => {
  it("uses the bottom-origin viewport's physical distance", () => {
    expect(agentTranscriptNativeScrollTopForDistance(0, 120)).toBe(0);
    expect(agentTranscriptNativeScrollTopForDistance(120, 120)).toBe(-120);
    expect(agentTranscriptDistanceFromBottom(0, 120)).toBe(0);
    expect(agentTranscriptDistanceFromBottom(-120, 120)).toBe(120);
  });

  it("runs a 260ms smooth scroll and lands exactly on the target", () => {
    const element = document.createElement("div");
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    setAgentTranscriptScrollTop(element, 260, "smooth");
    frames.shift()?.(130);
    expect(element.scrollTop).toBeGreaterThan(130);
    expect(element.scrollTop).toBeLessThan(260);
    frames.shift()?.(260);
    expect(element.scrollTop).toBe(260);
  });

  it("preserves negative scrollTop for a bottom-origin viewport", () => {
    const element = document.createElement("div");

    setAgentTranscriptScrollTop(element, -260);

    expect(element.scrollTop).toBe(-260);
  });

  it("publishes the browser-clamped position after a write", () => {
    const element = document.createElement("div");
    let actualScrollTop = 0;
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => actualScrollTop,
      set: (value: number) => {
        actualScrollTop = Math.max(-7_000, value);
      }
    });
    const positions: number[] = [];

    setAgentTranscriptScrollTop(element, -30_000, "auto", () => {
      positions.push(element.scrollTop);
    });

    expect(positions).toEqual([-7_000]);
  });

  it("normalizes wheel lines and pages before classifying intent", () => {
    expect(normalizeAgentTranscriptWheelDelta(wheelEvent(-2, 1), 480)).toBe(
      -32
    );
    expect(normalizeAgentTranscriptWheelDelta(wheelEvent(1, 2), 480)).toBe(480);
  });

  it("does not treat editable or button keyboard input as transcript scrolling", () => {
    const timeline = document.createElement("div");
    const input = document.createElement("input");
    const button = document.createElement("button");
    timeline.append(input, button);

    expect(
      agentTranscriptKeyboardScrollDirection(
        new KeyboardEvent("keydown", { key: "ArrowUp" }),
        timeline,
        input
      )
    ).toBeNull();
    expect(
      agentTranscriptKeyboardScrollDirection(
        new KeyboardEvent("keydown", { key: " " }),
        timeline,
        button
      )
    ).toBeNull();
    expect(
      agentTranscriptKeyboardScrollDirection(
        new KeyboardEvent("keydown", { key: "PageUp" }),
        timeline,
        timeline
      )
    ).toBe("away");
  });

  it("is interrupted by user intent without completing the old target", () => {
    const element = document.createElement("div");
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    setAgentTranscriptScrollTop(element, 260, "smooth");
    cancelAgentTranscriptScroll(element);
    frames.shift()?.(260);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(element.scrollTop).toBe(0);
  });

  it("publishes intent only when a matching scroll arrives within one second", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: -100, writable: true }
    });
    const onDirection = vi.fn();
    const now = vi.spyOn(performance, "now");
    let previousDistanceFromBottomPx = 0;
    let nextDistanceFromBottomPx = 100;
    const disconnect = connectAgentTranscriptScrollInput({
      element,
      getViewportHeightPx: () => 480,
      onDirection,
      onScroll: () => ({
        nextDistanceFromBottomPx,
        previousDistanceFromBottomPx
      })
    });

    now.mockReturnValue(0);
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
    expect(onDirection).not.toHaveBeenCalled();
    now.mockReturnValue(500);
    element.dispatchEvent(new Event("scroll"));
    expect(onDirection).toHaveBeenLastCalledWith("away");

    previousDistanceFromBottomPx = 100;
    nextDistanceFromBottomPx = 200;
    now.mockReturnValue(600);
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
    now.mockReturnValue(1_601);
    element.dispatchEvent(new Event("scroll"));
    expect(onDirection).toHaveBeenCalledTimes(1);

    disconnect();
  });

  it("detects a native scrollbar drag from the committed DOM movement", () => {
    const element = document.createElement("div");
    let scrollTop = -100;
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop
      }
    });
    const onDirection = vi.fn();
    let previousDistanceFromBottomPx = 100;
    const disconnect = connectAgentTranscriptScrollInput({
      element,
      getViewportHeightPx: () => 400,
      onDirection,
      onScroll: () => ({
        nextDistanceFromBottomPx: -scrollTop,
        previousDistanceFromBottomPx
      })
    });
    const pointerDown = new Event("pointerdown");
    Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
    element.dispatchEvent(pointerDown);

    scrollTop = -200;
    element.dispatchEvent(new Event("scroll"));

    expect(onDirection).toHaveBeenCalledWith("away");
    previousDistanceFromBottomPx = 200;
    disconnect();
  });

  it("loads at the hard top without publishing an impossible away direction", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: -600, writable: true }
    });
    const onDirection = vi.fn();
    const onUserScrollToTop = vi.fn();
    const disconnect = connectAgentTranscriptScrollInput({
      element,
      getViewportHeightPx: () => 400,
      onDirection,
      onScroll: () => ({
        nextDistanceFromBottomPx: 600,
        previousDistanceFromBottomPx: 600
      }),
      onUserScrollToTop
    });

    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
    element.dispatchEvent(new Event("scroll"));

    expect(onUserScrollToTop).toHaveBeenCalledOnce();
    expect(onDirection).not.toHaveBeenCalled();
    disconnect();
  });

  it("cancels pending layout preservation for keyboard, pointer, and touch intent", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: -100, writable: true }
    });
    const onCancelLayoutPreservation = vi.fn();
    const disconnect = connectAgentTranscriptScrollInput({
      element,
      getViewportHeightPx: () => 400,
      onCancelLayoutPreservation,
      onDirection: vi.fn(),
      onScroll: () => ({
        nextDistanceFromBottomPx: 100,
        previousDistanceFromBottomPx: 100
      })
    });

    element.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    const pointerDown = new Event("pointerdown");
    Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
    element.dispatchEvent(pointerDown);
    element.dispatchEvent(
      touchEvent("touchstart", [{ clientX: 20, clientY: 20, identifier: 1 }])
    );
    element.dispatchEvent(
      touchEvent("touchmove", [{ clientX: 20, clientY: 40, identifier: 1 }])
    );

    expect(onCancelLayoutPreservation).toHaveBeenCalledTimes(3);
    disconnect();
  });
});

function wheelEvent(deltaY: number, deltaMode: number): WheelEvent {
  return { deltaMode, deltaY } as WheelEvent;
}

function touchEvent(
  type: string,
  touches: Array<{ clientX: number; clientY: number; identifier: number }>
): TouchEvent {
  const event = new Event(type);
  Object.defineProperty(event, "touches", { value: touches });
  return event as TouchEvent;
}
