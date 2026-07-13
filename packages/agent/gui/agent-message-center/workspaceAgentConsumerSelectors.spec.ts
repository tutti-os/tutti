import { describe, expect, it } from "vitest";
import {
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  selectWorkspaceAgentMessageCenterPresentation,
  workspaceAgentMessageCenterPresentationEqual
} from "./workspaceAgentMessageCenterEngineModel";
import {
  selectWorkspaceAgentConsumerCounts,
  selectWorkspaceAgentConsumerSessions
} from "./workspaceAgentConsumerSelectors";

describe("workspaceAgentConsumerSelectors", () => {
  it("keeps message-center presentation equal across unrelated engine changes", () => {
    const engine = createEngine();
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [session({})]
    });
    const before = selectWorkspaceAgentMessageCenterPresentation(
      engine.getSnapshot()
    );
    engine.dispatch({ type: "engine/connectionChanged", status: "connected" });
    const after = selectWorkspaceAgentMessageCenterPresentation(
      engine.getSnapshot()
    );
    expect(workspaceAgentMessageCenterPresentationEqual(before, after)).toBe(
      true
    );
  });
  it("derives shared consumer state from canonical turn and interaction entities", () => {
    const engine = createEngine();
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        session({
          activeTurnId: "turn-1",
          activeTurn: {
            turnId: "turn-1",
            agentSessionId: "session-1",
            phase: "running",
            startedAtUnixMs: 10,
            updatedAtUnixMs: 20
          },
          pendingInteractions: [
            {
              requestId: "request-1",
              agentSessionId: "session-1",
              turnId: "turn-1",
              kind: "question",
              status: "pending",
              input: { question: "Choose an option" },
              createdAtUnixMs: 21,
              updatedAtUnixMs: 21
            }
          ]
        })
      ]
    });

    const consumers = selectWorkspaceAgentConsumerSessions(
      engine.getSnapshot()
    );
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.displayStatus).toBe("waiting");
    expect(selectWorkspaceAgentConsumerCounts(engine.getSnapshot())).toEqual({
      canceled: 0,
      completed: 0,
      failed: 0,
      idle: 0,
      waiting: 1,
      working: 0
    });

    const model = buildWorkspaceAgentMessageCenterModelFromEngine(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      { workspaceId: "workspace-1", sessionMessagesById: {} }
    );
    expect(model.items[0]).toMatchObject({
      agentSessionId: "session-1",
      needsAttentionKind: "question",
      needsAttentionSummary: "Choose an option",
      status: "waiting"
    });
  });

  it("keeps canonical settled turn state authoritative over stale status messages", () => {
    const engine = createEngine();
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        session({
          activeTurnId: null,
          activeTurn: {
            turnId: "turn-completed",
            agentSessionId: "session-1",
            phase: "settled",
            outcome: "completed",
            startedAtUnixMs: 10,
            settledAtUnixMs: 20,
            updatedAtUnixMs: 20
          }
        })
      ]
    });

    const model = buildWorkspaceAgentMessageCenterModelFromEngine(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      {
        workspaceId: "workspace-1",
        sessionMessagesById: {
          "session-1": [
            {
              workspaceId: "workspace-1",
              agentSessionId: "session-1",
              messageId: "stale-question",
              version: 1,
              turnId: "turn-stale",
              role: "agent",
              kind: "question",
              status: "failed",
              payload: {
                input: {
                  questions: [{ question: "Stale question" }]
                }
              },
              occurredAtUnixMs: 5
            }
          ]
        }
      }
    );

    expect(model.items[0]).toMatchObject({
      status: "completed",
      pendingPrompt: null,
      needsAttentionKind: null,
      latestTurnOutcome: {
        status: "completed",
        turnId: "turn-completed"
      }
    });
    expect(model.waitingCount).toBe(0);
  });
});

function createEngine() {
  return createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: { execute: async () => ({}) },
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler: { schedule: () => ({ cancel() {} }) }
  });
}

function session(
  overrides: Partial<AgentActivitySession> = {}
): AgentActivitySession {
  return normalizeAgentActivitySession({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/workspace",
    title: "Canonical session",
    ...overrides
  });
}
