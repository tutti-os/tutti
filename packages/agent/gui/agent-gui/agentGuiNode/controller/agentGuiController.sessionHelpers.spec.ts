import { describe, expect, it } from "vitest";
import type { AgentSessionState } from "../../../shared/agentSessionTypes";
import { mergeAgentSessionControlStateSnapshot } from "./agentGuiController.sessionHelpers";

function sessionState(
  overrides: Partial<AgentSessionState> = {}
): AgentSessionState {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "agent-session-1",
    provider: "claude-code",
    status: "ready",
    updatedAtUnixMs: 1,
    ...overrides
  };
}

describe("mergeAgentSessionControlStateSnapshot", () => {
  it("preserves runtime usage when a full reload snapshot omits usage", () => {
    const current = sessionState({
      runtimeContext: {
        model: "sonnet",
        usage: {
          contextWindow: { usedTokens: 29_538, totalTokens: 1_000_000 }
        }
      }
    });
    const snapshot = sessionState({
      runtimeContext: {
        model: "haiku"
      },
      settings: {
        model: "haiku"
      }
    });

    expect(
      mergeAgentSessionControlStateSnapshot(current, snapshot).runtimeContext
    ).toEqual({
      model: "haiku",
      usage: {
        contextWindow: { usedTokens: 29_538, totalTokens: 1_000_000 }
      }
    });
  });

  it("uses incoming runtime usage when the snapshot includes usage", () => {
    const current = sessionState({
      runtimeContext: {
        usage: {
          contextWindow: { usedTokens: 29_538, totalTokens: 1_000_000 }
        }
      }
    });
    const snapshot = sessionState({
      runtimeContext: {
        model: "haiku",
        usage: {
          contextWindow: { usedTokens: 30_000, totalTokens: 200_000 }
        }
      }
    });

    expect(
      mergeAgentSessionControlStateSnapshot(current, snapshot).runtimeContext
    ).toEqual(snapshot.runtimeContext);
  });
});
