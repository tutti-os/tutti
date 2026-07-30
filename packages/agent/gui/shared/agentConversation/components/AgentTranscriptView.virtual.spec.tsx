import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import {
  AgentTranscriptView,
  type AgentTranscriptAttachmentLocator,
  type AgentTranscriptVirtualScrollController
} from "./AgentTranscriptView";
import { clearAgentTranscriptVirtualMeasurementsForTest } from "./agentTranscriptVirtualMeasurementStore";

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = [];

  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  disconnect(): void {
    this.observed.clear();
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  emit(measurements: ReadonlyArray<{ height: number; target: Element }>): void {
    this.callback(
      measurements.map(({ height, target }) => ({
        borderBoxSize: [] as unknown as ResizeObserverSize[],
        contentBoxSize: [] as unknown as ResizeObserverSize[],
        contentRect: {
          bottom: height,
          height,
          left: 0,
          right: 100,
          top: 0,
          width: 100,
          x: 0,
          y: 0,
          toJSON: () => ({})
        },
        devicePixelContentBoxSize: [] as unknown as ResizeObserverSize[],
        target
      })),
      this
    );
  }
}

vi.mock("../../../i18n/index", () => ({
  getActiveUiLanguage: () => "en",
  useTranslation: () => ({ t: (key: string) => key }),
  translate: (key: string) => key
}));

const LABELS = {
  thinkingLabel: "Thought process",
  toolCallsLabel: (count: number) => `Tool calls (${count})`,
  processing: "Planning next moves",
  turnSummary: "Changed files",
  userMessageLocator: "User messages"
};

describe("AgentTranscriptView Codex-style virtual rendering", () => {
  beforeEach(() => {
    clearAgentTranscriptVirtualMeasurementsForTest();
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
      this: HTMLElement,
      options?: ScrollToOptions | number
    ) {
      if (typeof options === "object" && options.top !== undefined) {
        this.scrollTop = options.top;
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("always renders through the virtual list, including short conversations", () => {
    renderTranscript(conversationWithMultiRowTurns(2));

    expect(
      document.querySelector("[data-agent-transcript-virtualized='true']")
    ).toBeTruthy();
    expect(screen.getByText("turn 0 user row")).toBeTruthy();
    expect(screen.getByText("turn 1 assistant row")).toBeTruthy();
  });

  it("keeps a turn intact in a normal-flow window without item transforms", () => {
    renderTranscript(conversationWithMultiRowTurns(40));

    const host = document.querySelector<HTMLElement>(
      "[data-agent-transcript-virtualized='true']"
    );
    const turns = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-agent-transcript-virtual-turn]"
      )
    ];
    expect(host?.style.height).toBe("11668px");
    expect(turns.length).toBeLessThan(40);
    expect(turns.at(-1)?.dataset.agentTranscriptVirtualTurn).toBe("turn-39");
    expect(turns.every((turn) => turn.style.transform === "")).toBe(true);
    expect(
      turns
        .at(-1)
        ?.querySelectorAll(
          ":scope > .agent-gui-transcript-virtual-item > .agent-gui-transcript-row"
        )
    ).toHaveLength(2);
    expect(screen.queryByText("turn 0 user row")).toBeNull();
  });

  it("exposes end control through the session-scoped controller", () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    renderTranscript(conversationWithMultiRowTurns(40), {
      virtualScrollControllerRef: controller
    });

    expect(controller.current?.agentSessionId).toBe("session-1");
    expect(controller.current?.enabled).toBe(true);
    expect(controller.current?.isAtEnd()).toBe(true);
    const timeline = screen.getByTestId("agent-gui-timeline");
    act(() => {
      timeline.scrollTop = -11_188;
      fireEvent.scroll(timeline);
    });
    controller.current?.scrollToEnd({ behavior: "smooth" });
    expect(animationFrames).toHaveLength(1);
    act(() => {
      animationFrames.shift()?.(260);
    });
    expect(timeline.scrollTop).toBe(0);
  });

  it("tracks smooth scrolling from the actual midpoint before reaching the end", () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    renderTranscript(conversationWithMultiRowTurns(40), {
      virtualScrollControllerRef: controller
    });
    const timeline = screen.getByTestId("agent-gui-timeline");
    act(() => {
      timeline.scrollTop = -11_188;
      fireEvent.scroll(timeline);
    });
    expect(controller.current?.isAtEnd()).toBe(false);

    controller.current?.scrollToEnd({ behavior: "smooth" });
    expect(controller.current?.isAtEnd()).toBe(false);
    const midpointFrame = animationFrames.at(-1);

    act(() => {
      midpointFrame?.(130);
    });
    expect(timeline.scrollTop).toBeGreaterThan(-11_188);
    expect(timeline.scrollTop).toBeLessThan(0);
    expect(controller.current?.isAtEnd()).toBe(false);
    expect(screen.queryByText("turn 0 user row")).toBeNull();

    act(() => {
      animationFrames.at(-1)?.(260);
    });
    expect(timeline.scrollTop).toBe(0);
    expect(controller.current?.isAtEnd()).toBe(true);
    expect(screen.getByText("turn 39 assistant row")).toBeTruthy();
  });

  it("mounts an offscreen turn before locating its attachment", async () => {
    const locator = createRef<AgentTranscriptAttachmentLocator>();
    renderTranscript(conversationWithMultiRowTurns(40), {
      turnAttachmentLocatorRef: locator,
      turnAttachments: [
        {
          anchorTurnId: "turn-0",
          content: <div>restored attachment</div>,
          id: "attachment-0"
        }
      ]
    });
    expect(screen.queryByText("restored attachment")).toBeNull();

    await act(async () => {
      locator.current?.("attachment-0");
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });

    await waitFor(() =>
      expect(screen.getByText("restored attachment")).toBeTruthy()
    );
    expect(screen.getByText("turn 0 user row")).toBeTruthy();
  });

  it("uses composer scroll padding in viewport compensation", () => {
    const controller = createRef<AgentTranscriptVirtualScrollController>();
    renderTranscript(conversationWithMultiRowTurns(40), {
      virtualScrollControllerRef: controller
    });
    const timeline = screen.getByTestId("agent-gui-timeline");
    controller.current?.syncViewport({
      followEnd: true,
      scrollPaddingBottomAdjustmentPx: 120
    });

    expect(timeline.scrollTop).toBe(0);
    expect(controller.current?.isAtEnd()).toBe(true);
  });

  it("commits one layout update for a batch of turn measurements", async () => {
    renderTranscript(conversationWithMultiRowTurns(40));
    const host = document.querySelector<HTMLElement>(
      "[data-agent-transcript-virtualized='true']"
    );
    const measuredTurns = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-agent-transcript-virtual-turn-content]"
      )
    ].slice(0, 2);
    const observer = TestResizeObserver.instances[0];
    const getComputedStyle = vi.spyOn(window, "getComputedStyle");
    const getBoundingClientRect = vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect"
    );
    getComputedStyle.mockClear();
    getBoundingClientRect.mockClear();

    await act(async () => {
      observer?.emit([
        { height: 320, target: measuredTurns[0]! },
        { height: 400, target: measuredTurns[1]! }
      ]);
      await Promise.resolve();
    });

    expect(host?.style.height).toBe("11828px");
    expect(getComputedStyle).not.toHaveBeenCalled();
    expect(getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("does not synchronously remeasure the latest turn on an ordinary rerender", () => {
    const conversation = conversationWithMultiRowTurns(4);
    const rendered = renderTranscript(conversation);
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    offsetHeight.mockClear();

    rendered.rerender(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={{
            ...conversation,
            rows: conversation.rows.map((row, index) =>
              index === conversation.rows.length - 1
                ? {
                    ...row,
                    occurredAtUnixMs: (row.occurredAtUnixMs ?? 0) + 1
                  }
                : row
            )
          }}
          labels={LABELS}
        />
      </div>
    );

    expect(offsetHeight).not.toHaveBeenCalled();
  });

  it("remeasures the latest turn synchronously when its content turn changes", () => {
    const conversation = conversationWithMultiRowTurns(4);
    conversation.sourceDetail.session.activeTurnId = "turn-3";
    const rendered = renderTranscript(conversation);
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.agentTranscriptVirtualTurnContent === "turn-3"
          ? 520
          : 0;
      });
    offsetHeight.mockClear();

    rendered.rerender(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={{
            ...conversation,
            rows: conversation.rows.map((row, index) =>
              index === conversation.rows.length - 1 && row.kind === "message"
                ? {
                    ...row,
                    messages: row.messages.map((message) => ({
                      ...message,
                      body: `${message.body} updated`
                    }))
                  }
                : row
            ),
            sourceDetail: {
              ...conversation.sourceDetail,
              turns: conversation.sourceDetail.turns.map((turn, index) =>
                index === conversation.sourceDetail.turns.length - 1
                  ? { ...turn }
                  : turn
              )
            }
          }}
          labels={LABELS}
        />
      </div>
    );

    expect(offsetHeight).toHaveBeenCalled();
    expect(
      document.querySelector<HTMLElement>(
        "[data-agent-transcript-virtualized='true']"
      )?.style.height
    ).toBe("1396px");
  });

  it("preserves wheel distance across a detached measurement layout", async () => {
    renderTranscript(conversationWithMultiRowTurns(40), {
      followEndMode: "detached"
    });
    const timeline = screen.getByTestId("agent-gui-timeline");
    const lastTurnContent = document.querySelector<HTMLElement>(
      "[data-agent-transcript-virtual-turn-content='turn-39']"
    );
    expect(lastTurnContent).toBeTruthy();
    act(() => {
      timeline.scrollTop = -500;
      fireEvent.scroll(timeline);
      TestResizeObserver.instances[0]?.emit([
        { height: 400, target: lastTurnContent! }
      ]);
      timeline.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -40 })
      );
    });

    await waitFor(() => expect(timeline.scrollTop).toBe(-660));
  });

  it("consumes viewport ResizeObserver height without geometry queries", () => {
    renderTranscript(conversationWithMultiRowTurns(40));
    const timeline = screen.getByTestId("agent-gui-timeline");
    const observer = TestResizeObserver.instances[0];
    const scrollTop = vi.spyOn(timeline, "scrollTop", "get");
    const clientHeight = vi.spyOn(timeline, "clientHeight", "get");
    const getComputedStyle = vi.spyOn(window, "getComputedStyle");
    scrollTop.mockClear();
    clientHeight.mockClear();
    getComputedStyle.mockClear();

    act(() => {
      observer?.emit([{ height: 420, target: timeline }]);
    });

    expect(scrollTop).not.toHaveBeenCalled();
    expect(clientHeight).not.toHaveBeenCalled();
    expect(getComputedStyle).not.toHaveBeenCalled();
  });

  it("constrains only unmeasured settled turns and releases the slot after measurement", async () => {
    const conversation = conversationWithMultiRowTurns(4);
    conversation.sourceDetail.session.activeTurnId = "turn-1";
    renderTranscript(conversation);
    const settledTurn = document.querySelector<HTMLElement>(
      "[data-agent-transcript-virtual-turn='turn-0']"
    );
    const activeTurn = document.querySelector<HTMLElement>(
      "[data-agent-transcript-virtual-turn='turn-1']"
    );
    const latestTurn = document.querySelector<HTMLElement>(
      "[data-agent-transcript-virtual-turn='turn-3']"
    );

    expect(settledTurn?.style.height).toBe("280px");
    expect(settledTurn?.style.overflow).toBe("hidden");
    const settledTurnContent =
      settledTurn?.querySelector<HTMLElement>(
        "[data-agent-transcript-virtual-turn-content='turn-0']"
      ) ?? null;
    expect(settledTurnContent).toBeTruthy();
    expect(settledTurnContent?.style.height).toBe("");
    expect(
      TestResizeObserver.instances[0]?.observed.has(settledTurnContent!)
    ).toBe(true);
    expect(activeTurn?.style.height).toBe("");
    expect(latestTurn?.style.height).toBe("");

    await act(async () => {
      TestResizeObserver.instances[0]?.emit([
        { height: 360, target: settledTurnContent! }
      ]);
      await Promise.resolve();
    });

    expect(settledTurn?.style.height).toBe("");
    expect(settledTurn?.style.overflow).toBe("");
  });

  it("does not re-read computed scroll padding on scroll events", () => {
    renderTranscript(conversationWithMultiRowTurns(40));
    const timeline = screen.getByTestId("agent-gui-timeline");
    const getComputedStyle = vi.spyOn(window, "getComputedStyle");
    getComputedStyle.mockClear();

    fireEvent.scroll(timeline);
    fireEvent.scroll(timeline);

    expect(getComputedStyle).not.toHaveBeenCalled();
  });

  it("reads native reversed scrolling as distance from the transcript end", () => {
    renderTranscript(conversationWithMultiRowTurns(40));
    const timeline = screen.getByTestId("agent-gui-timeline");

    act(() => {
      timeline.scrollTop = -11_188;
      fireEvent.scroll(timeline);
    });

    expect(timeline.scrollTop).toBe(-11_188);
    expect(screen.getByText("turn 0 user row")).toBeTruthy();
  });

  it("mounts an offscreen user message before exact locator scrolling", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("agent-gui-transcript-virtual")
          ? 900
          : 1_000;
      }
    );
    renderTranscript(conversationWithMultiRowTurns(40));
    expect(screen.queryByText("turn 0 user row")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "turn 0 user row"
      })
    );

    await waitFor(() =>
      expect(screen.getByText("turn 0 user row")).toBeTruthy()
    );
    expect(
      screen
        .getByText("turn 0 user row")
        .closest("[data-agent-message-locator-key='user-message:user-row-0']")
    ).toBeTruthy();
  });

  it("starts a remounted session at the end instead of restoring its position", async () => {
    const first = renderTranscript(conversationWithMultiRowTurns(40));
    const timeline = screen.getByTestId("agent-gui-timeline");
    timeline.scrollTop = -11_188;
    fireEvent.scroll(timeline);
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
    first.unmount();

    const controller = createRef<AgentTranscriptVirtualScrollController>();
    renderTranscript(conversationWithMultiRowTurns(40), {
      virtualScrollControllerRef: controller
    });

    expect(screen.queryByText("turn 0 user row")).toBeNull();
    expect(screen.getByText("turn 39 assistant row")).toBeTruthy();
    expect(controller.current?.isAtEnd()).toBe(true);
  });
});

function renderTranscript(
  conversation: AgentConversationVM,
  props: Partial<ComponentProps<typeof AgentTranscriptView>> = {}
) {
  return render(
    <div
      data-testid="agent-gui-timeline"
      style={{ height: "480px", overflow: "auto" }}
    >
      <AgentTranscriptView
        conversation={conversation}
        labels={LABELS}
        {...props}
      />
    </div>
  );
}

function conversationWithMultiRowTurns(turnCount: number): AgentConversationVM {
  const rows = Array.from({ length: turnCount }, (_, index) => [
    messageRow(index, "user", `turn ${index} user row`),
    messageRow(index, "assistant", `turn ${index} assistant row`)
  ]).flat();
  const session = normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    createdAtUnixMs: 1,
    cwd: "/workspace/demo",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    providerSessionId: "provider-session-1",
    title: "Codex",
    updatedAtUnixMs: 10,
    userId: "user-1",
    workspaceId: "workspace-1"
  });
  const activity = {
    agentName: "Codex",
    agentProvider: "codex" as const,
    changedFiles: [],
    id: "activity-1",
    latestActivitySummary: "Working",
    sessionId: "session-1",
    sortTimeUnixMs: 10,
    status: "working" as const,
    title: "Codex",
    userAvatarUrl: "",
    userId: "user-1",
    userName: "Taylor"
  };
  return {
    activity,
    rows,
    sourceDetail: {
      activity,
      cwd: "/workspace/demo",
      session,
      showProcessingIndicator: false,
      turns: Array.from({ length: turnCount }, (_, index) => ({
        agentItems: [],
        agentMessages: [],
        hasFailedToolCall: false,
        id: `turn-${index}`,
        toolCallCount: 0,
        toolCalls: [],
        userMessage: null,
        userMessages: []
      })),
      workspaceRoot: "/workspace/demo"
    },
    workspaceRoot: "/workspace/demo"
  };
}

function messageRow(
  index: number,
  speaker: "user" | "assistant",
  body: string
): AgentTranscriptRowVM {
  return {
    id: `${speaker}-row-${index}`,
    kind: "message",
    messages: [
      {
        body,
        id: `${speaker}-message-${index}`,
        kind: "message-content",
        occurredAtUnixMs: index,
        presentationKind: "content",
        turnId: `turn-${index}`
      }
    ],
    occurredAtUnixMs: index,
    speaker,
    thinking: [],
    turnId: `turn-${index}`
  };
}
