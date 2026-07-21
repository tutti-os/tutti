import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";

const virtualizerMockState = vi.hoisted(() => ({
  centerIndex: 10,
  getVirtualItemForOffset: vi.fn(),
  scrollOffset: 1_000,
  scrollRect: { height: 480, width: 800 },
  virtualIndexes: [100, 101, 102, 103, 104],
  scrollToIndex: vi.fn(),
  instance: {
    shouldAdjustScrollPositionOnItemSizeChange: undefined as
      | undefined
      | (() => boolean)
  }
}));

vi.mock("../../../i18n/index", () => ({
  getActiveUiLanguage: () => "en",
  useTranslation: () => ({
    t: (key: string) => key
  }),
  translate: (key: string) => key
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(() =>
    Object.assign(virtualizerMockState.instance, {
      getTotalSize: () => 20000,
      getVirtualItems: () =>
        virtualizerMockState.virtualIndexes.map((index) => ({
          index,
          key: `virtual-${index}`,
          start: index * 100,
          size: 100
        })),
      getVirtualItemForOffset: virtualizerMockState.getVirtualItemForOffset,
      measureElement: vi.fn(),
      scrollOffset: virtualizerMockState.scrollOffset,
      scrollRect: virtualizerMockState.scrollRect,
      scrollToIndex: virtualizerMockState.scrollToIndex
    })
  )
}));

import { useVirtualizer } from "@tanstack/react-virtual";
import { AgentTranscriptView } from "./AgentTranscriptView";

describe("AgentTranscriptView virtual rendering", () => {
  beforeEach(() => {
    virtualizerMockState.centerIndex = 10;
    virtualizerMockState.getVirtualItemForOffset.mockReset();
    virtualizerMockState.getVirtualItemForOffset.mockImplementation(() => ({
      end: (virtualizerMockState.centerIndex + 1) * 100,
      index: virtualizerMockState.centerIndex,
      key: `virtual-${virtualizerMockState.centerIndex}`,
      lane: 0,
      size: 100,
      start: virtualizerMockState.centerIndex * 100
    }));
    virtualizerMockState.scrollOffset = 1_000;
    virtualizerMockState.scrollRect = { height: 480, width: 800 };
    virtualizerMockState.scrollToIndex.mockClear();
    virtualizerMockState.instance.shouldAdjustScrollPositionOnItemSizeChange =
      undefined;
  });

  it("does not virtualize normal short conversations", () => {
    virtualizerMockState.virtualIndexes = [0];

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithRows(12)}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files"
          }}
        />
      </div>
    );

    expect(
      document.querySelector("[data-agent-transcript-virtualized='true']")
    ).toBeNull();
    expect(screen.getByText("virtual transcript row 0")).toBeTruthy();
    expect(screen.getByText("virtual transcript row 11")).toBeTruthy();
  });

  it("virtualizes by turn and keeps all rows from the visible turn mounted together", async () => {
    virtualizerMockState.virtualIndexes = [10];

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithMultiRowTurns(40)}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files"
          }}
        />
      </div>
    );

    expect(useVirtualizer).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorTo: "end",
        count: 40,
        scrollEndThreshold: 24
      })
    );
    await waitFor(() => {
      expect(screen.getByText("turn 10 user row")).toBeTruthy();
      expect(screen.getByText("turn 10 assistant row")).toBeTruthy();
    });
    const virtualTurn = document.querySelector<HTMLElement>(
      "[data-agent-transcript-virtual-turn='turn-10']"
    );
    expect(virtualTurn?.style.paddingBottom).toBe("12px");
    expect(
      virtualTurn?.querySelectorAll(":scope > .agent-gui-transcript-row")
    ).toHaveLength(2);
    expect(
      virtualTurn?.querySelector("[data-agent-turn-work-section]")
    ).toBeNull();
    expect(screen.queryByText("turn 9 user row")).toBeNull();
    expect(screen.queryByText("turn 11 assistant row")).toBeNull();
  });

  it("keeps completed turn disclosure interactive inside the virtual window", async () => {
    virtualizerMockState.virtualIndexes = [10];

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithCollapsibleTurns(40)}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files"
          }}
        />
      </div>
    );

    await waitFor(() => {
      expect(screen.getByText("turn 10 assistant row")).toBeTruthy();
    });
    expect(
      screen.queryByRole("button", { name: "Thought process" })
    ).toBeNull();
    const timeline = screen.getByTestId("agent-gui-timeline");
    const header = document.querySelector<HTMLElement>(
      "[data-agent-turn-work-header='turn-10']"
    )!;
    timeline.scrollTop = 900;
    vi.spyOn(header, "getBoundingClientRect").mockImplementation(
      () => ({ top: 80 - (timeline.scrollTop - 900) }) as DOMRect
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.expandTurnWork"
      })
    );

    expect(vi.mocked(useVirtualizer).mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ anchorTo: "start" })
    );
    expect(
      virtualizerMockState.instance.shouldAdjustScrollPositionOnItemSizeChange?.()
    ).toBe(false);
    expect(timeline.style.getPropertyValue("overflow-anchor")).toBe("none");
    timeline.scrollTop = 940;
    fireEvent.scroll(timeline);
    expect(timeline.scrollTop).toBe(900);

    await flushCollapsibleRevealFrames();
    const reveal = screen
      .getByRole("button", { name: "Thought process" })
      .closest(".agent-collapsible-reveal");
    expect(
      document.querySelector("[data-agent-transcript-virtual-turn='turn-10']")
    ).toBeTruthy();
    expect(
      document.querySelector<HTMLElement>(
        "[data-agent-transcript-virtual-turn='turn-10']"
      )?.style.paddingBottom
    ).toBe("24px");
    fireEvent.transitionEnd(reveal as HTMLElement, {
      propertyName: "height"
    });

    await waitFor(() => {
      expect(vi.mocked(useVirtualizer).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ anchorTo: "end" })
      );
      expect(
        virtualizerMockState.instance.shouldAdjustScrollPositionOnItemSizeChange
      ).toBeUndefined();
    });
    timeline.scrollTop = 940;
    fireEvent.scroll(timeline);
    expect(timeline.scrollTop).toBe(940);
    expect(timeline.style.getPropertyValue("overflow-anchor")).toBe("");
  });

  it("pins a disclosure row in a non-virtual transcript", () => {
    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithCollapsibleTurns(2)}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files"
          }}
        />
      </div>
    );
    const timeline = screen.getByTestId("agent-gui-timeline");
    const header = document.querySelector<HTMLElement>(
      "[data-agent-turn-work-header='turn-0']"
    )!;
    timeline.scrollTop = 200;
    vi.spyOn(header, "getBoundingClientRect").mockImplementation(
      () => ({ top: 40 - (timeline.scrollTop - 200) }) as DOMRect
    );

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "agentHost.agentGui.expandTurnWork"
      })[0]!
    );
    timeline.scrollTop = 240;
    fireEvent.scroll(timeline);

    expect(timeline.scrollTop).toBe(200);
  });

  it("enables virtualization once the transcript reaches 30 turns", () => {
    virtualizerMockState.virtualIndexes = [29];

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithRows(30)}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files"
          }}
        />
      </div>
    );

    expect(useVirtualizer).toHaveBeenCalled();
  });

  it("keeps one complex turn in normal flow because virtualization cannot elide it", () => {
    virtualizerMockState.virtualIndexes = [0];

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithRows(1, {
            body: [
              "Complex turn intro.",
              "x".repeat(9000),
              "```ts",
              "const result = runLargeExample();",
              "```",
              "```json",
              '{"ok":true}',
              "```",
              "| File | Status |",
              "| --- | --- |",
              "| app.tsx | updated |",
              "![Preview](preview.png)"
            ].join("\n")
          })}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files"
          }}
        />
      </div>
    );

    expect(
      document.querySelector("[data-agent-transcript-virtualized='true']")
    ).toBeNull();
    expect(
      document.querySelector("[data-agent-transcript-row='row-0']")
    ).toBeTruthy();
  });

  it("renders only the virtualized transcript window for long conversations", async () => {
    virtualizerMockState.virtualIndexes = [100, 101, 102, 103, 104];

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithRows(200)}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files"
          }}
        />
      </div>
    );

    expect(useVirtualizer).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText("virtual transcript row 100")).toBeTruthy();
      expect(screen.getByText("virtual transcript row 104")).toBeTruthy();
    });
    expect(screen.queryByText("virtual transcript row 0")).toBeNull();
    expect(screen.queryByText("virtual transcript row 199")).toBeNull();
  });

  it("uses the timeline viewport when locating an unmounted virtualized message", async () => {
    virtualizerMockState.virtualIndexes = [10];

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <div data-slot="scroll-area-content">
          <AgentTranscriptView
            conversation={conversationWithMultiRowTurns(40)}
            labels={{
              thinkingLabel: "Thought process",
              toolCallsLabel: (count) => `Tool calls (${count})`,
              processing: "Planning next moves",
              turnSummary: "Changed files",
              userMessageLocator: "User messages"
            }}
          />
        </div>
      </div>
    );

    await waitFor(() => {
      const virtualizerOptions = vi
        .mocked(useVirtualizer)
        .mock.calls.at(-1)?.[0];
      expect(virtualizerOptions?.getScrollElement()).toBe(
        screen.getByTestId("agent-gui-timeline")
      );
    });

    fireEvent.click(
      screen
        .getByTestId("agent-message-locator")
        .querySelectorAll(".agent-gui-message-locator__tick")[0]!
    );

    expect(virtualizerMockState.scrollToIndex).toHaveBeenCalledWith(0, {
      align: "center"
    });
  });

  it("selects an unmounted locator item from virtual measurements", async () => {
    virtualizerMockState.centerIndex = 18;
    virtualizerMockState.virtualIndexes = [10];

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithMultiRowTurns(40)}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files",
            userMessageLocator: "User messages"
          }}
        />
      </div>
    );

    const timeline = screen.getByTestId("agent-gui-timeline");
    timeline.scrollTop = 1_000;
    const timelineQuerySelector = vi.spyOn(timeline, "querySelector");
    fireEvent.scroll(timeline);

    await waitFor(() => {
      const ticks = screen
        .getByTestId("agent-message-locator")
        .querySelectorAll(".agent-gui-message-locator__tick");
      expect(ticks[18]).toHaveAttribute("data-selected", "true");
      expect(ticks[10]).not.toHaveAttribute("data-selected");
    });
    expect(screen.queryByText("turn 18 user row")).toBeNull();
    expect(virtualizerMockState.getVirtualItemForOffset).toHaveBeenCalledWith(
      1_240
    );
    expect(
      timelineQuerySelector.mock.calls.some(([selector]) =>
        String(selector).includes("data-agent-transcript-row")
      )
    ).toBe(false);
  });

  it("selects the preceding user message when the centered turn has no user row", async () => {
    virtualizerMockState.centerIndex = 18;
    virtualizerMockState.virtualIndexes = [18];
    const conversation = conversationWithMultiRowTurns(40);
    const sparseUserConversation: AgentConversationVM = {
      ...conversation,
      rows: conversation.rows.map((row) =>
        row.kind === "message" &&
        row.speaker === "user" &&
        Number(row.turnId?.replace("turn-", "")) > 9
          ? { ...row, speaker: "assistant" as const }
          : row
      )
    };

    render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={sparseUserConversation}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files",
            userMessageLocator: "User messages"
          }}
        />
      </div>
    );

    const timeline = screen.getByTestId("agent-gui-timeline");
    timeline.scrollTop = 1_000;
    fireEvent.scroll(timeline);

    await waitFor(() => {
      const ticks = screen
        .getByTestId("agent-message-locator")
        .querySelectorAll(".agent-gui-message-locator__tick");
      expect(ticks).toHaveLength(10);
      expect(ticks[9]).toHaveAttribute("data-selected", "true");
    });
  });

  it("keeps the timeline viewport bound across long-short-long switches", async () => {
    virtualizerMockState.virtualIndexes = [10];
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files"
    };
    const { rerender } = render(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithMultiRowTurns(40)}
          labels={labels}
        />
      </div>
    );
    const timeline = screen.getByTestId("agent-gui-timeline");

    await waitFor(() => {
      expect(
        vi.mocked(useVirtualizer).mock.calls.at(-1)?.[0].getScrollElement()
      ).toBe(timeline);
    });

    rerender(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithRows(2)}
          labels={labels}
        />
      </div>
    );

    await waitFor(() => {
      expect(
        vi.mocked(useVirtualizer).mock.calls.at(-1)?.[0].getScrollElement()
      ).toBe(timeline);
    });

    rerender(
      <div
        data-testid="agent-gui-timeline"
        style={{ height: "480px", overflow: "auto" }}
      >
        <AgentTranscriptView
          conversation={conversationWithMultiRowTurns(40)}
          labels={labels}
        />
      </div>
    );

    expect(
      vi.mocked(useVirtualizer).mock.calls.at(-1)?.[0].getScrollElement()
    ).toBe(timeline);
  });
});

function conversationWithRows(
  rowCount: number,
  options: { body?: string } = {}
): AgentConversationVM {
  const rows = Array.from({ length: rowCount }, (_, index) =>
    messageRow(index, options.body ? { body: options.body } : {})
  );
  return {
    activity: {
      id: "activity-1",
      sessionId: "session-1",
      agentName: "Codex",
      agentProvider: "codex",
      status: "working",
      title: "Codex",
      latestActivitySummary: "Working",
      sortTimeUnixMs: 10,
      changedFiles: [],
      userId: "user-1",
      userName: "Taylor",
      userAvatarUrl: ""
    },
    workspaceRoot: "/workspace/demo",
    sourceDetail: {
      activity: {
        id: "activity-1",
        sessionId: "session-1",
        agentName: "Codex",
        agentProvider: "codex",
        title: "Codex",
        latestActivitySummary: "Working",
        status: "working",
        sortTimeUnixMs: 10,
        changedFiles: [],
        userId: "user-1",
        userName: "Taylor",
        userAvatarUrl: ""
      },
      session: normalizeAgentActivitySession({
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        userId: "user-1",
        provider: "codex",
        providerSessionId: "provider-session-1",
        cwd: "/workspace/demo",
        title: "Codex",
        createdAtUnixMs: 1,
        updatedAtUnixMs: 10
      }),
      cwd: "/workspace/demo",
      workspaceRoot: "/workspace/demo",
      turns: rows.map((row) => ({
        id: row.turnId ?? row.id,
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [],
        toolCallCount: 0,
        hasFailedToolCall: false,
        agentItems: []
      })),
      showProcessingIndicator: false
    },
    rows
  };
}

function conversationWithMultiRowTurns(turnCount: number): AgentConversationVM {
  const rows = Array.from({ length: turnCount }, (_, index) => [
    messageRow(index, {
      idPrefix: "user-row",
      messagePrefix: "user-message",
      speaker: "user",
      body: `turn ${index} user row`
    }),
    messageRow(index, {
      idPrefix: "assistant-row",
      messagePrefix: "assistant-message",
      speaker: "assistant",
      body: `turn ${index} assistant row`
    })
  ]).flat();

  return {
    ...conversationWithRows(0),
    rows,
    sourceDetail: {
      ...conversationWithRows(0).sourceDetail,
      turns: Array.from({ length: turnCount }, (_, index) => ({
        id: `turn-${index}`,
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [],
        toolCallCount: 0,
        hasFailedToolCall: false,
        agentItems: []
      }))
    }
  };
}

function conversationWithCollapsibleTurns(
  turnCount: number
): AgentConversationVM {
  const conversation = conversationWithMultiRowTurns(turnCount);
  return {
    ...conversation,
    rows: conversation.rows.map((row) =>
      row.kind === "message" && row.speaker === "assistant"
        ? {
            ...row,
            messages: row.messages.map((message) => ({
              ...message,
              copyText: message.body,
              isTurnFinalText: true as const
            })),
            thinking: [
              {
                kind: "thinking-content" as const,
                id: `thinking-${row.turnId}`,
                turnId: row.turnId,
                body: `${row.turnId.replace("turn-", "turn ")} thinking`,
                occurredAtUnixMs: 2
              }
            ]
          }
        : row
    ),
    sourceDetail: {
      ...conversation.sourceDetail,
      sessionTurns: Array.from({ length: turnCount }, (_, index) => ({
        agentSessionId: "session-1",
        origin: "user_prompt" as const,
        phase: "settled" as const,
        outcome: "completed" as const,
        startedAtUnixMs: 1,
        settledAtUnixMs: 3,
        turnId: `turn-${index}`,
        updatedAtUnixMs: 3
      }))
    }
  };
}

async function flushCollapsibleRevealFrames(): Promise<void> {
  await flushAnimationFrame();
  await flushAnimationFrame();
}

async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function messageRow(
  index: number,
  overrides: {
    idPrefix?: string;
    messagePrefix?: string;
    speaker?: "user" | "assistant";
    body?: string;
  } = {}
): AgentTranscriptRowVM {
  const speaker = overrides.speaker ?? "assistant";
  return {
    kind: "message",
    id: `${overrides.idPrefix ?? "row"}-${index}`,
    turnId: `turn-${index}`,
    speaker,
    messages: [
      {
        kind: "message-content",
        id: `${overrides.messagePrefix ?? "message"}-${index}`,
        turnId: `turn-${index}`,
        body: overrides.body ?? `virtual transcript row ${index}`,
        presentationKind: "content",
        occurredAtUnixMs: index
      }
    ],
    thinking: [],
    occurredAtUnixMs: index
  };
}
