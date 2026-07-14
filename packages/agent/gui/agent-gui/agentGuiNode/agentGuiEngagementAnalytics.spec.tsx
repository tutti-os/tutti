import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import {
  AGENT_GUI_PANEL_EXPOSURE_DWELL_MS,
  useAgentGUIEngagementAnalytics,
  type AgentGUIEngagementAnalytics,
  type AgentGUIEngagementEventContext
} from "./agentGuiEngagementAnalytics";

class TestIntersectionObserver implements IntersectionObserver {
  static current: TestIntersectionObserver | null = null;

  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0, 0.5, 1];

  private readonly callback: IntersectionObserverCallback;
  private target: Element | null = null;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    TestIntersectionObserver.current = this;
  }

  disconnect(): void {
    this.target = null;
  }

  observe(target: Element): void {
    this.target = target;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(target: Element): void {
    if (this.target === target) {
      this.target = null;
    }
  }

  emit(intersectionRatio: number): void {
    if (!this.target) {
      return;
    }
    this.callback(
      [
        {
          boundingClientRect: this.target.getBoundingClientRect(),
          intersectionRatio,
          intersectionRect: this.target.getBoundingClientRect(),
          isIntersecting: intersectionRatio > 0,
          rootBounds: null,
          target: this.target,
          time: Date.now()
        } as IntersectionObserverEntry
      ],
      this
    );
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TestIntersectionObserver.current = null;
});

describe("useAgentGUIEngagementAnalytics", () => {
  it("buffers interaction until a true exposure and deduplicates each visit", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const calls: Array<{
      event: string;
      input: AgentGUIEngagementEventContext & {
        contentType?: string;
        focusMethod?: string;
        hadPrefill?: boolean;
      };
    }> = [];
    const analytics: AgentGUIEngagementAnalytics = {
      onChatPanelExposed: (input) => {
        calls.push({ event: "exposed", input });
      },
      onChatInputFocused: (input) => {
        calls.push({ event: "focused", input });
      },
      onChatInputContentEntered: (input) => {
        calls.push({ event: "content", input });
      }
    };

    const { rerender } = render(
      <AnalyticsHarness analytics={analytics} isActive />
    );
    act(() => TestIntersectionObserver.current?.emit(0.75));
    fireEvent.click(screen.getByRole("button", { name: "focus" }));
    fireEvent.click(screen.getByRole("button", { name: "content" }));

    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS - 1));
    expect(calls).toEqual([]);
    act(() => vi.advanceTimersByTime(1));

    expect(calls.map((call) => call.event)).toEqual([
      "exposed",
      "focused",
      "content"
    ]);
    expect(new Set(calls.map((call) => call.input.panelVisitId)).size).toBe(1);
    expect(calls[2]?.input).toMatchObject({
      agentSessionId: null,
      agentTargetId: "codex-local",
      composerReady: true,
      contentType: "text",
      conversationState: "new",
      hadPrefill: false,
      provider: "codex"
    });

    fireEvent.click(screen.getByRole("button", { name: "focus" }));
    fireEvent.click(screen.getByRole("button", { name: "content" }));
    expect(calls).toHaveLength(3);

    rerender(<AnalyticsHarness analytics={analytics} isActive={false} />);
    rerender(<AnalyticsHarness analytics={analytics} isActive />);
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));
    expect(calls.map((call) => call.event)).toEqual([
      "exposed",
      "focused",
      "content",
      "exposed"
    ]);
    expect(calls[3]?.input.panelVisitId).not.toBe(calls[0]?.input.panelVisitId);
  });

  it("does not expose previews or panels below the visibility threshold", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const onChatPanelExposed = vi.fn();
    const analytics = { onChatPanelExposed };

    const { rerender } = render(
      <AnalyticsHarness analytics={analytics} isActive />
    );
    act(() => TestIntersectionObserver.current?.emit(0.49));
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));
    expect(onChatPanelExposed).not.toHaveBeenCalled();

    rerender(<AnalyticsHarness analytics={analytics} isActive previewMode />);
    act(() => TestIntersectionObserver.current?.emit(1));
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));
    expect(onChatPanelExposed).not.toHaveBeenCalled();
  });

  it("does not expose a panel hidden by workbench presentation state", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const onChatPanelExposed = vi.fn();

    render(
      <AnalyticsHarness
        analytics={{ onChatPanelExposed }}
        isActive
        presentationMode="mission-control"
      />
    );
    act(() => TestIntersectionObserver.current?.emit(1));
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));

    expect(onChatPanelExposed).not.toHaveBeenCalled();
  });
});

function AnalyticsHarness({
  analytics,
  isActive,
  presentationMode = "default",
  previewMode = false
}: {
  analytics: AgentGUIEngagementAnalytics;
  isActive: boolean;
  presentationMode?: "default" | "mission-control";
  previewMode?: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const composerAnalytics = useAgentGUIEngagementAnalytics({
    analytics,
    context: {
      agentSessionId: null,
      agentTargetId: "codex-local",
      composerReady: true,
      conversationState: "new",
      provider: "codex"
    },
    elementRef,
    isActive,
    previewMode
  });
  return (
    <div
      className="workbench-window-shell"
      data-presentation-mode={presentationMode}
    >
      <div ref={elementRef}>
        <button
          type="button"
          onClick={() => composerAnalytics?.focused("pointer")}
        >
          focus
        </button>
        <button
          type="button"
          onClick={() =>
            composerAnalytics?.contentEntered({
              contentType: "text",
              hadPrefill: false
            })
          }
        >
          content
        </button>
      </div>
    </div>
  );
}
