import { act, renderHook } from "@testing-library/react";
import {
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  selectEngineSessionSettingsUpdate
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

  it("keeps the latest queued settings visible while the session runtime reconnects", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: vi.fn(() => new Promise(() => undefined)) },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const session = (settings: { model: string; planMode: boolean }) =>
      normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "session-1",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        settings,
        workspaceId: "workspace-1"
      });
    sessionEngine.dispatch({
      type: "session/snapshotReceived",
      sessions: [session({ model: "model-canonical", planMode: false })]
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
        settings: { model: "model-first" },
        type: "session/settingsUpdateRequested",
        workspaceId: "workspace-1"
      });
      sessionEngine.dispatch({
        agentSessionId: "session-1",
        commandId: "settings-2",
        settings: { model: "model-latest", planMode: true },
        type: "session/settingsUpdateRequested",
        workspaceId: "workspace-1"
      });
      sessionEngine.dispatch({
        type: "session/runtimeAvailabilityChanged",
        agentSessionId: "session-1",
        availability: {
          state: "blocked",
          reason: "transport_reconnecting"
        }
      });
      sessionEngine.dispatch({
        commandId: "settings-1",
        commandType: "session/updateSettings",
        correlationId: "session-1",
        outcome: "succeeded",
        type: "engine/commandResult",
        value: {
          agentSessionId: "session-1",
          session: session({ model: "model-first", planMode: false })
        }
      });
    });

    expect(
      selectEngineSessionSettingsUpdate(
        sessionEngine.getSnapshot(),
        "session-1"
      )?.status
    ).toBe("waitingForRuntime");
    expect(
      rendered.result.current.activeCanonicalComposerSettings
    ).toMatchObject({ model: "model-latest", planMode: true });

    act(() => {
      sessionEngine.dispatch({
        type: "session/runtimeAvailabilityChanged",
        agentSessionId: "session-1",
        availability: { state: "available" }
      });
    });
    expect(
      selectEngineSessionSettingsUpdate(
        sessionEngine.getSnapshot(),
        "session-1"
      )?.status
    ).toBe("inFlight");
    expect(
      rendered.result.current.activeCanonicalComposerSettings
    ).toMatchObject({ model: "model-latest", planMode: true });

    act(() => {
      sessionEngine.dispatch({
        commandId: "settings-2",
        commandType: "session/updateSettings",
        correlationId: "session-1",
        outcome: "succeeded",
        type: "engine/commandResult",
        value: {
          agentSessionId: "session-1",
          session: session({ model: "model-latest", planMode: true })
        }
      });
    });
    expect(
      selectEngineSessionSettingsUpdate(
        sessionEngine.getSnapshot(),
        "session-1"
      )?.status
    ).toBe("idle");
    expect(
      rendered.result.current.activeCanonicalComposerSettings
    ).toMatchObject({ model: "model-latest", planMode: true });
  });

  it("observes runtime availability for the selected session only", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: vi.fn(() => new Promise(() => undefined)) },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    sessionEngine.dispatch({
      type: "session/snapshotReceived",
      sessions: ["session-1", "session-2"].map((agentSessionId) =>
        normalizeAgentActivitySession({
          activeTurnId: null,
          agentSessionId,
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "codex",
          workspaceId: "workspace-1"
        })
      )
    });
    const rendered = renderHook(
      ({ activeConversationId }) =>
        useAgentGUISessionEngineState({
          activeConversationId,
          sessionEngine
        }),
      { initialProps: { activeConversationId: "session-1" } }
    );

    act(() => {
      sessionEngine.dispatch({
        type: "session/runtimeAvailabilityChanged",
        agentSessionId: "session-1",
        availability: {
          state: "blocked",
          reason: "transport_reconnecting"
        }
      });
    });
    expect(rendered.result.current.activeEngineRuntimeAvailability).toEqual({
      state: "blocked",
      reason: "transport_reconnecting"
    });

    rendered.rerender({ activeConversationId: "session-2" });
    expect(rendered.result.current.activeEngineRuntimeAvailability).toEqual({
      state: "available"
    });
  });
});
