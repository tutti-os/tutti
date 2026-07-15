import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, RefObject } from "react";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import { useAgentGUIDetailScroll } from "./useAgentGUIDetailScroll";

afterEach(() => {
  vi.restoreAllMocks();
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

    harness.setScrollHeight(5_000);
    act(() => {
      harness.timeline.dispatchEvent(new Event("scroll"));
    });
    expect(harness.timeline.scrollTop).toBe(4_900);

    act(() => animationFrames[0]?.(0));

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
  const bottomDock = document.createElement("div");
  let scrollHeight = input.scrollHeight;
  Object.defineProperties(timeline, {
    clientHeight: {
      configurable: true,
      get: () => 100
    },
    scrollHeight: {
      configurable: true,
      get: () => scrollHeight
    }
  });

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

  return {
    bottomDock,
    timeline,
    setScrollHeight(value: number) {
      scrollHeight = value;
    },
    input(options: {
      activeConversationId: string;
      showTimelineSkeleton: boolean;
      timelineConversationId?: string;
    }) {
      return {
        actions: {
          loadOlderConversationMessages: vi.fn()
        } as unknown as AgentGUINodeViewProps["actions"],
        bottomDockRef: ref(bottomDock),
        bottomDockStoreRevision: "stable",
        conversation: null,
        pendingPrependScrollAnchorRef,
        showTimelineSkeleton: options.showTimelineSkeleton,
        submittedPromptScrollConversationRef,
        timelineConversationId:
          options.timelineConversationId ?? options.activeConversationId,
        timelineRef: ref(timeline),
        timelineScrollAnchorRef,
        viewModel: viewModel(options.activeConversationId)
      };
    }
  };
}

function viewModel(activeConversationId: string): AgentGUINodeViewModel {
  return {
    rail: { activeConversationId },
    detail: {
      hasOlderMessages: false,
      isLoadingOlderMessages: false
    }
  } as unknown as AgentGUINodeViewModel;
}

function mutableRef<T>(current: T): MutableRefObject<T> {
  return { current };
}

function ref<T>(current: T): RefObject<T> {
  return { current };
}
