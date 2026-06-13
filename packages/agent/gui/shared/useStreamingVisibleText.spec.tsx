import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceStreamingVisibleText,
  useStreamingVisibleText
} from "./useStreamingVisibleText";

describe("advanceStreamingVisibleText", () => {
  it("advances default streaming in small frame-sized steps", () => {
    const visibleText = "abc";
    const sourceText = `${visibleText}${"x".repeat(200)}`;

    expect(
      advanceStreamingVisibleText({
        visibleText,
        sourceText
      })
    ).toHaveLength(147);
  });

  it("advances append-only text by the configured frame budget", () => {
    expect(
      advanceStreamingVisibleText({
        visibleText: "abc",
        sourceText: "abcdef",
        frameMs: 100,
        maxCharsPerSecond: 10,
        trailingFlushChars: 0
      })
    ).toBe("abcd");
  });

  it("keeps the common prefix when the stream rewrites its tail", () => {
    expect(
      advanceStreamingVisibleText({
        visibleText: "hello stale tail",
        sourceText: "hello fresh tail",
        frameMs: 100,
        maxCharsPerSecond: 20,
        trailingFlushChars: 0
      })
    ).toBe("hello fr");
  });
});

describe("useStreamingVisibleText", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the visible text stable until the scheduled frame", () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ sourceText }) =>
        useStreamingVisibleText(sourceText, {
          enabled: true,
          frameMs: 100,
          maxCharsPerSecond: 10,
          trailingFlushChars: 0
        }),
      {
        initialProps: {
          sourceText: "abc"
        }
      }
    );

    rerender({ sourceText: "abcdef" });

    expect(result.current).toBe("abc");

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toBe("abcd");
  });

  it("flushes to the source text when streaming is disabled", () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ enabled, sourceText }) =>
        useStreamingVisibleText(sourceText, {
          enabled,
          frameMs: 100,
          maxCharsPerSecond: 10,
          trailingFlushChars: 0
        }),
      {
        initialProps: {
          enabled: true,
          sourceText: "abc"
        }
      }
    );

    rerender({ enabled: true, sourceText: "abcdef" });
    expect(result.current).toBe("abc");

    rerender({ enabled: false, sourceText: "abcdef" });

    expect(result.current).toBe("abcdef");
  });
});
