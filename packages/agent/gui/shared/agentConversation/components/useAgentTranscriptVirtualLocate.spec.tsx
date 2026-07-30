import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildAgentTranscriptVirtualLayout } from "./agentTranscriptVirtualizerLayout";
import { useAgentTranscriptVirtualLocate } from "./useAgentTranscriptVirtualLocate";

describe("useAgentTranscriptVirtualLocate", () => {
  it("cancels the render-time target projection when reveal is aborted", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const layout = buildAgentTranscriptVirtualLayout(
      [{ gapAfterPx: 0, key: "turn-1" }],
      {}
    );
    const setLocatingTurnKey = vi.fn();
    const { result, unmount } = renderHook(() => {
      const activeLocateRef = useRef<object | null>(null);
      const layoutRef = useRef(layout);
      const measuredElementsRef = useRef(new Map<string, HTMLElement>());
      const scrollElementRef = useRef<HTMLElement | null>(host);
      const scrollPaddingBottomRef = useRef(0);
      const scrollPaddingTopRef = useRef(0);
      const viewportStateRef = useRef({
        distanceFromBottomPx: 0,
        renderedRange: { endIndex: 1, startIndex: 0 },
        turnKeys: layout.turnKeys,
        viewportHeightPx: 480
      });
      return {
        activeLocateRef,
        ...useAgentTranscriptVirtualLocate({
          activeLocateRef,
          applyDistance: vi.fn(),
          layoutRef,
          measuredElementsRef,
          scrollElementRef,
          scrollPaddingBottomRef,
          scrollPaddingTopRef,
          scrollToIndex: vi.fn(),
          setLocatingTurnKey,
          viewportStateRef,
          virtualizerHostRef: { current: host }
        })
      };
    });
    const abortController = new AbortController();

    const locate = result.current.scrollToKey("turn-1", () => null, {
      signal: abortController.signal
    });
    expect(result.current.activeLocateRef.current).not.toBeNull();
    abortController.abort();

    await expect(locate).resolves.toBeNull();
    expect(result.current.activeLocateRef.current).toBeNull();
    expect(setLocatingTurnKey.mock.calls).toEqual([["turn-1"], [null]]);
    unmount();
    host.remove();
    vi.restoreAllMocks();
  });
});
