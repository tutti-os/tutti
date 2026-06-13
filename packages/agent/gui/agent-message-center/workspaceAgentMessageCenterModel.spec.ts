import { describe, expect, it } from "vitest";
import type {
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import { buildWorkspaceAgentMessageCenterModel } from "./workspaceAgentMessageCenterModel";

describe("buildWorkspaceAgentMessageCenterModel", () => {
  it("counts current-workspace sessions that need user action as waiting", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "permission",
            kind: "tool.permission_request",
            payload: { summary: "Approve command" },
            occurredAtUnixMs: 20
          }),
          message({
            agentSessionId: "session-2",
            messageId: "done",
            kind: "message.assistant",
            payload: { text: "Finished" },
            occurredAtUnixMs: 10
          })
        ],
        sessions: [
          session({ agentSessionId: "session-1", status: "waiting" }),
          session({ agentSessionId: "session-2", status: "completed" })
        ]
      })
    );

    expect(model.waitingCount).toBe(1);
    expect(model.counts.waiting).toBe(1);
    expect(model.items[0]?.agentSessionId).toBe("session-1");
    expect(model.items[0]?.needsAttentionKind).toBe("permission");
  });

  it("uses display status waiting for working sessions with pending approval tool calls", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "approval-tool",
            kind: "tool_call",
            status: "waiting_approval",
            payload: {
              callType: "approval",
              toolName: "Approval",
              title: "Approval",
              input: {
                requestId: "permission-1",
                options: [
                  {
                    optionId: "allow_once",
                    label: "Allow once",
                    kind: "allow_once"
                  }
                ]
              }
            },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [session({ agentSessionId: "session-1", status: "working" })]
      })
    );

    expect(model.waitingCount).toBe(1);
    expect(model.counts.waiting).toBe(1);
    expect(model.counts.working).toBe(0);
    expect(model.items[0]).toMatchObject({
      agentSessionId: "session-1",
      status: "waiting",
      needsAttentionKind: "permission"
    });
    expect(model.items[0]?.pendingPrompt).toMatchObject({
      kind: "approval",
      requestId: "permission-1",
      options: [{ id: "allow_once", kind: "allow_once" }]
    });
  });

  it("uses the latest agent message summary instead of a newer user message", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "assistant-1",
            role: "assistant",
            kind: "text",
            payload: { text: "Agent summary wins" },
            occurredAtUnixMs: 10
          }),
          message({
            agentSessionId: "session-1",
            messageId: "user-1",
            role: "user",
            kind: "text",
            payload: { text: "Newer user prompt loses" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [session({ agentSessionId: "session-1" })]
      })
    );

    expect(model.items[0]?.lastAgentMessageSummary).toBe("Agent summary wins");
  });

  it("preserves the session user id for message-center stacking", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [],
        sessions: [
          session({ agentSessionId: "session-1", userId: " user-a " }),
          session({ agentSessionId: "session-2", userId: "user-b" })
        ]
      })
    );

    expect(
      model.items.find((item) => item.agentSessionId === "session-1")?.userId
    ).toBe("user-a");
    expect(
      model.items.find((item) => item.agentSessionId === "session-2")?.userId
    ).toBe("user-b");
  });

  it("orders sessions by session start instead of newer agent messages", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "assistant-1",
            role: "assistant",
            kind: "message.assistant",
            payload: { text: "Still streaming" },
            occurredAtUnixMs: 500
          }),
          message({
            agentSessionId: "session-2",
            messageId: "assistant-2",
            role: "assistant",
            kind: "message.assistant",
            payload: { text: "Earlier visible update" },
            occurredAtUnixMs: 250
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            createdAtUnixMs: 1,
            startedAtUnixMs: 100,
            updatedAtUnixMs: 500
          }),
          session({
            agentSessionId: "session-2",
            createdAtUnixMs: 2,
            startedAtUnixMs: 200,
            updatedAtUnixMs: 250
          })
        ]
      })
    );

    expect(model.items.map((item) => item.agentSessionId)).toEqual([
      "session-2",
      "session-1"
    ]);
    expect(model.items[1]?.lastAgentMessageSummary).toBe("Still streaming");
  });

  it("moves an older session up when a newer turn starts from a user message", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "user-1",
            role: "user",
            kind: "text",
            payload: { text: "Start a new turn." },
            occurredAtUnixMs: 500,
            turnId: "turn-new"
          }),
          message({
            agentSessionId: "session-2",
            messageId: "user-2",
            role: "user",
            kind: "text",
            payload: { text: "Earlier turn." },
            occurredAtUnixMs: 300,
            turnId: "turn-old"
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            createdAtUnixMs: 1,
            startedAtUnixMs: 100,
            updatedAtUnixMs: 500
          }),
          session({
            agentSessionId: "session-2",
            createdAtUnixMs: 2,
            startedAtUnixMs: 200,
            updatedAtUnixMs: 300
          })
        ]
      })
    );

    expect(model.items.map((item) => item.agentSessionId)).toEqual([
      "session-1",
      "session-2"
    ]);
  });

  it("uses session end time when a turn has ended", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [],
        sessions: [
          session({
            agentSessionId: "session-1",
            createdAtUnixMs: 1,
            endedAtUnixMs: 400,
            startedAtUnixMs: 100,
            updatedAtUnixMs: 400
          }),
          session({
            agentSessionId: "session-2",
            createdAtUnixMs: 2,
            startedAtUnixMs: 300,
            updatedAtUnixMs: 300
          })
        ]
      })
    );

    expect(model.items.map((item) => item.agentSessionId)).toEqual([
      "session-1",
      "session-2"
    ]);
  });

  it("counts idle message-center sessions as completed", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "assistant-1",
            payload: { text: "Done with the first task" },
            occurredAtUnixMs: 10
          }),
          message({
            agentSessionId: "session-2",
            messageId: "assistant-2",
            payload: { text: "Done with the second task" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [
          session({ agentSessionId: "session-1", status: "idle" }),
          session({ agentSessionId: "session-2", status: "ready" })
        ]
      })
    );

    expect(model.counts.all).toBe(2);
    expect(model.counts.completed).toBe(2);
    expect(model.counts.working).toBe(0);
    expect(model.counts.waiting).toBe(0);
  });

  it("counts error message-center sessions as failed, not completed", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "assistant-1",
            payload: { text: "Runtime error" },
            occurredAtUnixMs: 10
          })
        ],
        sessions: [session({ agentSessionId: "session-1", status: "error" })]
      })
    );

    expect(model.items[0]?.status).toBe("failed");
    expect(model.counts.all).toBe(1);
    expect(model.counts.failed).toBe(1);
    expect(model.counts.completed).toBe(0);
  });

  it("creates an inline text prompt for pending constraint requests", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "constraint-1",
            role: "assistant",
            kind: "message.assistant",
            status: "waiting",
            payload: {
              action: "constraint_adjustment",
              text: "Please refine the filter constraint."
            },
            occurredAtUnixMs: 30
          })
        ],
        sessions: [session({ agentSessionId: "session-1", status: "waiting" })]
      }),
      {
        promptFallbackLabels: {
          constraintHeader: "Constraint",
          inputHeader: "Input",
          question: "Add a response for the agent.",
          title: "Waiting for input"
        }
      }
    );

    expect(model.waitingCount).toBe(1);
    expect(model.items[0]?.pendingPrompt).toMatchObject({
      kind: "ask-user",
      requestId: "constraint-1",
      questions: [
        {
          header: "Constraint",
          question: "Please refine the filter constraint."
        }
      ]
    });
  });

  it("uses caller-provided labels for needs-attention fallback prompts", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "constraint-1",
            kind: "agent.constraint",
            status: "waiting",
            payload: {},
            occurredAtUnixMs: 30
          })
        ],
        sessions: [session({ agentSessionId: "session-1", status: "waiting" })]
      }),
      {
        promptFallbackLabels: {
          constraintHeader: "Localized constraint",
          inputHeader: "Localized input",
          question: "Localized question",
          title: "Localized title"
        }
      }
    );

    expect(model.items[0]?.pendingPrompt).toMatchObject({
      kind: "ask-user",
      requestId: "constraint-1",
      title: "agent.constraint",
      questions: [
        {
          header: "Localized constraint",
          question: "agent.constraint"
        }
      ]
    });
  });

  it("attaches caller-provided presentation identity by session id", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [],
        sessions: [session({ agentSessionId: "session-1" })]
      }),
      {
        identityBySessionId: {
          "session-1": {
            userName: "Jessica",
            userAvatarUrl: "https://cdn.example.com/jessica.png",
            agentName: "Codex",
            agentAvatarUrl: "https://cdn.example.com/codex.png"
          }
        }
      }
    );

    expect(model.items[0]?.identity).toEqual({
      userName: "Jessica",
      userAvatarUrl: "https://cdn.example.com/jessica.png",
      agentName: "Codex",
      agentAvatarUrl: "https://cdn.example.com/codex.png"
    });
  });
});

function snapshot(input: {
  messages: AgentActivityMessage[];
  sessions: AgentActivitySession[];
}): AgentActivitySnapshot {
  const sessionMessagesById: Record<string, AgentActivityMessage[]> = {};
  for (const message of input.messages) {
    const messages = sessionMessagesById[message.agentSessionId] ?? [];
    messages.push(message);
    sessionMessagesById[message.agentSessionId] = messages;
  }
  return {
    workspaceId: "workspace-1",
    presences: [],
    sessions: input.sessions,
    sessionMessagesById
  };
}

function session(
  overrides: Partial<AgentActivitySession>
): AgentActivitySession {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/workspace/project",
    title: "Status card fields",
    status: "working",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    lastEventUnixMs: 1,
    ...overrides
  };
}

function message(
  overrides: Partial<AgentActivityMessage>
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "message-1",
    version: 1,
    role: "assistant",
    kind: "message.assistant",
    status: "running",
    payload: {},
    occurredAtUnixMs: 1,
    ...overrides
  };
}
