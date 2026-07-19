import { describe, expect, it } from "vitest";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import {
  buildAgentConversationExportTurns,
  buildAgentConversationPrintConversation,
  classifyAgentConversationExportError,
  serializeAgentConversationExportMarkdown,
  suggestedAgentConversationExportFileName,
  toggleAgentConversationExportTurn
} from "./agentConversationExport";

describe("agent conversation export", () => {
  it("classifies a stale desktop main process instead of exposing the raw IPC error", () => {
    expect(
      classifyAgentConversationExportError(
        new Error(
          "Error invoking remote method 'host:files:exportAgentConversation': Error: No handler registered for 'host:files:exportAgentConversation'"
        )
      )
    ).toBe("desktop-restart-required");
    expect(classifyAgentConversationExportError(new Error("disk full"))).toBe(
      "unknown"
    );
  });

  it("only exposes paired, completed turns and keeps every row in timeline order", () => {
    const conversation = conversationWithRows([
      messageRow("user-1", "turn-1", "user", "Fix the build"),
      toolRow("tools-1", "turn-1", "Read package.json"),
      messageRow("assistant-1", "turn-1", "assistant", "The build is fixed"),
      messageRow("user-2", "turn-2", "user", "What changed?"),
      processingRow("turn-2")
    ]);

    const turns = buildAgentConversationExportTurns(conversation);

    expect(turns.map((turn) => turn.turnId)).toEqual(["turn-1"]);
    expect(turns[0]?.rows.map((row) => row.id)).toEqual([
      "user-1",
      "tools-1",
      "assistant-1"
    ]);
  });

  it("uses one selection bit for both sides of a turn", () => {
    const selected = toggleAgentConversationExportTurn(new Set(), "turn-1");
    expect([...selected]).toEqual(["turn-1"]);
    expect([...toggleAgentConversationExportTurn(selected, "turn-1")]).toEqual(
      []
    );
  });

  it("builds a print conversation containing only the selected turns", () => {
    const conversation = conversationWithRows([
      messageRow("user-1", "turn-1", "user", "First question"),
      messageRow("assistant-1", "turn-1", "assistant", "First answer"),
      messageRow("user-2", "turn-2", "user", "Second question"),
      messageRow("assistant-2", "turn-2", "assistant", "Second answer")
    ]);

    const printed = buildAgentConversationPrintConversation(
      conversation,
      new Set(["turn-2"])
    );

    expect(printed.rows.map((row) => row.id)).toEqual([
      "user-2",
      "assistant-2"
    ]);
    expect(printed.sourceDetail.session.activeTurnId).toBeNull();
  });

  it("exports prompts, execution records, file changes, and AI text without thinking", () => {
    const conversation = conversationWithRows([
      messageRow("user-1", "turn-1", "user", "Fix **the build**"),
      messageRow(
        "assistant-preface",
        "turn-1",
        "assistant",
        "I'll inspect the project first."
      ),
      {
        ...toolRow("tools-1", "turn-1", "Read package.json"),
        entries: [
          {
            kind: "thinking",
            thinking: {
              kind: "thinking-content",
              id: "thinking-1",
              turnId: "turn-1",
              body: "secret reasoning",
              occurredAtUnixMs: 2
            }
          },
          {
            kind: "tool-call",
            call: {
              kind: "tool-call",
              id: "call-1",
              turnId: "turn-1",
              name: "Read",
              toolName: "read_file",
              callType: "tool",
              status: "Completed",
              statusKind: "completed",
              summary: "Read package.json",
              compactSummary: null,
              toolState: null,
              input: null,
              output: null,
              error: null,
              metadata: null,
              content: null,
              locations: null,
              rendererKind: "read",
              approval: null,
              planMode: null,
              askUserQuestion: null,
              task: null,
              payload: { path: "package.json" },
              occurredAtUnixMs: 2
            }
          }
        ]
      },
      {
        kind: "turn-summary",
        id: "summary-1",
        turnId: "turn-1",
        files: [
          {
            label: "src/app.ts",
            path: "src/app.ts",
            fileName: "app.ts",
            directory: "src",
            changeType: "modified",
            toolName: "edit_file",
            messageId: "message-1",
            occurredAtUnixMs: 3
          }
        ],
        fileCount: 1,
        modifiedCount: 1,
        createdCount: 0,
        occurredAtUnixMs: 3
      },
      messageRow("assistant-1", "turn-1", "assistant", "Done. Run `pnpm test`.")
    ]);
    const turns = buildAgentConversationExportTurns(conversation);

    const markdown = serializeAgentConversationExportMarkdown({
      labels: {
        agentText: "AI text",
        executionRecord: "Execution record",
        fileChanges: "File changes",
        prompt: "User prompt",
        questionAnswer: (index) => `Question ${index}`,
        toolCalls: (count) => `Tool calls (${count})`
      },
      expandedToolRowKeys: new Set(["tools-1"]),
      title: "Build repair",
      turns
    });

    expect(markdown).toContain("# Build repair");
    expect(markdown).toContain("Fix **the build**");
    expect(markdown).toContain("Read package.json");
    expect(markdown).toContain('"path": "package.json"');
    expect(markdown).toContain("src/app.ts");
    expect(markdown).toContain("Done. Run `pnpm test`.");
    expect(markdown.match(/### AI text/g)).toHaveLength(2);
    expect(markdown).not.toContain("secret reasoning");
    expect(markdown.indexOf("Read package.json")).toBeLessThan(
      markdown.indexOf("Done. Run")
    );
  });

  it("only exports the visible summary for collapsed tool groups", () => {
    const groupedToolRow = {
      ...toolRow("tools-1", "turn-1", "Read package.json"),
      calls: [
        {
          kind: "tool-call" as const,
          id: "call-1",
          turnId: "turn-1",
          name: "Read",
          toolName: "read_file",
          callType: "tool",
          status: "Completed",
          statusKind: "completed" as const,
          summary: "Read package.json",
          compactSummary: null,
          toolState: null,
          input: null,
          output: null,
          error: null,
          metadata: null,
          content: null,
          locations: null,
          rendererKind: "read" as const,
          approval: null,
          planMode: null,
          askUserQuestion: null,
          task: null,
          payload: { path: "package.json" },
          occurredAtUnixMs: 2
        }
      ],
      entries: [
        {
          kind: "tool-call" as const,
          call: {
            kind: "tool-call" as const,
            id: "call-1",
            turnId: "turn-1",
            name: "Read",
            toolName: "read_file",
            callType: "tool",
            status: "Completed",
            statusKind: "completed" as const,
            summary: "Read package.json",
            compactSummary: null,
            toolState: null,
            input: null,
            output: null,
            error: null,
            metadata: null,
            content: null,
            locations: null,
            rendererKind: "read" as const,
            approval: null,
            planMode: null,
            askUserQuestion: null,
            task: null,
            payload: { path: "package.json" },
            occurredAtUnixMs: 2
          }
        }
      ]
    };
    const turns = buildAgentConversationExportTurns(
      conversationWithRows([
        messageRow("user-1", "turn-1", "user", "Fix the build"),
        groupedToolRow,
        messageRow("assistant-1", "turn-1", "assistant", "Done")
      ])
    );
    const labels = {
      agentText: "AI text",
      executionRecord: "Execution record",
      fileChanges: "File changes",
      prompt: "User prompt",
      questionAnswer: (index: number) => `Question ${index}`,
      toolCalls: (count: number) => `Tool calls (${count})`
    };

    const collapsed = serializeAgentConversationExportMarkdown({
      expandedToolRowKeys: new Set(),
      labels,
      title: "Build repair",
      turns
    });
    const expanded = serializeAgentConversationExportMarkdown({
      expandedToolRowKeys: new Set(["tools-1"]),
      labels,
      title: "Build repair",
      turns
    });

    expect(collapsed).toContain("Tool calls (1)");
    expect(collapsed).not.toContain('"path": "package.json"');
    expect(expanded).toContain('"path": "package.json"');
  });

  it("builds the default filename from local time, six Unicode characters, and the UUID prefix", () => {
    expect(
      suggestedAgentConversationExportFileName({
        format: "pdf",
        now: new Date(2026, 6, 19, 8, 9, 5),
        openingText: "你好😀世界abc",
        sessionId: "abcdef12-3456-7890-abcd-ef1234567890"
      })
    ).toBe("2026.07.19-08.09.05_你好😀世界a_abcdef.pdf");
  });
});

function conversationWithRows(
  rows: AgentConversationVM["rows"]
): AgentConversationVM {
  return {
    activity: {
      id: "activity-1",
      sessionId: "session-1",
      agentName: "Codex",
      agentProvider: "codex",
      title: "Build repair",
      latestActivitySummary: "Done",
      status: "idle",
      sortTimeUnixMs: 10,
      changedFiles: [],
      userId: "user-1",
      userName: "Taylor",
      userAvatarUrl: ""
    },
    workspaceRoot: "/workspace",
    sourceDetail: {
      activity: {} as AgentConversationVM["sourceDetail"]["activity"],
      session: {
        agentSessionId: "session-1",
        activeTurnId: null
      } as AgentConversationVM["sourceDetail"]["session"],
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      turns: []
    },
    rows
  };
}

function messageRow(
  id: string,
  turnId: string,
  speaker: "user" | "assistant",
  body: string
): Extract<AgentConversationVM["rows"][number], { kind: "message" }> {
  return {
    kind: "message",
    id,
    turnId,
    speaker,
    messages: [
      {
        kind: "message-content",
        id: `${id}-content`,
        turnId,
        body,
        presentationKind: "content",
        occurredAtUnixMs: 1
      }
    ],
    thinking: [],
    occurredAtUnixMs: 1
  };
}

function toolRow(
  id: string,
  turnId: string,
  summary: string
): Extract<AgentConversationVM["rows"][number], { kind: "tool-group" }> {
  return {
    kind: "tool-group",
    id,
    turnId,
    grouped: true,
    calls: [],
    entries: [],
    summary,
    occurredAtUnixMs: 2
  };
}

function processingRow(
  turnId: string
): Extract<AgentConversationVM["rows"][number], { kind: "processing" }> {
  return {
    kind: "processing",
    id: `processing-${turnId}`,
    turnId,
    label: "Processing",
    occurredAtUnixMs: 4
  };
}
