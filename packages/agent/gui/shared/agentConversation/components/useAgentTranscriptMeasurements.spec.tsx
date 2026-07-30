import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAgentTranscriptMeasurements } from "./useAgentTranscriptMeasurements";

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

describe("useAgentTranscriptMeasurements", () => {
  it("measures a mounted turn during layout sync without a duplicate microtask read", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const element = document.createElement("div");
    element.dataset.agentTranscriptVirtualTurn = "latest";
    const offsetHeight = vi
      .spyOn(element, "offsetHeight", "get")
      .mockReturnValue(460);
    const onCommit = vi.fn();
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptMeasurements({}, undefined, onCommit)
    );

    act(() => {
      result.current.measureElement("latest", element);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(offsetHeight).not.toHaveBeenCalled();

    act(() => {
      result.current.syncMountedElements();
    });

    expect(result.current.measuredHeightsByKey.latest).toBe(460);
    expect(onCommit).toHaveBeenCalledWith({ latest: 460 });
    expect(offsetHeight).toHaveBeenCalledTimes(1);
    unmount();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stops synchronously reading a stable mounted turn", () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const element = document.createElement("div");
    element.dataset.agentTranscriptVirtualTurn = "latest";
    const offsetHeight = vi
      .spyOn(element, "offsetHeight", "get")
      .mockReturnValue(460);
    const { result, unmount } = renderHook(() =>
      useAgentTranscriptMeasurements({})
    );

    act(() => {
      result.current.measureElement("latest", element);
      result.current.syncMountedElements();
      result.current.syncMountedElements();
    });
    offsetHeight.mockClear();

    act(() => {
      result.current.syncMountedElements();
      result.current.syncMountedElements();
    });

    expect(offsetHeight).not.toHaveBeenCalled();
    unmount();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
