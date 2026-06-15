import { describe, expect, it } from "vitest";
import type { WorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import {
  projectAgentConversationVM,
  reconcileProjectedAgentConversationVM
} from "./agentConversationProjection";

describe("projectAgentConversationVM", () => {
  it("keeps trailing tools split while the session is still processing without appending summary rows", () => {
    const detail = detailViewModel();
    const conversation = projectAgentConversationVM(detail);

    expect(conversation.rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-group",
      "message",
      "tool-group",
      "processing"
    ]);

    const toolRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "tool-group" }
      > => row.kind === "tool-group"
    );
    expect(toolRows).toHaveLength(2);
    expect(toolRows.every((row) => row.grouped === false)).toBe(true);
    const standaloneThinking = conversation.rows.find(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > =>
        row.kind === "message" &&
        row.speaker === "assistant" &&
        row.messages.length === 0
    );
    expect(standaloneThinking?.thinking[0]?.body).toBe(
      "Need to inspect before editing."
    );
  });

  it("only projects the latest tool from an unfinalized tail tool chain", () => {
    const calls = [
      {
        id: "call:1",
        name: "Read web page",
        toolName: "web_fetch",
        callType: "tool",
        status: "Completed",
        statusKind: "completed" as const,
        summary: "https://example.com/a",
        payload: null
      },
      {
        id: "call:2",
        name: "Read web page",
        toolName: "web_fetch",
        callType: "tool",
        status: "Completed",
        statusKind: "completed" as const,
        summary: "https://example.com/b",
        payload: null
      },
      {
        id: "call:3",
        name: "Read web page",
        toolName: "web_fetch",
        callType: "tool",
        status: "Completed",
        statusKind: "completed" as const,
        summary: "https://example.com/c",
        payload: null
      }
    ];
    const conversation = projectAgentConversationVM(
      detailViewModel({
        turns: [
          {
            id: "turn-1",
            userMessage: { id: "user-1", body: "Read pages" },
            userMessages: [{ id: "user-1", body: "Read pages" }],
            agentMessages: [],
            toolCalls: calls,
            toolCallCount: calls.length,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "tool-calls",
                id: "tools-1",
                toolCalls: calls,
                toolCallCount: calls.length,
                hasFailedToolCall: false
              }
            ]
          }
        ]
      })
    );

    const toolRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "tool-group" }
      > => row.kind === "tool-group"
    );

    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]?.grouped).toBe(false);
    expect(toolRows[0]?.calls[0]?.id).toBe("call:3");
  });

  it("keeps Codex transport retry notices out of the working processing label", () => {
    const base = detailViewModel();
    const conversation = projectAgentConversationVM(
      detailViewModel({
        turns: base.turns.map((turn) => ({
          ...turn,
          agentItems: [
            ...turn.agentItems,
            {
              kind: "message",
              message: {
                id: "assistant-retry-1",
                body: "Codex connection interrupted. Reconnecting...",
                systemNotice: {
                  noticeKind: "transport_retry",
                  severity: "warning",
                  title: "Codex connection interrupted. Reconnecting...",
                  detail: "Handled error during turn: Reconnecting... 1/5",
                  retryable: true
                }
              }
            }
          ]
        }))
      })
    );

    const processing = conversation.rows.find(
      (row) => row.kind === "processing"
    );
    expect(processing?.kind).toBe("processing");
    expect(processing).not.toHaveProperty("noticeKind");
  });

  it("groups bridge thinking inside completed tool disclosures", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        session: {
          ...detailViewModel().session,
          status: "completed"
        },
        showProcessingIndicator: false
      })
    );

    expect(conversation.rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-group",
      "turn-summary"
    ]);

    const groupedRow = conversation.rows.find(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "tool-group" }
      > => row.kind === "tool-group" && row.grouped
    );

    expect(groupedRow?.entries.map((entry) => entry.kind)).toEqual([
      "tool-call",
      "thinking",
      "tool-call"
    ]);
    expect(groupedRow?.entries[1]?.kind).toBe("thinking");
    expect(
      groupedRow?.entries[1]?.kind === "thinking"
        ? groupedRow.entries[1].thinking.body
        : null
    ).toBe("Need to inspect before editing.");
  });

  it("appends summary rows after the turn has completed", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        session: {
          ...detailViewModel().session,
          status: "completed"
        },
        showProcessingIndicator: false
      })
    );

    expect(conversation.rows.map((row) => row.kind)).toContain("turn-summary");
  });

  it("derives pending approval and ask-user prompts from typed tool rows", () => {
    const detail = detailViewModel({
      turns: [
        {
          id: "turn-1",
          userMessage: { id: "user-1", body: "Ship it" },
          userMessages: [{ id: "user-1", body: "Ship it" }],
          agentMessages: [],
          toolCalls: [],
          toolCallCount: 2,
          hasFailedToolCall: false,
          agentItems: [
            {
              kind: "tool-calls",
              id: "tools-1",
              toolCalls: [
                {
                  id: "call:approval-1",
                  name: "Run command",
                  toolName: "Approval",
                  callType: "approval",
                  status: "waiting_approval",
                  statusKind: "waiting",
                  summary: "Approval required",
                  payload: {
                    input: {
                      requestId: "approval-request-1",
                      options: [
                        {
                          id: "allow_once",
                          label: "Legacy allow label",
                          name: "Allow once",
                          kind: "allow_once"
                        }
                      ]
                    }
                  }
                },
                {
                  id: "call:ask-1",
                  name: "Ask user",
                  toolName: "AskUserQuestion",
                  callType: "tool",
                  status: "waiting_input",
                  statusKind: "waiting",
                  summary: "",
                  payload: {
                    input: {
                      requestId: "ask-request-1",
                      questions: [
                        {
                          id: "approach",
                          header: "Approach",
                          question: "Which path should we take?",
                          options: [
                            {
                              label: "Typed renderer",
                              description: "Keep going"
                            }
                          ]
                        }
                      ]
                    }
                  }
                }
              ],
              toolCallCount: 2,
              hasFailedToolCall: false
            }
          ]
        }
      ]
    });

    const conversation = projectAgentConversationVM(detail);

    expect(conversation.pendingApproval?.requestId).toBe("approval-request-1");
    expect(conversation.pendingApproval?.options[0]?.label).toBe("Allow once");
    expect(conversation.pendingInteractivePrompt).toEqual({
      kind: "ask-user",
      requestId: "ask-request-1",
      title: "Ask user",
      questions: [
        {
          id: "approach",
          header: "Approach",
          question: "Which path should we take?",
          options: [{ label: "Typed renderer", description: "Keep going" }],
          multiSelect: false,
          answer: null
        }
      ]
    });
  });

  it("does not append the processing row when canonical detail suppresses it", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        showProcessingIndicator: false
      })
    );

    expect(conversation.rows.some((row) => row.kind === "processing")).toBe(
      false
    );
  });

  it("keeps Edit and Write tool calls as standalone rows when avoidGroupingEdits is enabled", () => {
    const detail = detailViewModel();

    const conversation = projectAgentConversationVM(detail, {
      avoidGroupingEdits: true
    });

    expect(conversation.rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-group",
      "message",
      "tool-group",
      "processing"
    ]);

    const toolRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "tool-group" }
      > => row.kind === "tool-group"
    );
    expect(toolRows).toHaveLength(2);
    expect(toolRows.every((row) => row.grouped === false)).toBe(true);
    expect(
      conversation.rows.some(
        (
          row
        ): row is Extract<
          (typeof conversation.rows)[number],
          { kind: "message" }
        > =>
          row.kind === "message" &&
          row.speaker === "assistant" &&
          row.thinking.some(
            (thinking) => thinking.body === "Need to inspect before editing."
          )
      )
    ).toBe(true);
  });

  it("merges adjacent assistant message rows within the same turn when no boundary item separates them", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        turns: [
          {
            id: "turn-1",
            userMessage: { id: "user-1", body: "Launch the app" },
            userMessages: [{ id: "user-1", body: "Launch the app" }],
            agentMessages: [
              { id: "assistant-1", body: "现在可直接访问：`http://" },
              { id: "assistant-2", body: "0.0.0.0:4173`" }
            ],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "message",
                message: {
                  id: "assistant-1",
                  body: "现在可直接访问：`http://"
                }
              },
              {
                kind: "message",
                message: { id: "assistant-2", body: "0.0.0.0:4173`" }
              }
            ]
          }
        ],
        showProcessingIndicator: false
      })
    );

    const assistantRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > => row.kind === "message" && row.speaker === "assistant"
    );

    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]?.messages.map((message) => message.body)).toEqual([
      "现在可直接访问：`http://0.0.0.0:4173`"
    ]);
  });

  it("marks user text and each settled turn's latest assistant text reply as copyable", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        session: {
          ...detailViewModel().session,
          status: "completed"
        },
        turns: [
          {
            id: "turn-1",
            userMessage: { id: "user-1", body: "First request" },
            userMessages: [{ id: "user-1", body: "First request" }],
            agentMessages: [{ id: "assistant-1", body: "Older answer" }],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "message",
                message: { id: "assistant-1", body: "Older answer" }
              }
            ]
          },
          {
            id: "turn-2",
            userMessage: { id: "user-2", body: "Second request" },
            userMessages: [{ id: "user-2", body: "Second request" }],
            agentMessages: [{ id: "assistant-2", body: "Latest answer" }],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "message",
                message: { id: "assistant-2", body: "Latest answer" }
              }
            ]
          }
        ],
        showProcessingIndicator: false
      })
    );

    const messageRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > => row.kind === "message"
    );
    const userMessages = messageRows
      .filter((row) => row.speaker === "user")
      .flatMap((row) => row.messages);
    const assistantMessages = messageRows
      .filter((row) => row.speaker === "assistant")
      .flatMap((row) => row.messages);

    expect(userMessages.map((message) => message.copyText)).toEqual([
      "First request",
      "Second request"
    ]);
    expect(
      assistantMessages.map((message) => ({
        id: message.id,
        copyText: message.copyText ?? null
      }))
    ).toEqual([
      { id: "assistant-1", copyText: "Older answer" },
      { id: "assistant-2", copyText: "Latest answer" }
    ]);
  });

  it("marks prior turn assistant replies copyable while the latest turn is still working", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        turns: [
          {
            id: "turn-1",
            userMessage: { id: "user-1", body: "First request" },
            userMessages: [{ id: "user-1", body: "First request" }],
            agentMessages: [{ id: "assistant-1", body: "Prior answer" }],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "message",
                message: { id: "assistant-1", body: "Prior answer" }
              }
            ]
          },
          {
            id: "turn-2",
            userMessage: { id: "user-2", body: "Keep going" },
            userMessages: [{ id: "user-2", body: "Keep going" }],
            agentMessages: [{ id: "assistant-2", body: "Still working" }],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "message",
                message: { id: "assistant-2", body: "Still working" }
              }
            ]
          }
        ],
        showProcessingIndicator: false
      })
    );

    const assistantMessages = conversation.rows
      .filter(
        (
          row
        ): row is Extract<
          (typeof conversation.rows)[number],
          { kind: "message" }
        > => row.kind === "message" && row.speaker === "assistant"
      )
      .flatMap((row) => row.messages);

    expect(
      assistantMessages.map((message) => ({
        id: message.id,
        copyText: message.copyText ?? null
      }))
    ).toEqual([
      { id: "assistant-1", copyText: "Prior answer" },
      { id: "assistant-2", copyText: null }
    ]);
  });

  it("does not mark assistant replies copyable while the session is working", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        turns: [
          {
            id: "turn-1",
            userMessage: { id: "user-1", body: "Stream a response" },
            userMessages: [{ id: "user-1", body: "Stream a response" }],
            agentMessages: [
              {
                id: "assistant-working",
                body: "Still streaming"
              }
            ],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: [
              {
                kind: "message",
                message: {
                  id: "assistant-working",
                  body: "Still streaming"
                }
              }
            ]
          }
        ],
        showProcessingIndicator: false
      })
    );

    const assistantRow = conversation.rows.find(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > => row.kind === "message" && row.speaker === "assistant"
    );

    expect(assistantRow?.messages[0]?.copyText).toBeUndefined();
  });

  it("projects user prompt images before text and keeps the session workspace id", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        session: {
          ...detailViewModel().session,
          workspaceId: "room-1"
        },
        turns: [
          {
            id: "turn-1",
            userMessage: null,
            userMessages: [
              {
                id: "user-1",
                body: "你能看到这个图吗",
                sourceTimelineItems: [
                  {
                    id: 1,
                    agentSessionId: "session-1",
                    eventId: "event-1",
                    actorType: "user",
                    actorId: "user",
                    itemType: "message",
                    role: "user",
                    payload: {
                      content: [
                        { type: "text", text: "你能看到这个图吗" },
                        {
                          type: "image",
                          mimeType: "image/png",
                          attachmentId: "attachment-1",
                          name: "screen.png"
                        }
                      ]
                    }
                  }
                ]
              }
            ],
            agentMessages: [],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: []
          }
        ],
        showProcessingIndicator: false
      })
    );

    const userRow = conversation.rows.find(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > => row.kind === "message" && row.speaker === "user"
    );

    expect(userRow?.messages.map((message) => message.contentKind)).toEqual([
      "image-grid",
      "text"
    ]);
    expect(userRow?.messages[0]?.images?.[0]).toMatchObject({
      workspaceId: "room-1",
      agentSessionId: "session-1",
      attachmentId: "attachment-1",
      mimeType: "image/png",
      name: "screen.png"
    });
  });

  it("replaces rich user prompt text blocks with displayPrompt while preserving images", () => {
    const conversation = projectAgentConversationVM(
      detailViewModel({
        session: {
          ...detailViewModel().session,
          workspaceId: "room-1"
        },
        turns: [
          {
            id: "turn-1",
            userMessage: null,
            userMessages: [
              {
                id: "user-1",
                body: "Run Automation",
                sourceTimelineItems: [
                  {
                    id: 1,
                    agentSessionId: "session-1",
                    eventId: "event-1",
                    actorType: "user",
                    actorId: "user",
                    itemType: "message",
                    role: "user",
                    payload: {
                      displayPrompt: "Run Automation",
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
                  }
                ]
              }
            ],
            agentMessages: [],
            toolCalls: [],
            toolCallCount: 0,
            hasFailedToolCall: false,
            agentItems: []
          }
        ],
        showProcessingIndicator: false
      })
    );

    const userRow = conversation.rows.find(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > => row.kind === "message" && row.speaker === "user"
    );

    expect(userRow?.messages.map((message) => message.contentKind)).toEqual([
      "image-grid",
      "text"
    ]);
    expect(userRow?.messages[0]?.images?.[0]?.attachmentId).toBe(
      "attachment-1"
    );
    expect(userRow?.messages[1]?.body).toBe("Run Automation");
    expect(userRow?.messages.map((message) => message.body)).not.toContain(
      "long automation prompt"
    );
  });

  it("reuses unchanged transcript row references across incremental updates", () => {
    const firstTurn = detailViewModel().turns[0]!;
    const secondTurn = {
      id: "turn-2",
      userMessage: {
        id: "user-2",
        body: "Follow-up request",
        turnId: "turn-2"
      },
      userMessages: [
        { id: "user-2", body: "Follow-up request", turnId: "turn-2" }
      ],
      agentMessages: [
        { id: "assistant-2", body: "Working on it", turnId: "turn-2" }
      ],
      toolCalls: [],
      toolCallCount: 0,
      hasFailedToolCall: false,
      agentItems: [
        {
          kind: "message" as const,
          message: {
            id: "assistant-2",
            body: "Working on it",
            turnId: "turn-2"
          }
        }
      ]
    };
    const previous = projectAgentConversationVM(
      detailViewModel({
        turns: [firstTurn, secondTurn],
        showProcessingIndicator: false
      })
    );
    const next = projectAgentConversationVM(
      detailViewModel({
        turns: [
          firstTurn,
          {
            ...secondTurn,
            agentMessages: [
              ...secondTurn.agentMessages,
              { id: "assistant-3", body: "Done now", turnId: "turn-2" }
            ],
            agentItems: [
              ...secondTurn.agentItems,
              {
                kind: "message" as const,
                message: {
                  id: "assistant-3",
                  body: "Done now",
                  turnId: "turn-2"
                }
              }
            ]
          }
        ],
        showProcessingIndicator: false
      })
    );

    const reconciled = reconcileProjectedAgentConversationVM(previous, next);
    const previousFirstTurnRows = previous.rows.filter(
      (row) => row.turnId === firstTurn.id
    );
    const reconciledFirstTurnRows = reconciled.rows.filter(
      (row) => row.turnId === firstTurn.id
    );

    expect(reconciledFirstTurnRows).toHaveLength(previousFirstTurnRows.length);
    reconciledFirstTurnRows.forEach((row, index) => {
      expect(row).toBe(previousFirstTurnRows[index]);
    });
    expect(reconciled.rows.at(-1)).not.toBe(previous.rows.at(-1));
  });

  it("reuses transcript rows when only render-irrelevant timestamps change", () => {
    const baseDetail = detailViewModel();
    const previous = projectAgentConversationVM(baseDetail);
    const next = projectAgentConversationVM(
      detailViewModel({
        session: {
          ...baseDetail.session,
          updatedAtUnixMs: 99
        }
      })
    );

    const reconciled = reconcileProjectedAgentConversationVM(previous, next);

    expect(reconciled.rows).toBe(previous.rows);
  });
});

function detailViewModel(
  overrides: Partial<WorkspaceAgentSessionDetailViewModel> = {}
): WorkspaceAgentSessionDetailViewModel {
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
      changedFiles: [{ path: "src/App.tsx", label: "src/App.tsx" }],
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
      status: "working",
      title: "Codex",
      createdAtUnixMs: 1,
      updatedAtUnixMs: 10
    },
    cwd: "/workspace/demo",
    workspaceRoot: "/workspace/demo",
    turns: [
      {
        id: "turn-1",
        userMessage: { id: "user-1", body: "Ship it" },
        userMessages: [{ id: "user-1", body: "Ship it" }],
        agentMessages: [{ id: "assistant-1", body: "On it" }],
        toolCalls: [],
        toolCallCount: 2,
        hasFailedToolCall: false,
        agentItems: [
          { kind: "message", message: { id: "assistant-1", body: "On it" } },
          {
            kind: "tool-calls",
            id: "tools-1",
            toolCalls: [
              {
                id: "call:1",
                name: "Read file",
                toolName: "read_file",
                callType: "tool",
                status: "Completed",
                statusKind: "completed",
                summary: "/workspace/demo/README.md",
                payload: null
              },
              {
                id: "call:2",
                name: "Edit file",
                toolName: "edit_file",
                callType: "tool",
                status: "Completed",
                statusKind: "completed",
                summary: "/workspace/demo/src/App.tsx",
                payload: null
              }
            ],
            toolCallCount: 2,
            hasFailedToolCall: false,
            summary: "Read and edited files",
            groupEntries: [
              {
                kind: "tool-call",
                call: {
                  id: "call:1",
                  name: "Read file",
                  toolName: "read_file",
                  callType: "tool",
                  status: "Completed",
                  statusKind: "completed",
                  summary: "/workspace/demo/README.md",
                  payload: null
                }
              },
              {
                kind: "thinking",
                thinking: {
                  id: "thinking-1",
                  body: "Need to inspect before editing."
                }
              },
              {
                kind: "tool-call",
                call: {
                  id: "call:2",
                  name: "Edit file",
                  toolName: "edit_file",
                  callType: "tool",
                  status: "Completed",
                  statusKind: "completed",
                  summary: "/workspace/demo/src/App.tsx",
                  payload: null
                }
              }
            ]
          }
        ]
      }
    ],
    showProcessingIndicator: true,
    ...overrides
  };
}
