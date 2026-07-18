import { act, renderHook } from "@testing-library/react";
import {
  createAgentSessionEngine,
  normalizeAgentActivitySession
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { useAgentGUISessionEngineState } from "./useAgentGUISessionEngineState";

describe("useAgentGUISessionEngineState", () => {
  it("shows an optimistic session selection then silently restores canonical settings on failure", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: vi.fn(() => new Promise(() => undefined)) },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    sessionEngine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        normalizeAgentActivitySession({
          activeTurnId: null,
          agentSessionId: "session-1",
          agentTargetId: "local:opencode",
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "opencode",
          settings: { permissionModeId: "ask" },
          workspaceId: "workspace-1"
        })
      ]
    });
    const rendered = renderHook(() =>
      useAgentGUISessionEngineState({
        activeConversationId: "session-1",
        sessionEngine
      })
    );

    act(() => {
      sessionEngine.dispatch({
        agentSessionId: "session-1",
        commandId: "settings-1",
        settings: { permissionModeId: "full-access" },
        type: "session/settingsUpdateRequested",
        workspaceId: "workspace-1"
      });
    });
    expect(
      rendered.result.current.activeCanonicalComposerSettings.permissionModeId
    ).toBe("full-access");

    act(() => {
      sessionEngine.dispatch({
        commandId: "settings-1",
        commandType: "session/updateSettings",
        correlationId: "session-1",
        errorCode: "settings_require_new_session",
        errorMessage: "requires a new session",
        outcome: "failed",
        type: "engine/commandResult"
      });
    });
    expect(
      rendered.result.current.activeCanonicalComposerSettings.permissionModeId
    ).toBe("ask");
    expect(rendered.result.current.activeEngineError).toBeNull();
  });
});
