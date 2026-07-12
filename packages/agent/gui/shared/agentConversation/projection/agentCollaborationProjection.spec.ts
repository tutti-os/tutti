import { describe, expect, it } from "vitest";
import {
  normalizeAgentActivitySession,
  type AgentActivityMessage,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityCard } from "../../workspaceAgentActivityListViewModel";
import { projectWorkspaceAgentMessagesToConversationVM } from "./workspaceAgentMessageProjection";
import { projectAgentCollaborationVM } from "./agentCollaborationProjection";
import type { AgentMessageRowVM } from "../contracts/agentMessageRowVM";

describe("projectAgentCollaborationVM", () => {
  it("projects the full typed payload", () => {
    const vm = projectAgentCollaborationVM({
      workspaceId: "room-1",
      agentSessionId: "session-1",
      status: "completed",
      payload: {
        runId: "run-1",
        mode: "consult",
        status: "completed",
        triggerSource: "user",
        triggerReason: "composer_consult",
        modelPlanId: "plan-1",
        model: "kimi-k2",
        contextScope: "summary",
        resultText: "Consider a version-key guard.",
        durationMs: 5200,
        usage: { inputTokens: 812, outputTokens: 96 },
        adoption: "pending"
      }
    });

    expect(vm).toEqual({
      kind: "collaboration",
      runId: "run-1",
      workspaceId: "room-1",
      agentSessionId: "session-1",
      mode: "consult",
      status: "completed",
      triggerSource: "user",
      triggerReason: "composer_consult",
      targetSessionId: null,
      targetAgentTargetId: null,
      modelPlanId: "plan-1",
      modelPlanName: null,
      model: "kimi-k2",
      contextScope: "summary",
      resultText: "Consider a version-key guard.",
      failureReason: null,
      durationMs: 5200,
      usage: { inputTokens: 812, outputTokens: 96 },
      adoption: "pending"
    });
  });

  it("falls back to the item status and rejects payloads without a run identity", () => {
    const running = projectAgentCollaborationVM({
      workspaceId: "room-1",
      agentSessionId: "session-1",
      status: "running",
      payload: { runId: "run-2", mode: "consult" }
    });
    expect(running?.status).toBe("running");
    expect(running?.adoption).toBe("not_applicable");
    expect(running?.usage).toBeNull();

    expect(
      projectAgentCollaborationVM({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        status: "running",
        payload: { mode: "consult" }
      })
    ).toBeNull();
    expect(
      projectAgentCollaborationVM({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        status: "running",
        payload: { runId: "run-3" }
      })
    ).toBeNull();
  });
});

describe("collaboration message kind projection", () => {
  it("projects a running consult without result text into a collaboration row", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session({ effectiveStatus: "working" }),
      workspaceRoot: "/workspace/demo",
      messages: [
        message({
          messageId: "user-1",
          id: 1,
          version: 1,
          role: "user",
          kind: "text",
          payload: { text: "Please double-check the plan." }
        }),
        collaborationMessage({
          id: 2,
          version: 2,
          status: "running",
          payload: collaborationPayload({ status: "running" })
        })
      ]
    });

    const row = collaborationRow(conversation.rows);
    expect(row).not.toBeNull();
    const content = row?.messages[0];
    expect(content?.contentKind).toBe("collaboration");
    expect(content?.collaboration).toMatchObject({
      runId: "run-1",
      mode: "consult",
      status: "running",
      triggerSource: "user",
      modelPlanId: "plan-1",
      model: "kimi-k2"
    });
    expect(content?.collaboration?.resultText).toBeNull();
  });

  it("updates the same collaboration row in place on status transitions", () => {
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
          payload: { text: "Please double-check the plan." }
        }),
        collaborationMessage({
          id: 2,
          version: 2,
          status: "running",
          payload: collaborationPayload({ status: "running" })
        }),
        collaborationMessage({
          id: 3,
          version: 3,
          status: "completed",
          payload: collaborationPayload({
            status: "completed",
            resultText: "Looks right; watch the merge key.",
            durationMs: 4100,
            usage: { inputTokens: 900, outputTokens: 120 },
            adoption: "pending"
          })
        })
      ]
    });

    const rows = conversation.rows.filter(
      (row): row is AgentMessageRowVM =>
        row.kind === "message" &&
        row.messages.some((content) => content.contentKind === "collaboration")
    );
    expect(rows).toHaveLength(1);
    const content = rows[0]?.messages[0];
    expect(content?.collaboration).toMatchObject({
      runId: "run-1",
      status: "completed",
      resultText: "Looks right; watch the merge key.",
      durationMs: 4100,
      usage: { inputTokens: 900, outputTokens: 120 },
      adoption: "pending"
    });
    // Collaboration cards own their copy affordance; no transcript copy text.
    expect(content?.copyText ?? null).toBeNull();
  });

  it("does not merge collaboration rows into adjacent assistant prose", () => {
    const conversation = projectWorkspaceAgentMessagesToConversationVM({
      activity: activity(),
      session: session(),
      workspaceRoot: "/workspace/demo",
      messages: [
        message({
          messageId: "assistant-1",
          id: 1,
          version: 1,
          role: "assistant",
          kind: "text",
          payload: { text: "Starting a consult." }
        }),
        collaborationMessage({
          id: 2,
          version: 2,
          status: "completed",
          payload: collaborationPayload({
            status: "completed",
            resultText: "Advice text."
          })
        }),
        message({
          messageId: "assistant-2",
          id: 3,
          version: 3,
          role: "assistant",
          kind: "text",
          payload: { text: "Continuing after the consult." }
        })
      ]
    });

    const messageRows = conversation.rows.filter(
      (row): row is AgentMessageRowVM => row.kind === "message"
    );
    expect(messageRows).toHaveLength(3);
    expect(
      messageRows.map((row) =>
        row.messages.some((content) => content.contentKind === "collaboration")
      )
    ).toEqual([false, true, false]);
  });
});

function collaborationRow(
  rows: readonly { kind: string }[]
): AgentMessageRowVM | null {
  for (const row of rows) {
    if (
      row.kind === "message" &&
      (row as AgentMessageRowVM).messages.some(
        (content) => content.contentKind === "collaboration"
      )
    ) {
      return row as AgentMessageRowVM;
    }
  }
  return null;
}

function collaborationPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    runId: "run-1",
    mode: "consult",
    status: "running",
    triggerSource: "user",
    triggerReason: "composer_consult",
    modelPlanId: "plan-1",
    model: "kimi-k2",
    adoption: "not_applicable",
    ...overrides
  };
}

function collaborationMessage(
  overrides: Partial<AgentActivityMessage> & { id?: number }
): AgentActivityMessage {
  return message({
    messageId: "collab:run-1",
    turnId: "turn-1",
    role: "assistant",
    kind: "collaboration",
    ...overrides
  });
}

function message(
  overrides: Partial<AgentActivityMessage> & { id?: number }
): AgentActivityMessage {
  const { id: legacyStorageId, ...canonical } = overrides;
  const version = overrides.version ?? legacyStorageId ?? 1;
  return {
    agentSessionId: "session-1",
    messageId: "message-1",
    version,
    turnId: "turn-1",
    role: "assistant",
    kind: "text",
    payload: {},
    occurredAtUnixMs: version,
    ...canonical
  };
}

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
    activeTurnId: null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    workspaceId: "room-1",
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
