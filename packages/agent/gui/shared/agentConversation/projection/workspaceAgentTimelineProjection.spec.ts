import { describe, expect, it } from "vitest";
import type {
  AgentHostWorkspaceAgentSession,
  AgentHostWorkspaceAgentTimelineItem
} from "../../contracts/dto";
import type { WorkspaceAgentActivityCard } from "../../workspaceAgentActivityListViewModel";
import { buildWorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import {
  buildCanonicalWorkspaceAgentDetailView,
  projectWorkspaceAgentTimelineToConversationVM
} from "./workspaceAgentTimelineProjection";

describe("projectWorkspaceAgentTimelineToConversationVM", () => {
  it("groups adjacent tool calls and bridge thinking directly from timeline items", () => {
    const conversation = projectWorkspaceAgentTimelineToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      timelineItems: timelineItems()
    });

    expect(conversation.rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-group",
      "tool-group",
      "tool-group",
      "turn-summary"
    ]);

    const groupedRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "tool-group" }
      > => row.kind === "tool-group" && row.grouped
    );
    expect(groupedRows).toHaveLength(1);
    expect(groupedRows[0]?.entries.map((entry) => entry.kind)).toEqual([
      "tool-call",
      "thinking",
      "tool-call"
    ]);
    expect(groupedRows[0]?.entries[1]?.kind).toBe("thinking");
    expect(
      groupedRows[0]?.entries[1]?.kind === "thinking"
        ? groupedRows[0].entries[1].thinking.body
        : null
    ).toBe("Need to inspect before editing.");

    expect(conversation.pendingApproval?.requestId).toBe("approval-request-1");
    expect(conversation.pendingInteractivePrompt).toEqual({
      kind: "ask-user",
      requestId: "ask-request-1",
      title: "AskUserQuestion",
      questions: [
        {
          id: "approach",
          header: "Approach",
          question: "Which direction should we take?",
          options: [{ label: "Use typed renderer", description: "Keep going" }],
          multiSelect: false,
          answer: null
        }
      ]
    });

    const summaryRow = conversation.rows.find(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "turn-summary" }
      > => row.kind === "turn-summary"
    );
    expect(summaryRow?.files.map((file) => file.path)).toEqual([
      "/workspace/demo/src/App.tsx"
    ]);
  });

  it("builds canonical detail turns directly from timeline items without the legacy detail builder", () => {
    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: session({ effectiveStatus: "working", turnPhase: "working" }),
      workspaceRoot: "/workspace/demo",
      timelineItems: timelineItems()
    });

    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]?.rawAgentItems?.map((item) => item.kind)).toEqual([
      "message",
      "tool-calls",
      "thinking",
      "tool-calls",
      "tool-calls",
      "tool-calls"
    ]);
    expect(detail.turns[0]?.agentItems.map((item) => item.kind)).toEqual([
      "message",
      "tool-calls",
      "thinking",
      "tool-calls",
      "tool-calls",
      "tool-calls"
    ]);
    expect(detail.showProcessingIndicator).toBe(false);
  });

  it("omits Claude synthetic interrupt messages from left detail conversation rows", () => {
    const conversation = projectWorkspaceAgentTimelineToConversationVM({
      activity: activity(),
      session: session({
        provider: "claude-code",
        title: "[Request interrupted by user]"
      }),
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        {
          ...timelineItems()[0]!,
          content: "[Request interrupted by user]"
        },
        {
          ...timelineItems()[0]!,
          id: 11,
          eventId: "event-11",
          content: "[Request interrupted by user for tool use]",
          occurredAtUnixMs: 11,
          createdAtUnixMs: 11
        },
        {
          ...timelineItems()[0]!,
          id: 12,
          eventId: "event-12",
          content: "继续正常请求",
          occurredAtUnixMs: 12,
          createdAtUnixMs: 12
        },
        timelineItems()[1]!
      ]
    });

    const userMessages = conversation.rows
      .filter(
        (
          row
        ): row is Extract<
          (typeof conversation.rows)[number],
          { kind: "message" }
        > => row.kind === "message" && row.speaker === "user"
      )
      .flatMap((row) => row.messages.map((message) => message.body));

    expect(userMessages).toEqual(["继续正常请求"]);
  });

  it("prefers durable sequence order over drifted timestamps", () => {
    const conversation = projectWorkspaceAgentTimelineToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      timelineItems: timelineItems().map((item) => ({
        ...item,
        occurredAtUnixMs:
          item.seq === 3
            ? 300
            : item.seq === 4
              ? 40
              : item.seq === 5
                ? 50
                : item.seq,
        createdAtUnixMs:
          item.seq === 3
            ? 300
            : item.seq === 4
              ? 40
              : item.seq === 5
                ? 50
                : item.seq
      }))
    });

    expect(conversation.rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "tool-group",
      "tool-group",
      "tool-group",
      "turn-summary"
    ]);
  });

  it("keeps the legacy detail builder aligned with the canonical timeline projection helper", () => {
    const input = {
      activity: activity(),
      session: session({ effectiveStatus: "working", turnPhase: "working" }),
      workspaceRoot: "/workspace/demo",
      timelineItems: timelineItems()
    };

    const canonical = buildCanonicalWorkspaceAgentDetailView(input);
    const legacy = buildWorkspaceAgentSessionDetailViewModel(input);

    expect(legacy).toEqual(canonical);
  });

  it("respects avoidGroupingEdits when rebuilding rows directly from timeline items", () => {
    const conversation = projectWorkspaceAgentTimelineToConversationVM(
      {
        activity: activity(),
        session: session({
          effectiveStatus: "completed",
          turnPhase: "completed"
        }),
        workspaceRoot: "/workspace/demo",
        timelineItems: timelineItems()
      },
      { avoidGroupingEdits: true }
    );

    const groupedRows = conversation.rows.filter(
      (
        row
      ): row is Extract<
        (typeof conversation.rows)[number],
        { kind: "tool-group" }
      > => row.kind === "tool-group" && row.grouped
    );
    expect(groupedRows).toHaveLength(0);
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

  it("projects visible agent errors from assistant message payloads", () => {
    const conversation = projectWorkspaceAgentTimelineToConversationVM({
      activity: activity(),
      session: session({ effectiveStatus: "failed", turnPhase: "failed" }),
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        timelineItems()[0]!,
        {
          id: 99,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          turnId: "turn-1",
          seq: 99,
          eventId: "visible-error:event-99",
          actorType: "agent",
          actorId: "hermes",
          itemType: "message.assistant",
          role: "assistant",
          status: "failed",
          payload: {
            kind: "agent_visible_error",
            code: "process_exited",
            phase: "start",
            provider: "hermes",
            detail: "Config invalid",
            retryable: false,
            content: "Hermes failed to start.",
            text: "Hermes failed to start."
          },
          occurredAtUnixMs: 99,
          createdAtUnixMs: 99
        }
      ]
    });

    const row = conversation.rows.find(
      (
        candidate
      ): candidate is Extract<
        (typeof conversation.rows)[number],
        { kind: "message" }
      > => candidate.kind === "message" && candidate.speaker === "assistant"
    );
    expect(row?.messages[0]?.visibleError).toEqual({
      code: "process_exited",
      phase: "start",
      provider: "hermes",
      detail: "Config invalid",
      retryable: false
    });
  });

  it("projects transport notices without merging them into assistant content", () => {
    const conversation = projectWorkspaceAgentTimelineToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        timelineItems()[0]!,
        {
          id: 98,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          turnId: "turn-1",
          seq: 98,
          eventId: "notice:event-98",
          actorType: "agent",
          actorId: "codex",
          itemType: "message.assistant",
          role: "assistant",
          status: "completed",
          payload: {
            kind: "agent_system_notice",
            noticeKind: "transport_retry",
            severity: "warning",
            title: "Codex connection interrupted. Reconnecting...",
            detail:
              "ResponseStreamDisconnected: websocket IO error: Broken pipe",
            retryable: true,
            content: "Codex connection interrupted. Reconnecting...",
            text: "Codex connection interrupted. Reconnecting..."
          },
          occurredAtUnixMs: 98,
          createdAtUnixMs: 98
        },
        {
          id: 99,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          turnId: "turn-1",
          seq: 99,
          eventId: "event-99",
          actorType: "agent",
          actorId: "codex",
          itemType: "message.assistant",
          role: "assistant",
          status: "completed",
          content: "Done.",
          occurredAtUnixMs: 99,
          createdAtUnixMs: 99
        }
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
      noticeKind: "transport_retry",
      severity: "warning",
      title: "Codex connection interrupted. Reconnecting...",
      detail: "ResponseStreamDisconnected: websocket IO error: Broken pipe",
      retryable: true
    });
    expect(assistantRows[1]?.messages[0]?.body).toBe("Done.");
  });

  it("maps review-process thinking timeline items to assistant message rows", () => {
    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        {
          id: 1,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          turnId: "turn-review",
          seq: 1,
          eventId: "event-1",
          actorType: "user",
          actorId: "user-1",
          itemType: "message.user",
          role: "user",
          content: "/review",
          occurredAtUnixMs: 1,
          createdAtUnixMs: 1
        },
        {
          id: 2,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          turnId: "turn-review",
          seq: 2,
          eventId: "event-2",
          actorType: "agent",
          actorId: "codex",
          itemType: "message.assistant_thinking",
          role: "assistant_thinking",
          status: "completed",
          content:
            "**Considering workspace registration order**\n\nInspecting the auth flow.",
          payload: { messageKind: "review-process" },
          occurredAtUnixMs: 2,
          createdAtUnixMs: 2
        }
      ]
    });

    expect(detail.turns[0]?.agentItems).toEqual([
      expect.objectContaining({
        kind: "message",
        message: expect.objectContaining({
          body: "Inspecting the auth flow."
        })
      })
    ]);
  });

  it("does not append processing after a terminal assistant message even if the session patch is still working", () => {
    const completedReplyTimelineItems: AgentHostWorkspaceAgentTimelineItem[] = [
      timelineItems()[0]!,
      {
        id: 99,
        workspaceId: "room-1",
        agentSessionId: "session-1",
        turnId: "turn-1",
        seq: 99,
        eventId: "event-99",
        actorType: "agent",
        actorId: "codex",
        itemType: "message.assistant",
        role: "assistant",
        status: "completed",
        content: "Done.",
        occurredAtUnixMs: 99,
        createdAtUnixMs: 99
      }
    ];

    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: session({
        status: "working",
        effectiveStatus: "working",
        turnPhase: "working"
      }),
      workspaceRoot: "/workspace/demo",
      timelineItems: completedReplyTimelineItems
    });
    const conversation = projectWorkspaceAgentTimelineToConversationVM({
      activity: activity(),
      session: session({
        status: "working",
        effectiveStatus: "working",
        turnPhase: "working"
      }),
      workspaceRoot: "/workspace/demo",
      timelineItems: completedReplyTimelineItems
    });

    expect(detail.showProcessingIndicator).toBe(false);
    expect(conversation.rows.some((row) => row.kind === "processing")).toBe(
      false
    );
  });

  it("keeps processing after an interim assistant message while the turn lifecycle reports an active turn", () => {
    const interimReplyTimelineItems: AgentHostWorkspaceAgentTimelineItem[] = [
      timelineItems()[0]!,
      {
        id: 99,
        workspaceId: "room-1",
        agentSessionId: "session-1",
        turnId: "turn-1",
        seq: 99,
        eventId: "event-99",
        actorType: "agent",
        actorId: "codex",
        itemType: "message.assistant",
        role: "assistant",
        status: "completed",
        content: "I will now dispatch the sub-agents.",
        occurredAtUnixMs: 99,
        createdAtUnixMs: 99
      }
    ];
    const workingSession = {
      ...session({
        status: "working",
        effectiveStatus: "working",
        turnPhase: "working"
      }),
      turnLifecycle: {
        activeTurnId: "turn-1",
        phase: "running"
      }
    };

    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: workingSession,
      workspaceRoot: "/workspace/demo",
      timelineItems: interimReplyTimelineItems
    });
    const conversation = projectWorkspaceAgentTimelineToConversationVM({
      activity: activity(),
      session: workingSession,
      workspaceRoot: "/workspace/demo",
      timelineItems: interimReplyTimelineItems
    });

    expect(detail.showProcessingIndicator).toBe(true);
    expect(conversation.rows.some((row) => row.kind === "processing")).toBe(
      true
    );
  });

  it("does not append processing after a terminal assistant message once the turn lifecycle is settling", () => {
    const settlingReplyTimelineItems: AgentHostWorkspaceAgentTimelineItem[] = [
      timelineItems()[0]!,
      {
        id: 99,
        workspaceId: "room-1",
        agentSessionId: "session-1",
        turnId: "turn-1",
        seq: 99,
        eventId: "event-99",
        actorType: "agent",
        actorId: "codex",
        itemType: "message.assistant",
        role: "assistant",
        status: "completed",
        content: "Done.",
        occurredAtUnixMs: 99,
        createdAtUnixMs: 99
      }
    ];
    const settlingSession = {
      ...session({
        status: "working",
        effectiveStatus: "working",
        turnPhase: "working"
      }),
      turnLifecycle: {
        activeTurnId: "turn-1",
        phase: "running",
        settling: true
      }
    };

    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: settlingSession,
      workspaceRoot: "/workspace/demo",
      timelineItems: settlingReplyTimelineItems
    });

    expect(detail.showProcessingIndicator).toBe(false);
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
  overrides: Partial<AgentHostWorkspaceAgentSession> = {}
): AgentHostWorkspaceAgentSession {
  return {
    id: 1,
    agentSessionId: "session-1",
    presenceId: 1,
    userId: "user-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
    cwd: "/workspace/demo",
    lifecycleStatus: "active",
    turnPhase: "completed",
    effectiveStatus: "completed",
    title: "Codex",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 10,
    ...overrides
  };
}

function timelineItems(): AgentHostWorkspaceAgentTimelineItem[] {
  return [
    {
      id: 1,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      seq: 1,
      eventId: "event-1",
      actorType: "user",
      actorId: "user-1",
      itemType: "message.user",
      role: "user",
      content: "Ship the patch",
      occurredAtUnixMs: 1,
      createdAtUnixMs: 1
    },
    {
      id: 2,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      seq: 2,
      eventId: "event-2",
      actorType: "agent",
      actorId: "codex",
      itemType: "message.assistant",
      role: "assistant",
      content: "On it",
      occurredAtUnixMs: 2,
      createdAtUnixMs: 2
    },
    {
      id: 3,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      seq: 3,
      eventId: "event-3",
      actorType: "agent",
      actorId: "codex",
      itemType: "call.completed",
      role: "assistant",
      callType: "tool",
      callId: "read-1",
      name: "read_file",
      status: "completed",
      payload: {
        tool_state: {
          name: "read_file",
          input: { path: "/workspace/demo/README.md" },
          output: { text: "Read README.md" }
        }
      },
      occurredAtUnixMs: 3,
      createdAtUnixMs: 3
    },
    {
      id: 4,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      seq: 4,
      eventId: "event-4",
      actorType: "agent",
      actorId: "codex",
      itemType: "message.assistant_thinking",
      role: "assistant_thinking",
      content: "Need to inspect before editing.",
      occurredAtUnixMs: 4,
      createdAtUnixMs: 4
    },
    {
      id: 5,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      seq: 5,
      eventId: "event-5",
      actorType: "agent",
      actorId: "codex",
      itemType: "call.completed",
      role: "assistant",
      callType: "tool",
      callId: "edit-1",
      name: "edit_file",
      status: "completed",
      payload: {
        tool_state: {
          name: "edit_file",
          input: {
            file_path: "/workspace/demo/src/App.tsx",
            old_string: "old",
            new_string: "new"
          },
          output: {}
        }
      },
      occurredAtUnixMs: 5,
      createdAtUnixMs: 5
    },
    {
      id: 6,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      seq: 6,
      eventId: "event-6",
      actorType: "agent",
      actorId: "codex",
      itemType: "approval.requested",
      role: "assistant",
      callType: "approval",
      callId: "approval-1",
      name: "Approval",
      status: "waiting_approval",
      payload: {
        input: {
          requestId: "approval-request-1",
          options: [
            { id: "allow_once", label: "Allow once", kind: "allow_once" }
          ]
        }
      },
      occurredAtUnixMs: 6,
      createdAtUnixMs: 6
    },
    {
      id: 7,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      seq: 7,
      eventId: "event-7",
      actorType: "agent",
      actorId: "codex",
      itemType: "interactive.requested",
      role: "assistant",
      callType: "interactive",
      callId: "ask-1",
      name: "AskUserQuestion",
      status: "waiting_input",
      payload: {
        input: {
          requestId: "ask-request-1",
          questions: [
            {
              id: "approach",
              header: "Approach",
              question: "Which direction should we take?",
              options: [
                { label: "Use typed renderer", description: "Keep going" }
              ]
            }
          ]
        }
      },
      occurredAtUnixMs: 7,
      createdAtUnixMs: 7
    }
  ];
}
