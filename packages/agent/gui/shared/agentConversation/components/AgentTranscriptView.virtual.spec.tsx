import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";

const virtualizerMockState = vi.hoisted(() => ({
  virtualIndexes: [100, 101, 102, 103, 104]
}));

vi.mock("../../../i18n/index", () => ({
  useTranslation: () => ({
    t: (key: string) => key
  }),
  translate: (key: string) => key
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(() => ({
    getTotalSize: () => 20000,
    getVirtualItems: () =>
      virtualizerMockState.virtualIndexes.map((index) => ({
        index,
        key: `virtual-${index}`,
        start: index * 100,
        size: 100
      })),
    measureElement: vi.fn()
  }))
}));

import { useVirtualizer } from "@tanstack/react-virtual";
import { AgentTranscriptView } from "./AgentTranscriptView";

describe("AgentTranscriptView virtual rendering", () => {
  it("does not virtualize normal short conversations", () => {
    virtualizerMockState.virtualIndexes = [0];

    render(
      <div style={{ height: "480px", overflow: "auto" }}>
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

  it("virtualizes by turn and keeps all rows from the visible turn mounted together", () => {
    virtualizerMockState.virtualIndexes = [10];

    render(
      <div style={{ height: "480px", overflow: "auto" }}>
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
      expect.objectContaining({ count: 40 })
    );
    expect(screen.getByText("turn 10 user row")).toBeTruthy();
    expect(screen.getByText("turn 10 assistant row")).toBeTruthy();
    expect(screen.queryByText("turn 9 user row")).toBeNull();
    expect(screen.queryByText("turn 11 assistant row")).toBeNull();
  });

  it("enables virtualization once the transcript reaches 30 turns", () => {
    virtualizerMockState.virtualIndexes = [29];

    render(
      <div style={{ height: "480px", overflow: "auto" }}>
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

  it("enables virtualization for one complex turn", () => {
    virtualizerMockState.virtualIndexes = [0];

    render(
      <div style={{ height: "480px", overflow: "auto" }}>
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
    ).toBeTruthy();
    expect(
      document.querySelector("[data-agent-transcript-row='row-0']")
    ).toBeTruthy();
  });

  it("renders only the virtualized transcript window for long conversations", () => {
    virtualizerMockState.virtualIndexes = [100, 101, 102, 103, 104];

    render(
      <div style={{ height: "480px", overflow: "auto" }}>
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
    expect(screen.queryByText("virtual transcript row 0")).toBeNull();
    expect(screen.getByText("virtual transcript row 100")).toBeTruthy();
    expect(screen.getByText("virtual transcript row 104")).toBeTruthy();
    expect(screen.queryByText("virtual transcript row 199")).toBeNull();
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
        status: "working",
        title: "Codex",
        latestActivitySummary: "Working",
        sortTimeUnixMs: 10,
        changedFiles: [],
        userId: "user-1",
        userName: "Taylor",
        userAvatarUrl: ""
      },
      session: {
        id: 1,
        agentSessionId: "session-1",
        presenceId: 1,
        userId: "user-1",
        provider: "codex",
        providerSessionId: "provider-session-1",
        sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
        cwd: "/workspace/demo",
        lifecycleStatus: "active",
        turnPhase: "working",
        effectiveStatus: "working",
        title: "Codex",
        createdAtUnixMs: 1,
        updatedAtUnixMs: 10
      },
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
    rows,
    pendingApproval: null,
    pendingInteractivePrompt: null
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
        occurredAtUnixMs: index
      }
    ],
    thinking: [],
    occurredAtUnixMs: index
  };
}
