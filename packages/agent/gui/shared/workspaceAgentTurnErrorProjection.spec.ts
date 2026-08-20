import { describe, expect, it } from "vitest";
import {
  normalizeAgentActivitySession,
  type AgentActivitySession,
  type AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import {
  buildCanonicalWorkspaceAgentDetailView,
  projectWorkspaceAgentTimelineToConversationVM
} from "./agentConversation/projection/workspaceAgentTimelineProjection";
import type { WorkspaceAgentActivityCard } from "./workspaceAgentActivityListViewModel";
import type { WorkspaceAgentSessionDetailTurn } from "./workspaceAgentSessionDetailViewModel";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import { enrichProjectedTurnsWithCanonicalErrors } from "./workspaceAgentTurnErrorProjection";

describe("canonical Turn error projection", () => {
  it("projects visible agent errors from assistant message payloads", () => {
    const conversation = projectWorkspaceAgentTimelineToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        userMessage("turn-1", 1, "Ship the patch"),
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

  it("adds a terminal canonical error to a hydrated Turn when the provider emitted no error message", () => {
    const failed = failedTurn({
      error: {
        message: "Selected model is at capacity. Please try a different model."
      }
    });
    const input = {
      activity: activity(),
      session: session({ latestTurn: failed }),
      sessionTurns: [failed],
      workspaceRoot: "/workspace/demo",
      timelineItems: [userMessage("turn-1", 1, "Ship the patch")]
    };
    const detail = buildCanonicalWorkspaceAgentDetailView(input);
    const conversation = projectWorkspaceAgentTimelineToConversationVM(input);

    expect(detail.turns[0]?.agentMessages).toEqual([
      expect.objectContaining({
        id: "turn-error:session-1:turn-1",
        body: "Selected model is at capacity. Please try a different model.",
        statusKind: "failed",
        visibleError: {
          code: null,
          phase: "turn",
          provider: "codex",
          detail:
            "Selected model is at capacity. Please try a different model.",
          retryable: null
        }
      })
    ]);
    expect(
      conversation.rows.flatMap((row) =>
        row.kind === "message" && row.speaker === "assistant"
          ? row.messages
          : []
      )
    ).toEqual([
      expect.objectContaining({
        id: "turn-error:session-1:turn-1",
        visibleError: expect.objectContaining({
          detail: "Selected model is at capacity. Please try a different model."
        })
      })
    ]);
  });

  it("upgrades a matching assistant failure instead of duplicating the canonical error", () => {
    const failed = failedTurn({
      error: { code: "provider_error", message: "Provider unavailable" }
    });
    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: session({ latestTurn: failed }),
      sessionTurns: [failed],
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        userMessage("turn-1", 1, "Ship the patch"),
        assistantMessage("turn-1", 2, "Provider unavailable", "failed")
      ]
    });

    expect(detail.turns[0]?.agentMessages).toHaveLength(1);
    expect(detail.turns[0]?.agentMessages[0]).toEqual(
      expect.objectContaining({
        id: "event-2",
        visibleError: expect.objectContaining({
          code: "provider_error",
          detail: "Provider unavailable"
        })
      })
    );
  });

  it("keeps an existing structured visible error as the single Turn failure row", () => {
    const failed = failedTurn({
      error: { code: "provider_error", message: "Canonical provider failure" }
    });
    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: session({ latestTurn: failed }),
      sessionTurns: [failed],
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        userMessage("turn-1", 1, "Ship the patch"),
        {
          ...assistantMessage("turn-1", 2, "Provider request failed", "failed"),
          payload: {
            kind: "agent_visible_error",
            code: "provider_error",
            phase: "run",
            provider: "codex",
            detail: "Provider request failed",
            retryable: true
          }
        }
      ]
    });

    expect(detail.turns[0]?.agentMessages).toHaveLength(1);
    expect(detail.turns[0]?.agentMessages[0]?.id).toBe("event-2");
    expect(detail.turns[0]?.agentMessages[0]?.visibleError?.detail).toBe(
      "Provider request failed"
    );
  });

  it("adds canonical raw detail to an existing structured failure row", () => {
    const failed = failedTurn({
      error: {
        code: "provider_error",
        message: "Canonical provider failure",
        detail: "provider response\nwith diagnostic context"
      }
    });
    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: session({ latestTurn: failed }),
      sessionTurns: [failed],
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        userMessage("turn-1", 1, "Ship the patch"),
        {
          ...assistantMessage("turn-1", 2, "Provider request failed", "failed"),
          payload: {
            kind: "agent_visible_error",
            code: "provider_error",
            phase: "run",
            provider: "codex",
            detail: "Provider request failed",
            retryable: true
          }
        }
      ]
    });

    expect(detail.turns[0]?.agentMessages).toHaveLength(1);
    expect(detail.turns[0]?.agentMessages[0]?.visibleError).toEqual(
      expect.objectContaining({
        detail: "provider response\nwith diagnostic context",
        detailAvailable: true
      })
    );
  });

  it("attaches a historical error to its owning Turn after that Turn is hydrated", () => {
    const failed = failedTurn();
    const completed = completedTurn({
      turnId: "turn-2",
      startedAtUnixMs: 20,
      settledAtUnixMs: 30,
      updatedAtUnixMs: 30
    });
    const detail = buildCanonicalWorkspaceAgentDetailView({
      activity: activity(),
      session: session({ latestTurn: completed }),
      sessionTurns: [failed, completed],
      workspaceRoot: "/workspace/demo",
      timelineItems: [
        userMessage("turn-1", 1, "Ship the patch"),
        userMessage("turn-2", 20, "Try again")
      ]
    });

    expect(detail.turns.map((turn) => turn.id)).toEqual(["turn-1", "turn-2"]);
    expect(detail.turns[0]?.agentMessages).toEqual([
      expect.objectContaining({
        id: "turn-error:session-1:turn-1",
        visibleError: expect.objectContaining({ detail: "Turn failed" })
      })
    ]);
    expect(detail.turns[1]?.agentMessages).toHaveLength(0);
  });

  it("does not create an older failed Turn outside the hydrated transcript window", () => {
    const failed = failedTurn();
    const completed = completedTurn({
      turnId: "turn-2",
      startedAtUnixMs: 20,
      settledAtUnixMs: 30,
      updatedAtUnixMs: 30
    });
    const input = {
      activity: activity(),
      session: session({ latestTurn: completed }),
      sessionTurns: [failed, completed],
      workspaceRoot: "/workspace/demo",
      timelineItems: [userMessage("turn-2", 20, "Try again")]
    };
    const detail = buildCanonicalWorkspaceAgentDetailView(input);
    const conversation = projectWorkspaceAgentTimelineToConversationVM(input);

    expect(detail.turns.map((turn) => turn.id)).toEqual(["turn-2"]);
    expect(detail.turns[0]?.userMessage?.body).toBe("Try again");
    expect(
      conversation.rows.some(
        (row) =>
          row.kind === "message" &&
          row.speaker === "assistant" &&
          row.messages.some(
            (message) => message.id === "turn-error:session-1:turn-1"
          )
      )
    ).toBe(false);
  });

  it("projects the older error exactly once when an earlier page hydrates its transcript anchor", () => {
    const failed = failedTurn();
    const completed = completedTurn({
      turnId: "turn-2",
      startedAtUnixMs: 20,
      settledAtUnixMs: 30,
      updatedAtUnixMs: 30
    });
    const baseInput = {
      activity: activity(),
      session: session({ latestTurn: completed }),
      sessionTurns: [failed, completed],
      workspaceRoot: "/workspace/demo"
    };

    const latestPage = buildCanonicalWorkspaceAgentDetailView({
      ...baseInput,
      timelineItems: [userMessage("turn-2", 20, "Try again")]
    });
    const expandedWindow = buildCanonicalWorkspaceAgentDetailView({
      ...baseInput,
      timelineItems: [
        userMessage("turn-1", 1, "Ship the patch"),
        userMessage("turn-2", 20, "Try again")
      ]
    });

    expect(latestPage.turns.map((turn) => turn.id)).toEqual(["turn-2"]);
    expect(expandedWindow.turns.map((turn) => turn.id)).toEqual([
      "turn-1",
      "turn-2"
    ]);
    expect(
      expandedWindow.turns.flatMap((turn) =>
        turn.agentMessages.filter(
          (message) => message.id === "turn-error:session-1:turn-1"
        )
      )
    ).toHaveLength(1);
    expect(
      expandedWindow.turns[0]?.agentMessages[0]?.visibleError?.detail
    ).toBe("Turn failed");
  });

  it("projects the latest failed Turn when no transcript item has been hydrated", () => {
    const failed = failedTurn();
    const input = {
      activity: activity(),
      session: session({ latestTurn: failed }),
      sessionTurns: [failed],
      workspaceRoot: "/workspace/demo",
      timelineItems: []
    };
    const detail = buildCanonicalWorkspaceAgentDetailView(input);
    const conversation = projectWorkspaceAgentTimelineToConversationVM(input);

    expect(detail.turns).toEqual([
      expect.objectContaining({
        id: "turn-1",
        agentMessages: [
          expect.objectContaining({
            id: "turn-error:session-1:turn-1",
            body: "Turn failed",
            visibleError: expect.objectContaining({ detail: "Turn failed" })
          })
        ]
      })
    ]);
    expect(
      conversation.rows.some(
        (row) =>
          row.kind === "message" &&
          row.speaker === "assistant" &&
          row.messages.some(
            (message) =>
              message.id === "turn-error:session-1:turn-1" &&
              message.visibleError?.detail === "Turn failed"
          )
      )
    ).toBe(true);
  });

  it("keeps the current running Turn last when an older failed Turn is outside the window", () => {
    const failed = failedTurn();
    const running = runningTurn({
      turnId: "turn-2",
      startedAtUnixMs: 20,
      updatedAtUnixMs: 30
    });
    const runningSession = session({
      activeTurnId: "turn-2",
      activeTurn: running,
      latestTurn: running
    });
    const input = {
      activity: activity(),
      session: runningSession,
      sessionTurns: [failed, running],
      workspaceRoot: "/workspace/demo",
      timelineItems: [userMessage("turn-2", 20, "Continue working")]
    };
    const detail = buildCanonicalWorkspaceAgentDetailView(input);
    const conversation = projectWorkspaceAgentTimelineToConversationVM(input);

    expect(detail.turns.map((turn) => turn.id)).toEqual(["turn-2"]);
    expect(detail.turns.at(-1)?.id).toBe("turn-2");
    expect(detail.showProcessingIndicator).toBe(true);
    expect(conversation.rows.at(-1)?.turnId).toBe("turn-2");
    expect(
      conversation.rows.some(
        (row) =>
          row.kind === "message" &&
          row.speaker === "assistant" &&
          row.messages.some((message) => message.turnId === "turn-1")
      )
    ).toBe(false);
  });

  it.each(["failed", "interrupted"] as const)(
    "does not change transcript membership for an unhydrated %s Turn",
    (outcome) => {
      const currentTurn = projectedTurn("turn-2");
      const turns = new Map([[currentTurn.id, currentTurn]]);

      enrichProjectedTurnsWithCanonicalErrors({
        turns,
        latestTurnId: "turn-2",
        sessionTurns: [
          failedTurn({
            outcome,
            error: { message: `${outcome} outside the window` }
          })
        ],
        provider: "codex",
        agentSessionId: "session-1"
      });

      expect([...turns.keys()]).toEqual(["turn-2"]);
      expect(turns.get("turn-2")).toBe(currentTurn);
      expect(currentTurn.agentMessages).toEqual([]);
    }
  );
});

function activity(): WorkspaceAgentActivityCard {
  return {
    id: "activity-1",
    sessionId: "session-1",
    agentName: "Codex",
    agentProvider: "codex",
    status: "working",
    title: "Codex",
    latestActivitySummary: "Working",
    sortTimeUnixMs: 30,
    changedFiles: [],
    userId: "user-1",
    userName: "Taylor",
    userAvatarUrl: ""
  };
}

function session(
  overrides: Partial<AgentActivitySession> = {}
): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    userId: "user-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    cwd: "/workspace/demo",
    title: "Codex",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 30,
    latestTurn: completedTurn(),
    ...overrides
  });
}

function failedTurn(
  overrides: Partial<AgentActivityTurn> = {}
): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    error: { message: "Turn failed" },
    origin: "user_prompt",
    outcome: "failed",
    phase: "settled",
    settledAtUnixMs: 10,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 10,
    ...overrides
  };
}

function completedTurn(
  overrides: Partial<AgentActivityTurn> = {}
): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    error: null,
    origin: "user_prompt",
    outcome: "completed",
    phase: "settled",
    settledAtUnixMs: 10,
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 10,
    ...overrides
  };
}

function runningTurn(
  overrides: Partial<AgentActivityTurn> = {}
): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    error: null,
    origin: "user_prompt",
    outcome: null,
    phase: "running",
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 10,
    ...overrides
  };
}

function projectedTurn(turnId: string): WorkspaceAgentSessionDetailTurn {
  return {
    id: turnId,
    userMessage: null,
    userMessages: [],
    agentMessages: [],
    toolCalls: [],
    toolCallCount: 0,
    hasFailedToolCall: false,
    agentItems: []
  };
}

function userMessage(
  turnId: string,
  seq: number,
  content: string
): WorkspaceAgentActivityTimelineItem {
  return {
    id: seq,
    workspaceId: "room-1",
    agentSessionId: "session-1",
    turnId,
    seq,
    eventId: `event-${seq}`,
    actorType: "user",
    actorId: "user-1",
    itemType: "message.user",
    role: "user",
    content,
    occurredAtUnixMs: seq,
    createdAtUnixMs: seq
  };
}

function assistantMessage(
  turnId: string,
  seq: number,
  content: string,
  status: string
): WorkspaceAgentActivityTimelineItem {
  return {
    id: seq,
    workspaceId: "room-1",
    agentSessionId: "session-1",
    turnId,
    seq,
    eventId: `event-${seq}`,
    actorType: "agent",
    actorId: "codex",
    itemType: "message.assistant",
    role: "assistant",
    status,
    content,
    occurredAtUnixMs: seq,
    createdAtUnixMs: seq
  };
}
