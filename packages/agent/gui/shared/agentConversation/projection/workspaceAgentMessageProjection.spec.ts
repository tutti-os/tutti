import { describe, expect, it } from "vitest";
import {
  normalizeAgentActivitySession,
  type AgentActivityMessage,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityCard } from "../../workspaceAgentActivityListViewModel";
import { projectWorkspaceAgentMessagesToConversationVM } from "./workspaceAgentMessageProjection";

describe("projectWorkspaceAgentMessagesToConversationVM", () => {
  it("sorts message rows by stable message version instead of source-local ids", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      messages: [
        message({
          messageId: "assistant-1",
          version: 2,
          role: "assistant",
          kind: "text",
          payload: { text: "Second by id" }
        }),
        message({
          messageId: "user-1",
          version: 1,
          role: "user",
          kind: "text",
          payload: { text: "First by id" }
        })
      ]
    });

    const rows = conversation.rows.filter((row) => row.kind === "message");
    expect(rows[0]?.kind === "message" ? rows[0].speaker : null).toBe("user");
    expect(rows[0]?.kind === "message" ? rows[0].messages[0]?.body : null).toBe(
      "First by id"
    );
    expect(rows[1]?.kind === "message" ? rows[1].speaker : null).toBe(
      "assistant"
    );
    expect(rows[1]?.kind === "message" ? rows[1].messages[0]?.body : null).toBe(
      "Second by id"
    );
  });

  it("keeps status panel order aligned with stream order when snapshot ids differ", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session({ effectiveStatus: "working" }),
      messages: [
        message({
          messageId: "assistant-intro",
          version: 1,
          role: "assistant",
          kind: "text",
          payload: { text: "I will inspect the repo." }
        }),
        message({
          messageId: "reasoning-1",
          version: 5,
          role: "assistant",
          kind: "reasoning",
          status: "completed",
          payload: { text: "Thinking after the active tool update." }
        }),
        message({
          messageId: "tool-1",
          version: 2,
          role: "assistant",
          kind: "tool_call",
          status: "completed",
          payload: { callId: "list-1", title: "List" }
        }),
        message({
          messageId: "tool-2",
          version: 3,
          role: "assistant",
          kind: "tool_call",
          status: "completed",
          payload: { callId: "read-1", title: "Read" }
        }),
        message({
          messageId: "tool-3",
          version: 4,
          role: "assistant",
          kind: "tool_call",
          status: "running",
          payload: { callId: "fetch-1", title: "读取网页" }
        })
      ]
    });

    expect(
      conversation.rows.map((row) => {
        if (row.kind === "message") {
          if (row.messages.length > 0) {
            return row.messages[0]?.body;
          }
          return row.thinking[0]?.body;
        }
        if (row.kind === "tool-group") {
          return row.calls.map((call) => call.name).join(",");
        }
        return row.kind;
      })
    ).toEqual([
      "I will inspect the repo.",
      "List,Read file",
      "读取网页",
      "Thinking after the active tool update."
    ]);
  });

  it("orders late completed tool calls by start time before the final assistant answer", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      messages: [
        message({
          messageId: "user-1",
          version: 1,
          role: "user",
          kind: "text",
          payload: { text: "Inspect AI Canvas" },
          occurredAtUnixMs: 100,
          startedAtUnixMs: 100
        }),
        message({
          messageId: "toolcall:search-1",
          version: 4,
          role: "assistant",
          kind: "tool_call",
          status: "completed",
          payload: {
            callId: "search-1",
            title: "Bash",
            toolName: "Bash",
            input: { command: "rg 陶瓷家具与冲浪 /Users/Sun" }
          },
          startedAtUnixMs: 110,
          occurredAtUnixMs: 400,
          completedAtUnixMs: 400
        }),
        message({
          messageId: "assistant-final",
          version: 3,
          role: "assistant",
          kind: "text",
          payload: { text: "项目里有图片和视频。" },
          occurredAtUnixMs: 300,
          startedAtUnixMs: 300
        })
      ]
    });

    expect(
      conversation.rows.map((row) => {
        if (row.kind === "message") {
          return `${row.speaker}:${row.messages[0]?.body}`;
        }
        if (row.kind === "tool-group") {
          return `tool:${row.calls[0]?.toolName}`;
        }
        return row.kind;
      })
    ).toEqual([
      "user:Inspect AI Canvas",
      "tool:Bash",
      "assistant:项目里有图片和视频。"
    ]);
  });

  it("projects text, reasoning, errors, and unknown kinds conservatively", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session({ effectiveStatus: "failed", turnPhase: "failed" }),
      messages: [
        message({
          messageId: "user-1",
          role: "user",
          kind: "text",
          payload: { text: "Inspect this" }
        }),
        message({
          messageId: "thinking-1",
          role: "assistant",
          kind: "reasoning",
          payload: { text: "Need to inspect first." }
        }),
        message({
          messageId: "assistant-1",
          role: "assistant",
          kind: "text",
          payload: { text: "I found the issue." }
        }),
        message({
          messageId: "error-1",
          role: "assistant",
          kind: "error",
          status: "failed",
          payload: { title: "Agent failed", text: "Config invalid" }
        }),
        message({
          messageId: "unknown-1",
          role: "assistant",
          kind: "provider_notice",
          payload: { title: "Provider notice", text: "Notice text" }
        })
      ]
    });

    const messageRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > => row.kind === "message"
    );
    expect(messageRows.map((row) => row.speaker)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant"
    ]);
    expect(
      messageRows.flatMap((row) => row.thinking.map((item) => item.body))
    ).toContain("Need to inspect first.");
    expect(
      messageRows.flatMap((row) => row.messages.map((item) => item.body))
    ).toContain("Agent failed\n\nConfig invalid");
    expect(
      messageRows.flatMap((row) => row.messages.map((item) => item.body))
    ).toContain("Provider notice\n\nNotice text");
  });

  it("projects only the latest text snapshot for a stable message id", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      messages: [
        message({
          messageId: "assistant-stream-1",
          version: 1,
          role: "assistant",
          kind: "text",
          payload: { text: "I'll " }
        }),
        message({
          messageId: "assistant-stream-1",
          id: 1,
          version: 2,
          role: "assistant",
          kind: "text",
          payload: { text: "I'll check " }
        }),
        message({
          messageId: "assistant-stream-1",
          id: 1,
          version: 3,
          role: "assistant",
          kind: "text",
          payload: { text: "I'll check the repo." }
        }),
        message({
          messageId: "assistant-stream-2",
          id: 2,
          version: 4,
          role: "assistant",
          kind: "text",
          payload: { text: "Distinct message." }
        })
      ]
    });

    const bodies = conversation.rows
      .filter(
        (
          row
        ): row is Extract<
          (typeof conversation.rows)[number],
          { kind: "message" }
        > => row.kind === "message"
      )
      .flatMap((row) => row.messages.map((item) => item.body));
    expect(bodies).toEqual(["I'll check the repo.Distinct message."]);
  });

  it("projects only the latest reasoning snapshot for a stable message id", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      messages: [
        message({
          messageId: "reasoning-stream-1",
          id: 1,
          version: 1,
          role: "assistant",
          kind: "reasoning",
          payload: { text: "Looking " }
        }),
        message({
          messageId: "reasoning-stream-1",
          id: 1,
          version: 2,
          role: "assistant",
          kind: "reasoning",
          payload: { text: "Looking through files." }
        })
      ]
    });

    const thinkingBodies = conversation.rows
      .filter(
        (
          row
        ): row is Extract<
          (typeof conversation.rows)[number],
          { kind: "message" }
        > => row.kind === "message"
      )
      .flatMap((row) => row.thinking.map((item) => item.body));
    expect(thinkingBodies).toEqual(["Looking through files."]);
  });

  it("projects matching tool_call updates into one stable action row", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      messages: [
        message({
          messageId: "tool-1",
          id: 1,
          version: 1,
          role: "assistant",
          kind: "tool_call",
          status: "running",
          payload: {
            callId: "read-1",
            title: "Read",
            toolName: "Read",
            input: { path: "/workspace/demo/README.md" }
          }
        }),
        message({
          messageId: "tool-1",
          id: 1,
          version: 2,
          role: "assistant",
          kind: "tool_call",
          status: "completed",
          payload: {
            callId: "read-1",
            title: "Read",
            output: { text: "README contents" }
          }
        })
      ]
    });

    const toolRows = conversation.rows.filter(
      (row) => row.kind === "tool-group"
    );
    expect(toolRows).toHaveLength(1);
    const call = toolRows[0]?.calls[0];
    expect(call?.id).toBe("call:read-1");
    expect(call?.statusKind).toBe("completed");
    expect(call?.input).toEqual({ path: "/workspace/demo/README.md" });
    expect(call?.output).toEqual({ text: "README contents" });
  });

  it("projects durable AskUserQuestion tool_call messages as pending interactive prompts", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session({
        effectiveStatus: "working",
        turnPhase: "working"
      }),
      messages: [
        message({
          messageId: "toolcall:call-ask",
          id: 1,
          version: 1,
          role: "assistant",
          kind: "tool_call",
          status: "running",
          payload: {
            callId: "call-ask",
            callType: "interactive",
            title: "AskUserQuestion",
            toolName: "AskUserQuestion",
            status: "streaming",
            input: {
              requestId: "request-ask",
              toolName: "AskUserQuestion",
              questions: [
                {
                  id: "favorite-color",
                  header: "Color",
                  question: "What's your favorite color?",
                  options: [
                    {
                      label: "Green",
                      description: "Pick green"
                    }
                  ]
                }
              ]
            },
            metadata: {
              adapter: "claude-agent-sdk",
              callType: "interactive",
              interactiveKind: "ask-user",
              toolName: "AskUserQuestion"
            }
          }
        })
      ]
    });

    expect(conversation.pendingInteractivePrompt).toEqual({
      kind: "ask-user",
      requestId: "request-ask",
      title: "Ask User Question",
      questions: [
        {
          id: "favorite-color",
          header: "Color",
          question: "What's your favorite color?",
          options: [{ label: "Green", description: "Pick green" }],
          multiSelect: false,
          answer: null
        }
      ]
    });
  });

  it("does not use opaque call ids as tool names", () => {
    const opaqueCallId = "call_SMAI3q45S9s5TwOqO8R7ZMdU";
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      messages: [
        message({
          messageId: `toolcall:${opaqueCallId}`,
          id: 1,
          role: "assistant",
          kind: "tool_call",
          status: "completed",
          payload: {
            callId: opaqueCallId,
            title: opaqueCallId,
            callType: "tool",
            toolName: "Bash",
            input: { command: "pwd" }
          }
        })
      ]
    });

    const toolRows = conversation.rows.filter(
      (row) => row.kind === "tool-group"
    );
    const call = toolRows[0]?.calls[0];
    expect(call?.toolName).toBe("Bash");
    expect(call?.name).not.toContain("SMAI3q45");
  });

  it("normalizes subagent tool variants into agent tool names", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      messages: [
        message({
          messageId: "toolcall:delegate-1",
          id: 1,
          role: "assistant",
          kind: "tool_call",
          status: "completed",
          payload: {
            callId: "delegate-1",
            title: "delegate_task",
            callType: "tool",
            toolName: "Task",
            input: { task: "review this change" }
          }
        })
      ]
    });

    const toolRows = conversation.rows.filter(
      (row) => row.kind === "tool-group"
    );
    expect(toolRows[0]?.calls[0]?.toolName).toBe("Agent");
  });

  it("projects Codex warning notices without appending them to assistant text", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      messages: [
        message({
          messageId: "user-1",
          id: 1,
          version: 1,
          role: "user",
          kind: "text",
          payload: { text: "你好" }
        }),
        message({
          messageId: "notice-1",
          id: 2,
          version: 2,
          role: "assistant",
          kind: "text",
          payload: {
            kind: "agent_system_notice",
            noticeKind: "warning",
            severity: "warning",
            title: "Codex warning",
            detail:
              "Skill descriptions were shortened to fit the 2% skills context budget.",
            text: "Codex warning",
            content: "Codex warning",
            contentMode: "snapshot"
          }
        }),
        message({
          messageId: "assistant-1",
          id: 3,
          version: 3,
          role: "assistant",
          kind: "text",
          payload: {
            text: "你好。有什么需要我在这个 workspace 里处理?"
          }
        })
      ]
    });

    const assistantRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > => row.kind === "message" && row.speaker === "assistant"
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.messages[0]?.systemNotice).toEqual({
      noticeKind: "warning",
      severity: "warning",
      title: "Codex warning",
      detail:
        "Skill descriptions were shortened to fit the 2% skills context budget.",
      retryable: null
    });
    expect(assistantRows[0]?.messages[0]?.body).toBe("Codex warning");
    expect(assistantRows[1]?.messages[0]?.body).toBe(
      "你好。有什么需要我在这个 workspace 里处理?"
    );
  });

  it("renders displayPrompt instead of rich content text while preserving prompt images", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      messages: [
        message({
          messageId: "user-1",
          id: 1,
          role: "user",
          kind: "text",
          payload: {
            displayPrompt: "Run Automation",
            text: "Run Automation",
            content: [
              { type: "text", text: "long automation prompt" },
              {
                type: "image",
                mimeType: "image/png",
                attachmentId: "attachment-1",
                name: "screen.png"
              }
            ]
          }
        })
      ]
    });

    const userRow = conversation.rows.find(
      (row) => row.kind === "message" && row.speaker === "user"
    );

    expect(
      userRow?.kind === "message" ? userRow.messages[0]?.contentKind : null
    ).toBe("image-grid");
    expect(
      userRow?.kind === "message" ? userRow.messages[0]?.images?.[0] : null
    ).toMatchObject({
      attachmentId: "attachment-1",
      mimeType: "image/png"
    });
    expect(userRow?.kind === "message" ? userRow.messages[1]?.body : null).toBe(
      "Run Automation"
    );
  });
});

function activity(
  overrides: Partial<WorkspaceAgentActivityCard> = {}
): WorkspaceAgentActivityCard {
  return {
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
    userAvatarUrl: "",
    ...overrides
  };
}

function session(
  overrides: Partial<AgentActivitySession> & {
    effectiveStatus?: string;
    turnPhase?: string;
  } = {}
): AgentActivitySession {
  const { effectiveStatus, turnPhase, ...canonical } = overrides;
  const phase = turnPhase ?? effectiveStatus;
  const hasActiveTurn =
    phase === "submitted" ||
    phase === "running" ||
    phase === "working" ||
    phase === "waiting" ||
    phase === "settling";
  return normalizeAgentActivitySession({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    userId: "user-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    cwd: "/workspace/demo",
    title: "Codex",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 10,
    ...(hasActiveTurn
      ? {
          activeTurn: {
            agentSessionId: "session-1",
            outcome: null,
            phase: phase === "working" ? "running" : phase,
            settledAtUnixMs: null,
            startedAtUnixMs: 1,
            turnId: "turn-1",
            updatedAtUnixMs: 10
          },
          activeTurnId: "turn-1"
        }
      : {}),
    ...canonical
  });
}

function message(
  overrides: Partial<AgentActivityMessage> & { id?: number }
): AgentActivityMessage {
  const { id: _legacyStorageId, ...canonical } = overrides;
  const version = overrides.version ?? 1;
  return {
    agentSessionId: "session-1",
    messageId: "message-1",
    version,
    turnId: "turn-1",
    role: "assistant",
    kind: "text",
    payload: {},
    occurredAtUnixMs: 1,
    ...canonical
  };
}
