import { describe, expect, it } from "vitest";
import type {
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import {
  buildWorkspaceAgentMessageCenterModel,
  isInteractiveMessageCenterItem,
  selectMessageCenterAttentionDeckItems,
  type WorkspaceAgentMessageCenterItem
} from "./workspaceAgentMessageCenterModel";
import { stabilizeWorkspaceAgentMessageCenterModel } from "./workspaceAgentMessageCenterModelStability";

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
    expect(model.items[0]?.digest.primary).toMatchObject({
      kind: "input-required",
      summary: "Approval"
    });
  });

  it("uses explicit MCP targets for pending approval prompts when available", () => {
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
                server: "playwright",
                tool: "browser_close",
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

    expect(model.items[0]?.pendingPrompt).toMatchObject({
      kind: "approval",
      title: "playwright / browser_close"
    });
    expect(model.items[0]?.digest.primary).toMatchObject({
      kind: "input-required",
      summary: "playwright / browser_close"
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
    expect(model.items[0]?.digest.primary).toMatchObject({
      kind: "progress",
      summary: "Agent summary wins"
    });
  });

  it("prefers displayPrompt for message-center model summaries", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "assistant-1",
            role: "assistant",
            kind: "text",
            payload: {
              displayPrompt: "Run Automation",
              text: "long automation prompt",
              content: "long automation prompt"
            },
            occurredAtUnixMs: 10
          })
        ],
        sessions: [session({ agentSessionId: "session-1" })]
      })
    );

    expect(model.items[0]?.lastAgentMessageSummary).toBe("Run Automation");
    expect(model.items[0]?.digest.primary).toMatchObject({
      summary: "Run Automation"
    });
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

  it("filters non-waiting items before the configured cutoff while preserving waiting items", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "recent",
            messageId: "recent-message",
            payload: { text: "Recent summary" },
            occurredAtUnixMs: 2_100
          }),
          message({
            agentSessionId: "old",
            messageId: "old-message",
            payload: { text: "Old summary" },
            occurredAtUnixMs: 900
          }),
          message({
            agentSessionId: "old-waiting",
            messageId: "old-permission",
            kind: "tool.permission_request",
            payload: { summary: "Old approval" },
            occurredAtUnixMs: 800
          })
        ],
        sessions: [
          session({
            agentSessionId: "recent",
            status: "completed",
            startedAtUnixMs: 2_100,
            updatedAtUnixMs: 2_100
          }),
          session({
            agentSessionId: "old",
            status: "completed",
            startedAtUnixMs: 900,
            updatedAtUnixMs: 900
          }),
          session({
            agentSessionId: "old-waiting",
            status: "waiting",
            startedAtUnixMs: 800,
            updatedAtUnixMs: 800
          })
        ]
      }),
      { itemCutoffUnixMs: 1_000 }
    );

    expect(model.items.map((item) => item.agentSessionId)).toEqual([
      "old-waiting",
      "recent"
    ]);
    expect(model.counts.all).toBe(2);
    expect(model.counts.waiting).toBe(1);
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

  it("marks imported sessions on message-center items", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [],
        sessions: [
          session({
            agentSessionId: "imported-session",
            runtimeContext: { imported: true },
            status: "completed"
          })
        ]
      })
    );

    expect(model.items[0]).toMatchObject({
      agentSessionId: "imported-session",
      imported: true,
      status: "completed"
    });
  });

  it("records the latest completed turn outcome when the session has returned to idle", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "assistant-1",
            role: "assistant",
            kind: "message.assistant",
            status: "completed",
            turnId: "turn-1",
            payload: { text: "Done with the first turn" },
            occurredAtUnixMs: 10
          }),
          message({
            agentSessionId: "session-1",
            messageId: "assistant-2",
            role: "assistant",
            kind: "message.assistant",
            status: "completed",
            turnId: "turn-2",
            payload: { text: "Done with the second turn" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [session({ agentSessionId: "session-1", status: "ready" })]
      })
    );

    expect(model.items[0]).toMatchObject({
      status: "idle",
      latestTurnOutcome: {
        notificationKey: "session-1:turn:turn-2:completed",
        status: "completed",
        turnId: "turn-2"
      }
    });
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

  it("derives the full ask-user question with options from the tool input", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "ask-1",
            role: "assistant",
            kind: "tool_call",
            status: "waiting",
            payload: {
              toolName: "AskUserQuestion",
              input: {
                requestId: "ask-req-1",
                questions: [
                  {
                    id: "plan-kind",
                    header: "Plan topic",
                    question: "Which kind of plan do you want?",
                    options: [
                      {
                        label: "Engineering health check",
                        description: "Plan a low-risk repo audit."
                      },
                      {
                        label: "Feature implementation plan",
                        description: "Needs a feature name."
                      }
                    ],
                    multiSelect: false
                  }
                ]
              }
            },
            occurredAtUnixMs: 30
          })
        ],
        sessions: [session({ agentSessionId: "session-1", status: "waiting" })]
      })
    );

    // The deck card must render the same question + options the conversation
    // shows, not a degraded fallback. Questions come from the tool input
    // (payload.input.questions), mirroring the in-conversation projection.
    expect(model.items[0]?.pendingPrompt).toMatchObject({
      kind: "ask-user",
      requestId: "ask-req-1",
      questions: [
        {
          header: "Plan topic",
          question: "Which kind of plan do you want?",
          options: [
            { label: "Engineering health check" },
            { label: "Feature implementation plan" }
          ]
        }
      ]
    });
  });

  it("uses the newest pending prompt without sorting message arrays", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "older-ask",
            role: "assistant",
            kind: "tool_call",
            status: "waiting",
            payload: {
              toolName: "AskUserQuestion",
              input: {
                requestId: "older-request",
                questions: [
                  {
                    id: "older",
                    question: "Older question?",
                    options: [],
                    multiSelect: false
                  }
                ]
              }
            },
            occurredAtUnixMs: 30
          }),
          message({
            agentSessionId: "session-1",
            messageId: "newer-approval",
            role: "assistant",
            kind: "tool_call",
            status: "waiting_approval",
            payload: {
              callType: "approval",
              toolName: "Approval",
              input: {
                requestId: "newer-request",
                options: [
                  {
                    optionId: "allow_once",
                    label: "Allow once",
                    kind: "allow_once"
                  }
                ]
              }
            },
            occurredAtUnixMs: 40
          })
        ],
        sessions: [session({ agentSessionId: "session-1", status: "waiting" })]
      })
    );

    expect(model.items[0]?.pendingPrompt).toMatchObject({
      kind: "approval",
      requestId: "newer-request"
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

  it("falls back to the session title when no agent summary exists", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "user-1",
            role: "user",
            payload: { text: "User-only message" },
            occurredAtUnixMs: 10
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            status: "completed",
            title: "Completed fallback title"
          })
        ]
      })
    );

    expect(model.items[0]?.digest.primary).toMatchObject({
      kind: "outcome",
      summary: "Completed fallback title"
    });
  });

  it("does not use a user-only title fallback as the digest body", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "user-1",
            role: "user",
            payload: { text: "User-only prompt" },
            occurredAtUnixMs: 10
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            provider: "codex",
            status: "completed",
            title: ""
          })
        ]
      })
    );

    expect(model.items[0]?.title).toBe("User-only prompt");
    expect(model.items[0]?.digest.primary).toMatchObject({
      kind: "outcome",
      summary: "codex"
    });
  });

  it("keeps digest summaries on the tool-output path", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "tool-1",
            kind: "tool_call",
            status: "completed",
            payload: {
              output: { summary: "53 tests passed" },
              title: "Bash",
              toolName: "Bash"
            },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            status: "completed"
          })
        ]
      })
    );

    expect(model.items[0]?.lastAgentMessageSummary).toBe("Bash");
    expect(model.items[0]?.digest.primary).toMatchObject({
      kind: "outcome",
      summary: "53 tests passed",
      occurredAtUnixMs: 20
    });
  });

  it("synthesizes a plan-implementation decision from a settled codex plan turn", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "plan-1",
            kind: "message.assistant",
            status: "completed",
            turnId: "turn-plan",
            payload: { messageKind: "plan", text: "# Plan\n1. inspect" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            provider: "codex",
            status: "completed"
          })
        ]
      })
    );

    expect(model.items[0]?.pendingPrompt).toEqual({
      kind: "plan-implementation",
      requestId: "turn-plan",
      title: "# Plan\n1. inspect"
    });
    expect(model.waitingCount).toBe(1);
  });

  it("does not offer a plan decision while the codex session is still working", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "plan-1",
            kind: "message.assistant",
            status: "running",
            turnId: "turn-plan",
            payload: { messageKind: "plan", text: "# Plan" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            provider: "codex",
            status: "working"
          })
        ]
      })
    );

    expect(model.items[0]?.pendingPrompt).toBeNull();
  });

  it("does not offer a codex plan decision when the latest turn is not a plan", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "plan-1",
            kind: "message.assistant",
            status: "completed",
            turnId: "turn-plan",
            payload: { messageKind: "plan", text: "# Plan" },
            occurredAtUnixMs: 10
          }),
          message({
            agentSessionId: "session-1",
            messageId: "reply-1",
            kind: "message.assistant",
            status: "completed",
            turnId: "turn-reply",
            payload: { text: "done" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            provider: "codex",
            status: "completed"
          })
        ]
      })
    );
    expect(model.items[0]?.pendingPrompt).toBeNull();
  });

  it("does not synthesize a plan decision for non-codex providers", () => {
    const model = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "plan-1",
            kind: "message.assistant",
            status: "completed",
            turnId: "turn-plan",
            payload: { messageKind: "plan", text: "# Plan" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [
          session({
            agentSessionId: "session-1",
            provider: "claude-code",
            status: "completed"
          })
        ]
      })
    );
    expect(model.items[0]?.pendingPrompt).toBeNull();
  });
});

describe("stabilizeWorkspaceAgentMessageCenterModel", () => {
  it("returns the previous model when rebuilt items are equivalent", () => {
    const activitySnapshot = snapshot({
      messages: [
        message({
          agentSessionId: "session-1",
          messageId: "assistant-1",
          payload: { text: "Finished" },
          occurredAtUnixMs: 10
        })
      ],
      sessions: [
        session({
          agentSessionId: "session-1",
          status: "completed"
        })
      ]
    });
    const previous = buildWorkspaceAgentMessageCenterModel(activitySnapshot);
    const next = buildWorkspaceAgentMessageCenterModel(activitySnapshot);

    const stable = stabilizeWorkspaceAgentMessageCenterModel(previous, next);

    expect(stable).toBe(previous);
    expect(stable.items).toBe(previous.items);
    expect(stable.items[0]).toBe(previous.items[0]);
  });

  it("reuses unchanged item references while keeping changed items fresh", () => {
    const previous = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "assistant-1",
            payload: { text: "Session one" },
            occurredAtUnixMs: 10
          }),
          message({
            agentSessionId: "session-2",
            messageId: "assistant-2",
            payload: { text: "Session two" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [
          session({ agentSessionId: "session-1", status: "completed" }),
          session({ agentSessionId: "session-2", status: "completed" })
        ]
      })
    );
    const next = buildWorkspaceAgentMessageCenterModel(
      snapshot({
        messages: [
          message({
            agentSessionId: "session-1",
            messageId: "assistant-1",
            payload: { text: "Session one" },
            occurredAtUnixMs: 10
          }),
          message({
            agentSessionId: "session-2",
            messageId: "assistant-2",
            payload: { text: "Session two updated" },
            occurredAtUnixMs: 20
          })
        ],
        sessions: [
          session({ agentSessionId: "session-1", status: "completed" }),
          session({ agentSessionId: "session-2", status: "completed" })
        ]
      })
    );

    const stable = stabilizeWorkspaceAgentMessageCenterModel(previous, next);

    expect(itemBySessionId(stable, "session-1")).toBe(
      itemBySessionId(previous, "session-1")
    );
    expect(itemBySessionId(stable, "session-2")).toBe(
      itemBySessionId(next, "session-2")
    );
    expect(stable).not.toBe(previous);
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
    turnId: "turn-1",
    role: "assistant",
    kind: "message.assistant",
    status: "running",
    payload: {},
    occurredAtUnixMs: 1,
    ...overrides
  };
}

function itemBySessionId(
  model: ReturnType<typeof buildWorkspaceAgentMessageCenterModel>,
  agentSessionId: string
): WorkspaceAgentMessageCenterItem | undefined {
  return model.items.find((item) => item.agentSessionId === agentSessionId);
}

describe("message center attention deck selection", () => {
  function item(
    overrides: Partial<WorkspaceAgentMessageCenterItem> & {
      agentSessionId: string;
    }
  ): WorkspaceAgentMessageCenterItem {
    return {
      id: `message-center-${overrides.agentSessionId}`,
      provider: "codex",
      userId: null,
      title: "t",
      identity: null,
      cwd: "/w",
      status: "waiting",
      digest: {
        primary: {
          kind: "input-required",
          summary: "t",
          occurredAtUnixMs: 1
        }
      },
      lastAgentMessageSummary: "",
      lastAgentMessageAtUnixMs: 1,
      pendingPrompt: null,
      needsAttentionKind: null,
      needsAttentionSummary: null,
      sortTimeUnixMs: 1,
      ...overrides
    };
  }
  function withPrompt(
    overrides: Partial<WorkspaceAgentMessageCenterItem> & {
      agentSessionId: string;
    }
  ): WorkspaceAgentMessageCenterItem {
    return item({
      pendingPrompt: {
        kind: "approval",
        id: `approval:${overrides.agentSessionId}`,
        turnId: "turn-1",
        requestId: `request-${overrides.agentSessionId}`,
        callId: `request-${overrides.agentSessionId}`,
        title: "Approval",
        status: "waiting_approval",
        toolName: "Bash",
        input: null,
        options: [],
        output: null,
        occurredAtUnixMs: 1
      },
      ...overrides
    });
  }

  it("treats only items with a pending prompt as interactive", () => {
    expect(
      isInteractiveMessageCenterItem(withPrompt({ agentSessionId: "a" }))
    ).toBe(true);
    expect(
      isInteractiveMessageCenterItem(
        item({ agentSessionId: "b", needsAttentionKind: "permission" })
      )
    ).toBe(false);
    expect(isInteractiveMessageCenterItem(item({ agentSessionId: "c" }))).toBe(
      false
    );
  });

  it("selects deck items preserving input order (newest-first as sorted upstream)", () => {
    const newest = withPrompt({ agentSessionId: "newest", sortTimeUnixMs: 30 });
    const older = withPrompt({ agentSessionId: "older", sortTimeUnixMs: 10 });
    const attentionOnly = item({
      agentSessionId: "attn",
      needsAttentionKind: "permission"
    });
    const done = item({ agentSessionId: "done", status: "completed" });

    const deck = selectMessageCenterAttentionDeckItems([
      newest,
      older,
      attentionOnly,
      done
    ]);

    expect(deck.map((entry) => entry.agentSessionId)).toEqual([
      "newest",
      "older"
    ]);
  });
});
