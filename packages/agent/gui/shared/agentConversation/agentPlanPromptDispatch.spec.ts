import { describe, expect, it } from "vitest";
import {
  createAgentSessionEngine,
  type EngineCommand
} from "@tutti-os/agent-activity-core";
import { dispatchAgentPlanPromptAction } from "./agentPlanPromptDispatch";

describe("dispatchAgentPlanPromptAction", () => {
  it.each([
    ["implement", "plan/submitDecision"],
    ["feedback", "queue/sendPrompt"],
    ["skip", null]
  ] as const)(
    "dispatches %s against a settled completed plan turn",
    async (action, commandType) => {
      const executedTypes: string[] = [];
      const engine = createAgentSessionEngine({
        clock: { nowUnixMs: () => 10 },
        commandPort: {
          async execute(command) {
            executedTypes.push(command.type);
          }
        },
        identity: { origin: "test", workspaceId: "workspace-1" },
        scheduler: { schedule: () => ({ cancel() {} }) }
      });
      engine.dispatch({
        type: "session/snapshotReceived",
        sessions: [
          {
            ...{
              activeTurnId: null,
              latestTurnInteractions: [],
              pendingInteractions: []
            },
            workspaceId: "workspace-1",
            agentSessionId: "session-1",
            provider: "codex",
            cwd: "/workspace",
            title: "Plan",
            activeTurnId: null,
            latestTurn: {
              agentSessionId: "session-1",
              turnId: "turn-1",
              origin: "user_prompt",
              phase: "settled",
              outcome: "completed",
              startedAtUnixMs: 1,
              updatedAtUnixMs: 2,
              settledAtUnixMs: 2
            }
          }
        ]
      });

      expect(
        dispatchAgentPlanPromptAction({
          action,
          agentSessionId: "session-1",
          engine,
          feedbackText: action === "feedback" ? "Revise it" : undefined,
          nowUnixMs: () => 20,
          requestId: "turn-1",
          workspaceId: "workspace-1"
        })
      ).toBe(true);
      await Promise.resolve();
      expect(executedTypes[0] ?? null).toBe(commandType);
    }
  );

  it("rejects a request id that is not the latest settled completed turn", () => {
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: async () => undefined },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    expect(
      dispatchAgentPlanPromptAction({
        action: "implement",
        agentSessionId: "session-1",
        engine,
        requestId: "turn-1",
        workspaceId: "workspace-1"
      })
    ).toBe(false);
  });

  it("adds Tutti audit provenance to Plan feedback without changing Plan state", async () => {
    const executed: EngineCommand[] = [];
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 10 },
      commandPort: {
        async execute(command) {
          executed.push(command);
        }
      },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    engine.dispatch({
      sessions: [
        {
          activeTurnId: null,
          agentSessionId: "session-1",
          cwd: "/workspace",
          latestTurn: {
            agentSessionId: "session-1",
            outcome: "completed",
            origin: "user_prompt",
            phase: "settled",
            settledAtUnixMs: 2,
            startedAtUnixMs: 1,
            turnId: "turn-1",
            updatedAtUnixMs: 2
          },
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "codex",
          settings: { planMode: true },
          title: "Plan with Tutti",
          tuttiModeActivation: {
            agentSessionId: "session-1",
            createdAtUnixMs: 1,
            currentRevision: {
              activationId: "tutti-1",
              createdAtUnixMs: 1,
              orchestrationIntensity: 50,
              revision: 1,
              source: "slash_command",
              status: "active"
            },
            id: "tutti-1",
            status: "active",
            updatedAtUnixMs: 1,
            workspaceId: "workspace-1"
          },
          updatedAtUnixMs: 2,
          workspaceId: "workspace-1"
        }
      ],
      type: "session/snapshotReceived"
    });

    expect(
      dispatchAgentPlanPromptAction({
        action: "feedback",
        agentSessionId: "session-1",
        engine,
        feedbackText: "Revise it",
        nowUnixMs: () => 20,
        requestId: "turn-1",
        workspaceId: "workspace-1"
      })
    ).toBe(true);
    await Promise.resolve();

    expect(executed[0]?.type).toBe("queue/sendPrompt");
    expect(
      executed[0]?.type === "queue/sendPrompt"
        ? executed[0].capabilityRefs
        : null
    ).toEqual([{ capability: "tutti", source: "slash_command" }]);
  });
});
