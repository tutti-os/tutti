import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessageLocatorItem } from "./agentTranscriptModel";
import {
  findTranscriptLocatorTarget,
  findKeyboardEventTimeline,
  findKeyboardLocatorTarget,
  readMessageLocatorVisibleFrame,
  scrollKeyboardTranscriptLocatorTarget,
  scrollMountedTranscriptLocatorTarget,
  scrollTranscriptRowIntoView
} from "./agentMessageLocatorNavigation";

const ITEMS: readonly AgentMessageLocatorItem[] = Array.from(
  { length: 3 },
  (_, index) => ({
    hasAgentResponse: true,
    key: `message-${index + 1}`,
    rowIndex: index,
    rowKey: `row-${index + 1}`,
    summary: `Message ${index + 1}`,
    turnGroupIndex: index
  })
);

describe("agentMessageLocatorNavigation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves mounted keyboard targets with one timeline query", () => {
    const timeline = document.createElement("div");
    timeline.getBoundingClientRect = () => rect(0);
    for (const [index, item] of ITEMS.entries()) {
      const row = document.createElement("div");
      row.dataset.agentMessageLocatorKey = item.key;
      row.getBoundingClientRect = () => rect(index * 100);
      timeline.append(row);
    }
    const querySelectorAll = vi.spyOn(timeline, "querySelectorAll");

    expect(findKeyboardLocatorTarget(ITEMS, timeline, "next")?.key).toBe(
      "message-2"
    );
    expect(querySelectorAll).toHaveBeenCalledOnce();
  });

  it("resolves the timeline from the keyboard event path", () => {
    const timeline = document.createElement("div");
    timeline.dataset.testid = "agent-gui-timeline";
    const target = document.createElement("button");
    timeline.append(target);
    document.body.append(timeline);
    let resolved: HTMLElement | null = null;
    target.addEventListener("keydown", (event) => {
      resolved = findKeyboardEventTimeline(event);
    });

    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    expect(resolved).toBe(timeline);
    timeline.remove();
  });

  it("reads the scrollable frame after CSS scroll padding", () => {
    const timeline = document.createElement("div");
    timeline.style.scrollPaddingTop = "20px";
    timeline.style.scrollPaddingBottom = "30px";
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      value: 200
    });

    expect(readMessageLocatorVisibleFrame(timeline)).toEqual({
      heightPx: 150,
      topOffsetPx: 20
    });
  });

  it("uses the exact message bubble for keyboard selection", () => {
    const timeline = document.createElement("div");
    timeline.style.scrollPaddingTop = "32px";
    timeline.getBoundingClientRect = () => rect(100);
    const firstRow = document.createElement("div");
    firstRow.dataset.agentMessageLocatorKey = ITEMS[0]!.key;
    firstRow.getBoundingClientRect = () => rect(80);
    const firstBubble = document.createElement("div");
    firstBubble.className = "agent-gui-conversation__user-message-bubble";
    firstBubble.getBoundingClientRect = () => rect(120);
    firstRow.append(firstBubble);
    const secondRow = document.createElement("div");
    secondRow.dataset.agentMessageLocatorKey = ITEMS[1]!.key;
    secondRow.getBoundingClientRect = () => rect(125);
    const secondBubble = document.createElement("div");
    secondBubble.className = "agent-gui-conversation__user-message-bubble";
    secondBubble.getBoundingClientRect = () => rect(180);
    secondRow.append(secondBubble);
    timeline.append(firstRow, secondRow);

    expect(findKeyboardLocatorTarget(ITEMS, timeline, "next")?.key).toBe(
      "message-2"
    );
  });

  it("scrolls the mounted row natively while measuring its exact bubble", () => {
    const timeline = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.agentMessageLocatorKey = ITEMS[0]!.key;
    row.scrollIntoView = vi.fn();
    const bubble = document.createElement("div");
    bubble.className = "agent-gui-conversation__user-message-bubble";
    row.append(bubble);
    timeline.append(row);

    const target = findTranscriptLocatorTarget(timeline, ITEMS[0]!.key);
    expect(target).toEqual({
      measureElement: bubble,
      scrollElement: row
    });

    scrollMountedTranscriptLocatorTarget(target!, "auto");
    expect(row.scrollIntoView).toHaveBeenCalledWith({
      behavior: "instant",
      block: "start"
    });
  });

  it("corrects keyboard alignment after 350ms when the real DOM is over 24px off", () => {
    vi.useFakeTimers();
    const timeline = document.createElement("div");
    timeline.getBoundingClientRect = () => rect(100);
    const row = document.createElement("div");
    row.scrollIntoView = vi.fn();
    const bubble = document.createElement("div");
    bubble.className = "agent-gui-conversation__user-message-bubble";
    bubble.getBoundingClientRect = () => rect(140);
    row.append(bubble);
    timeline.append(row);
    document.body.append(timeline);

    scrollKeyboardTranscriptLocatorTarget(timeline, {
      measureElement: bubble,
      scrollElement: row
    });
    expect(row.scrollIntoView).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(350);
    expect(row.scrollIntoView).toHaveBeenCalledTimes(2);
    timeline.remove();
  });

  it("does not use browser-native scrolling without a transcript owner", () => {
    const row = document.createElement("div");
    row.scrollIntoView = vi.fn();

    expect(scrollTranscriptRowIntoView(row, null)).toBe(false);
    expect(row.scrollIntoView).not.toHaveBeenCalled();
  });

  it("locates rows by writing bottom-origin native scroll distance", () => {
    const timeline = document.createElement("div");
    const row = document.createElement("div");
    timeline.scrollTop = -400;
    timeline.getBoundingClientRect = () => rect(100);
    row.getBoundingClientRect = () => rect(260);
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      value: 400
    });

    expect(
      scrollTranscriptRowIntoView(row, timeline, {
        align: "top",
        behavior: "auto"
      })
    ).toBe(true);
    expect(timeline.scrollTop).toBe(-240);
  });
});

function rect(top: number): DOMRect {
  return {
    bottom: top + 40,
    height: 40,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}
