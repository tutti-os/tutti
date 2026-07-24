import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import {
  AGENT_GUI_PANEL_EXPOSURE_DWELL_MS,
  useAgentGUIPanelEngagement
} from "./useAgentGUIPanelEngagement";
import { AgentGUIPanelEngagementController } from "./AgentGUIPanelEngagementController";
import { createAgentGUIEngagementContextKey } from "./projectAgentGUIEngagementContext";
import type {
  AgentGUIEngagementContext,
  AgentGUIEngagementEvent
} from "./agentGUIEngagement.types";

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
    if (this.target === target) this.target = null;
  }

  emit(intersectionRatio: number): void {
    if (!this.target) return;
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

describe("useAgentGUIPanelEngagement", () => {
  it("keys visits by session, provider, and target without delimiter collisions", () => {
    const keys = [
      createAgentGUIEngagementContextKey({
        agentSessionId: "session-1",
        agentTargetId: "target:one",
        provider: "provider"
      }),
      createAgentGUIEngagementContextKey({
        agentSessionId: "session-1",
        agentTargetId: "one",
        provider: "provider:target"
      }),
      createAgentGUIEngagementContextKey({
        agentSessionId: "session-1",
        agentTargetId: "target:one",
        provider: "other-provider"
      })
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("buffers interaction until exposure and deduplicates a visit", () => {
    const { events } = renderHarness();

    exposePanel();
    fireEvent.click(screen.getByRole("button", { name: "focus" }));
    fireEvent.click(screen.getByRole("button", { name: "content" }));
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));

    expect(events.map((event) => event.type)).toEqual([
      "panel_exposed",
      "composer_focused",
      "composer_content_entered"
    ]);
    expect(new Set(events.map((event) => event.panelVisitId)).size).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "focus" }));
    fireEvent.click(screen.getByRole("button", { name: "content" }));
    expect(events).toHaveLength(3);
  });

  it("starts a new visit when the active conversation changes while visible", () => {
    const { events, rerender } = renderHarness({
      context: contextFor("session-a"),
      contextKey: "session:session-a"
    });

    exposePanel();
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));
    const firstVisitId = events[0]?.panelVisitId;

    rerender(
      <EngagementHarness
        context={contextFor("session-b")}
        contextKey="session:session-b"
        events={events}
      />
    );
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));
    fireEvent.click(screen.getByRole("button", { name: "focus" }));

    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({
      type: "panel_exposed",
      agentSessionId: "session-b"
    });
    expect(events[2]).toMatchObject({
      type: "composer_focused",
      agentSessionId: "session-b",
      panelVisitId: events[1]?.panelVisitId
    });
    expect(events[1]?.panelVisitId).not.toBe(firstVisitId);
  });

  it("cancels a pending exposure when its conversation context changes", () => {
    const { events, rerender } = renderHarness({
      context: contextFor("session-a"),
      contextKey: "session:session-a"
    });
    exposePanel();
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS - 1));

    rerender(
      <EngagementHarness
        context={contextFor("session-b")}
        contextKey="session:session-b"
        events={events}
      />
    );
    act(() => vi.advanceTimersByTime(1));
    expect(events).toEqual([]);

    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS - 1));
    expect(events).toEqual([
      expect.objectContaining({
        type: "panel_exposed",
        agentSessionId: "session-b"
      })
    ]);
  });

  it("does not expose host-hidden panels or low intersections", () => {
    const { events, rerender } = renderHarness();
    act(() => TestIntersectionObserver.current?.emit(0.49));
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));
    expect(events).toEqual([]);

    rerender(<EngagementHarness events={events} isVisible={false} />);
    act(() => TestIntersectionObserver.current?.emit(1));
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));
    expect(events).toEqual([]);
  });

  it("does not approximate exposure when IntersectionObserver is unavailable", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    const { events } = renderHarness({ installIntersectionObserver: false });

    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));

    expect(events).toEqual([]);
  });

  it("rejects stale interactions after the visit context changes", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const events: AgentGUIEngagementEvent[] = [];
    let input = {
      context: contextFor("session-a"),
      contextKey: "session:session-a",
      isActive: true,
      isVisible: true,
      onEvent: (event: AgentGUIEngagementEvent) => {
        events.push(event);
      }
    };
    const controller = new AgentGUIPanelEngagementController({
      element: document.createElement("div"),
      getInput: () => input,
      initialIntersectionRatio: 0,
      visitContextKey: input.contextKey
    });
    controller.attach();
    act(() => TestIntersectionObserver.current?.emit(1));
    act(() => vi.advanceTimersByTime(AGENT_GUI_PANEL_EXPOSURE_DWELL_MS));

    input = {
      ...input,
      context: contextFor("session-b"),
      contextKey: "session:session-b"
    };
    controller.focused("pointer");
    controller.contentEntered({ contentType: "text", hadPrefill: false });

    expect(events).toEqual([
      expect.objectContaining({
        agentSessionId: "session-a",
        type: "panel_exposed"
      })
    ]);
    controller.dispose();
  });
});

function renderHarness(input?: {
  context?: AgentGUIEngagementContext;
  contextKey?: string;
  installIntersectionObserver?: boolean;
}) {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal(
    "IntersectionObserver",
    input?.installIntersectionObserver === false
      ? undefined
      : TestIntersectionObserver
  );
  const events: AgentGUIEngagementEvent[] = [];
  const rendered = render(
    <EngagementHarness
      context={input?.context}
      contextKey={input?.contextKey}
      events={events}
    />
  );
  return { ...rendered, events };
}

function exposePanel(): void {
  act(() => TestIntersectionObserver.current?.emit(0.75));
}

function contextFor(agentSessionId: string | null): AgentGUIEngagementContext {
  return {
    agentSessionId,
    agentTargetId: "codex-local",
    composerReady: true,
    conversationState: agentSessionId ? "existing" : "new",
    provider: "codex"
  };
}

function EngagementHarness({
  context = contextFor(null),
  contextKey = "home:codex-local",
  events,
  isVisible = true
}: {
  context?: AgentGUIEngagementContext;
  contextKey?: string;
  events: AgentGUIEngagementEvent[];
  isVisible?: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const composerEngagement = useAgentGUIPanelEngagement({
    context,
    contextKey,
    elementRef,
    isActive: true,
    isVisible,
    onEvent: (event) => {
      events.push(event);
    }
  });
  return (
    <div ref={elementRef}>
      <button
        type="button"
        onClick={() => composerEngagement?.focused("pointer")}
      >
        focus
      </button>
      <button
        type="button"
        onClick={() =>
          composerEngagement?.contentEntered({
            contentType: "text",
            hadPrefill: false
          })
        }
      >
        content
      </button>
    </div>
  );
}
