import { describe, expect, it } from "vitest";
import {
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  selectWorkspaceAgentAttentionItems,
  selectWorkspaceAgentMessageCenterPresentation,
  workspaceAgentAttentionItemsEqual,
  workspaceAgentMessageCenterPromptStatus,
  workspaceAgentMessageCenterPresentationEqual
} from "./workspaceAgentMessageCenterEngineModel";
import { selectMessageCenterAttentionDeckItems } from "./workspaceAgentMessageCenterModel";
import {
  selectWorkspaceAgentConsumerCounts,
  selectWorkspaceAgentConsumerSessions
} from "./workspaceAgentConsumerSelectors";

describe("workspaceAgentConsumerSelectors", () => {
  it("projects every pending target with exact target-level identity", () => {
    const engine = createEngine();
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        session({
          activeTurnId: "turn-1",
          activeTurn: {
            turnId: "turn-1",
            agentSessionId: "session-1",
            origin: "user_prompt",
            phase: "waiting",
            startedAtUnixMs: 10,
            updatedAtUnixMs: 22
          },
          pendingInteractions: [
            {
              requestId: "request-approval",
              agentSessionId: "session-1",
              turnId: "turn-1",
              kind: "approval",
              status: "pending",
              toolName: "Bash",
              input: {
                command: "pnpm test",
                options: [{ optionId: "allow", label: "Allow" }]
              },
              createdAtUnixMs: 21,
              updatedAtUnixMs: 21
            },
            {
              requestId: "request-question",
              agentSessionId: "session-1",
              turnId: "turn-1",
              kind: "question",
              status: "pending",
              toolName: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Which option?",
                    options: [{ label: "First" }]
                  }
                ]
              },
              createdAtUnixMs: 22,
              updatedAtUnixMs: 22
            }
          ]
        })
      ]
    });

    const first = selectWorkspaceAgentAttentionItems(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      { workspaceId: "workspace-1", sessionMessagesById: {} }
    );
    const second = selectWorkspaceAgentAttentionItems(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      { workspaceId: "workspace-1", sessionMessagesById: {} }
    );

    expect(first).toHaveLength(2);
    expect(first.map((entry) => entry.item.id)).toEqual([
      "workspace-1\nsession-1\nturn-1\nrequest-approval",
      "workspace-1\nsession-1\nturn-1\nrequest-question"
    ]);
    expect(first.map((entry) => entry.target)).toEqual([
      {
        kind: "interaction",
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        turnId: "turn-1",
        requestId: "request-approval"
      },
      {
        kind: "interaction",
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        turnId: "turn-1",
        requestId: "request-question"
      }
    ]);
    expect(workspaceAgentAttentionItemsEqual(first, second)).toBe(true);
  });

  it("normalizes canonical exit-plan interactions for the shared prompt surface", () => {
    const engine = createEngine();
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        session({
          activeTurnId: "turn-1",
          activeTurn: {
            turnId: "turn-1",
            agentSessionId: "session-1",
            origin: "user_prompt",
            phase: "waiting",
            startedAtUnixMs: 10,
            updatedAtUnixMs: 21
          },
          pendingInteractions: [
            {
              requestId: "request-exit-plan",
              agentSessionId: "session-1",
              turnId: "turn-1",
              kind: "approval",
              status: "pending",
              toolName: "ExitPlanMode",
              input: {
                toolCall: { kind: "switch_mode" },
                options: [
                  { optionId: "acceptEdits", label: "Accept edits" },
                  { optionId: "plan", label: "Keep planning" }
                ]
              },
              createdAtUnixMs: 21,
              updatedAtUnixMs: 21
            }
          ]
        })
      ]
    });

    const [entry] = selectWorkspaceAgentAttentionItems(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      { workspaceId: "workspace-1", sessionMessagesById: {} }
    );

    expect(entry?.item.pendingPrompt).toEqual(
      expect.objectContaining({
        kind: "exit-plan",
        requestId: "request-exit-plan",
        keepPlanningOptionId: "plan",
        options: [expect.objectContaining({ id: "acceptEdits" })]
      })
    );
  });

  it("projects an eligible completed plan turn as a canonical plan target", () => {
    const engine = createEngine();
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        session({
          latestTurn: {
            turnId: "turn-plan",
            agentSessionId: "session-1",
            origin: "user_prompt",
            phase: "settled",
            outcome: "completed",
            startedAtUnixMs: 10,
            settledAtUnixMs: 20,
            updatedAtUnixMs: 20
          },
          capabilities: {
            imageInput: false,
            modelImageInputRequired: false,
            modelPlanBinding: false,
            modelSwitch: false,
            skills: false,
            compact: false,
            tokenUsage: false,
            rateLimits: false,
            planMode: true,
            interrupt: false,
            activeTurnGuidance: false,
            browserUse: false,
            computerUse: false,
            goalPause: false,
            planImplementation: true,
            permissionModeChangeDuringTurn: false,
            permissionModeChangeDeferred: false,
            review: false,
            resumeRunningTurn: false
          }
        })
      ]
    });

    const [entry] = selectWorkspaceAgentAttentionItems(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      {
        workspaceId: "workspace-1",
        sessionMessagesById: {
          "session-1": [
            {
              workspaceId: "workspace-1",
              agentSessionId: "session-1",
              messageId: "plan-message",
              version: 1,
              turnId: "turn-plan",
              role: "agent",
              kind: "message",
              payload: { messageKind: "plan" },
              occurredAtUnixMs: 19
            }
          ]
        }
      }
    );

    expect(entry).toMatchObject({
      status: "idle",
      target: {
        kind: "plan-implementation",
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        turnId: "turn-plan",
        requestId: "turn-plan"
      },
      item: {
        id: "workspace-1\nsession-1\nturn-plan\nturn-plan",
        pendingPrompt: {
          kind: "plan-implementation",
          requestId: "turn-plan"
        }
      }
    });
  });

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
            origin: "user_prompt",
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

    engine.dispatch({
      type: "interaction/upserted",
      interaction: {
        requestId: "request-1",
        agentSessionId: "session-1",
        turnId: "turn-1",
        kind: "question",
        status: "answered",
        input: { question: "Choose an option" },
        createdAtUnixMs: 21,
        updatedAtUnixMs: 30
      }
    });
    const resolvedModel = buildWorkspaceAgentMessageCenterModelFromEngine(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      { workspaceId: "workspace-1", sessionMessagesById: {} }
    );
    expect(resolvedModel.items[0]?.pendingPrompt).toBeNull();
    expect(selectMessageCenterAttentionDeckItems(resolvedModel.items)).toEqual(
      []
    );
  });

  it("aggregates a child approval into its root conversation card", () => {
    const engine = createEngine();
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        session({
          activeTurnId: "root-turn-1",
          activeTurn: {
            turnId: "root-turn-1",
            agentSessionId: "session-1",
            origin: "user_prompt",
            phase: "running",
            startedAtUnixMs: 10,
            updatedAtUnixMs: 20
          },
          provider: "claude-code"
        }),
        session({
          activeTurnId: "child-turn-1",
          activeTurn: {
            turnId: "child-turn-1",
            agentSessionId: "child-1",
            origin: "provider_initiated",
            phase: "waiting",
            startedAtUnixMs: 15,
            updatedAtUnixMs: 25
          },
          agentSessionId: "child-1",
          kind: "child",
          parentAgentSessionId: "session-1",
          parentToolCallId: "toolu-agent-1",
          parentTurnId: "root-turn-1",
          pendingInteractions: [
            {
              requestId: "child-approval-1",
              agentSessionId: "child-1",
              turnId: "child-turn-1",
              kind: "approval",
              status: "pending",
              toolName: "Bash",
              input: {
                question: "Allow Bash?",
                options: [{ optionId: "allow", label: "Allow" }]
              },
              createdAtUnixMs: 26,
              updatedAtUnixMs: 26
            }
          ],
          provider: "claude-code",
          providerSessionId: "agent-1",
          rootAgentSessionId: "session-1",
          rootTurnId: "root-turn-1",
          title: "Child"
        })
      ]
    });

    const presentation = selectWorkspaceAgentMessageCenterPresentation(
      engine.getSnapshot()
    );
    const model = buildWorkspaceAgentMessageCenterModelFromEngine(
      presentation,
      { workspaceId: "workspace-1", sessionMessagesById: {} }
    );

    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      agentSessionId: "session-1",
      status: "waiting",
      pendingInteractionTarget: {
        agentSessionId: "child-1",
        requestId: "child-approval-1",
        turnId: "child-turn-1"
      },
      pendingPrompt: {
        kind: "approval",
        requestId: "child-approval-1",
        turnId: "child-turn-1"
      }
    });
    expect(model.waitingCount).toBe(1);
    expect(selectMessageCenterAttentionDeckItems(model.items)).toHaveLength(1);

    engine.dispatch({
      type: "interaction/responseRequested",
      agentSessionId: "child-1",
      commandId: "respond-child-approval-1",
      requestId: "child-approval-1",
      turnId: "child-turn-1",
      workspaceId: "workspace-1",
      optionId: "allow"
    });
    const respondingPresentation =
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot());
    expect(
      workspaceAgentMessageCenterPromptStatus(
        respondingPresentation,
        model.items[0]!
      )
    ).toBe("responding");

    engine.dispatch({
      type: "interaction/upserted",
      interaction: {
        requestId: "child-approval-1",
        agentSessionId: "child-1",
        turnId: "child-turn-1",
        kind: "approval",
        status: "answered",
        toolName: "Bash",
        input: { question: "Allow Bash?" },
        createdAtUnixMs: 26,
        updatedAtUnixMs: 30
      }
    });
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        session({
          activeTurnId: null,
          latestTurn: {
            turnId: "root-turn-1",
            agentSessionId: "session-1",
            origin: "user_prompt",
            phase: "settled",
            outcome: "completed",
            startedAtUnixMs: 10,
            settledAtUnixMs: 30,
            updatedAtUnixMs: 30
          },
          provider: "claude-code"
        }),
        session({
          activeTurnId: "child-turn-1",
          activeTurn: {
            turnId: "child-turn-1",
            agentSessionId: "child-1",
            origin: "provider_initiated",
            phase: "running",
            startedAtUnixMs: 15,
            updatedAtUnixMs: 31
          },
          agentSessionId: "child-1",
          kind: "child",
          parentAgentSessionId: "session-1",
          parentToolCallId: "toolu-agent-1",
          parentTurnId: "root-turn-1",
          provider: "claude-code",
          providerSessionId: "agent-1",
          rootAgentSessionId: "session-1",
          rootTurnId: "root-turn-1",
          title: "Child"
        })
      ]
    });
    const resumedModel = buildWorkspaceAgentMessageCenterModelFromEngine(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      { workspaceId: "workspace-1", sessionMessagesById: {} }
    );
    expect(resumedModel.items).toHaveLength(1);
    expect(resumedModel.items[0]).toMatchObject({
      agentSessionId: "session-1",
      latestTurnOutcome: null,
      pendingPrompt: null,
      status: "working"
    });
  });

  it("projects signed Agent Target presentation for open-provider sessions", () => {
    const engine = createEngine();
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        session({
          agentTargetId: "extension:gemini",
          provider: "acp:gemini"
        })
      ]
    });

    const model = buildWorkspaceAgentMessageCenterModelFromEngine(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      { workspaceId: "workspace-1", sessionMessagesById: {} },
      {
        agentPresentations: [
          {
            agentTargetId: "extension:gemini",
            iconUrl: "data:image/svg+xml;base64,gemini",
            name: "Gemini CLI"
          }
        ]
      }
    );

    expect(model.items[0]).toMatchObject({
      agentTargetId: "extension:gemini",
      agentName: "Gemini CLI",
      agentAvatarUrl: "data:image/svg+xml;base64,gemini",
      provider: "acp:gemini"
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
            origin: "user_prompt",
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
    ...{
      activeTurnId: null,
      latestTurnInteractions: [],
      pendingInteractions: []
    },
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/workspace",
    title: "Canonical session",
    ...overrides
  });
}
