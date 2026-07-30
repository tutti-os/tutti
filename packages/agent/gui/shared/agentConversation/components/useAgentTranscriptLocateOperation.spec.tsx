import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  useAgentTranscriptTurnAttachments,
  type AgentTranscriptAttachmentLocator
} from "./useAgentTranscriptTurnAttachments";
import { useAgentTranscriptLocateOperation } from "./useAgentTranscriptLocateOperation";

describe("useAgentTranscriptLocateOperation", () => {
  it("cancels attachment A when message B starts on the same timeline", async () => {
    let resolveReveal: (element: HTMLElement | null) => void = () => {};
    const scrollToKey = vi.fn(
      (
        _turnKey: string,
        _findTarget?: () => HTMLElement | null,
        _options?: { signal?: AbortSignal }
      ) =>
        new Promise<HTMLElement | null>((resolve) => {
          resolveReveal = resolve;
        })
    );
    const attachmentLocatorRef = createRef<AgentTranscriptAttachmentLocator>();
    const { result } = renderHook(() => {
      const locateOperation = useAgentTranscriptLocateOperation(true);
      useAgentTranscriptTurnAttachments({
        attachments: [
          {
            anchorTurnId: "turn-a",
            content: null,
            id: "attachment-a"
          }
        ],
        isVisible: true,
        locateOperation,
        locatorRef: attachmentLocatorRef,
        rowVirtualizer: { scrollToKey },
        turnGroups: [{ key: "turn-a", rows: [], turnId: "turn-a" }]
      });
      return locateOperation;
    });

    act(() => attachmentLocatorRef.current?.("attachment-a"));
    const attachmentSignal = scrollToKey.mock.calls[0]?.[2]?.signal;
    expect(attachmentSignal?.aborted).toBe(false);

    act(() => {
      result.current.begin();
    });
    expect(attachmentSignal?.aborted).toBe(true);

    await act(async () => resolveReveal(null));
    expect(scrollToKey).toHaveBeenCalledOnce();
  });

  it("cancels the current operation when the timeline becomes hidden", () => {
    const { result, rerender } = renderHook(
      ({ isVisible }) => useAgentTranscriptLocateOperation(isVisible),
      { initialProps: { isVisible: true } }
    );
    const signal = result.current.begin();

    rerender({ isVisible: false });

    expect(signal.aborted).toBe(true);
  });
});
