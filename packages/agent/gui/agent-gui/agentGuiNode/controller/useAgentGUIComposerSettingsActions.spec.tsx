import { act, renderHook } from "@testing-library/react";
import {
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  selectEngineSessionSettingsUpdate
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import { useAgentGUIComposerSettingsActions } from "./useAgentGUIComposerSettingsActions";

describe("useAgentGUIComposerSettingsActions", () => {
  it("retries an unknown active-session update and remembers the explicit selection", () => {
    const execute = vi.fn(() => new Promise<unknown>(() => undefined));
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    sessionEngine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        normalizeAgentActivitySession({
          activeTurnId: null,
          agentTargetId: "local:claude-code",
          agentSessionId: "session-1",
          cwd: "/workspace",
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "claude-code",
          settings: { permissionModeId: "dontAsk", planMode: false },
          title: "Historical session",
          workspaceId: "workspace-1"
        })
      ]
    });
    sessionEngine.dispatch({
      agentSessionId: "session-1",
      commandId: "settings-1",
      settings: { permissionModeId: "acceptEdits" },
      type: "session/settingsUpdateRequested",
      workspaceId: "workspace-1"
    });
    sessionEngine.dispatch({
      commandId: "settings-1",
      commandType: "session/updateSettings",
      correlationId: "session-1",
      outcome: "timedOut",
      type: "engine/commandResult"
    });
    expect(
      selectEngineSessionSettingsUpdate(
        sessionEngine.getSnapshot(),
        "session-1"
      )?.status
    ).toBe("unknown");

    const data: AgentGUINodeData = {
      agentTargetId: "local:claude-code",
      lastActiveAgentSessionId: null,
      provider: "claude-code"
    };
    const onDataChange = vi.fn();
    const onRememberComposerDefaults = vi.fn();
    const setDraftSettingsBySessionId = vi.fn();
    const draftSettingsBySessionIdRef: {
      current: Record<string, AgentSessionComposerSettings>;
    } = { current: {} };
    const dispatch = vi.spyOn(sessionEngine, "dispatch");
    const activeSettings: AgentSessionComposerSettings = {
      browserUse: true,
      computerUse: true,
      permissionModeId: "dontAsk",
      planMode: false
    };
    const activation = {
      stateFor: vi.fn(() => "inactive" as const)
    } as unknown as ReturnType<typeof useAgentGUIActivation>;
    const rendered = renderHook(() =>
      useAgentGUIComposerSettingsActions({
        activation,
        activeCanonicalComposerSettings: activeSettings,
        activeConversationIdRef: { current: "session-1" },
        activeEngineActiveTurn: null,
        agentActivityRuntime: {
          getSnapshot: () => ({})
        } as unknown as AgentActivityRuntime,
        composerSupportPermissionModeChangeDeferred: false,
        dataRef: { current: data },
        defaultReasoningEffort: null,
        draftSettingsBySessionIdRef,
        loadDraftComposerOptions: vi.fn(),
        onDataChangeRef: { current: onDataChange },
        onRememberComposerDefaultsRef: {
          current: onRememberComposerDefaults
        },
        onShowMessageRef: { current: vi.fn() },
        selectedComposerTargetDataRef: {
          current: {
            agentTargetId: "local:claude-code",
            data,
            provider: "claude-code",
            targetId: "local:claude-code"
          }
        },
        sessionEngine,
        setDraftSettingsBySessionId,
        updateComposerSettingsRef: { current: vi.fn() },
        workspaceId: "workspace-1"
      })
    );

    act(() => {
      rendered.result.current.updateComposerSettings({
        permissionModeId: "acceptEdits"
      });
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "session-1",
        retry: true,
        settings: { permissionModeId: "acceptEdits" },
        type: "session/settingsUpdateRequested"
      })
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onRememberComposerDefaults).toHaveBeenCalledWith({
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      defaults: { permissionModeId: "acceptEdits" }
    });
    expect(
      draftSettingsBySessionIdRef.current[
        "__agent_gui_node_defaults__:target:local:claude-code"
      ]
    ).toMatchObject({ permissionModeId: "acceptEdits" });
    expect(setDraftSettingsBySessionId).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const updateNode = onDataChange.mock.calls[0]?.[0] as
      | ((current: AgentGUINodeData) => AgentGUINodeData)
      | undefined;
    expect(updateNode?.(data)).toMatchObject({
      composerOverridesByAgentTargetId: {
        "local:claude-code": { permissionModeId: "acceptEdits" }
      }
    });
  });
});
