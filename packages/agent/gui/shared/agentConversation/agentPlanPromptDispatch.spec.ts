import { describe, expect, it } from "vitest";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
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
            workspaceId: "workspace-1",
            agentSessionId: "session-1",
            provider: "codex",
            cwd: "/workspace",
            title: "Plan",
            activeTurnId: null,
            latestTurn: {
              agentSessionId: "session-1",
              turnId: "turn-1",
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
});
