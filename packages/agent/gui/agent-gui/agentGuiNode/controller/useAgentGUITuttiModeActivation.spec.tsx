import { act, renderHook } from "@testing-library/react";
import {
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  selectEngineSession,
  type EngineExternalCommand
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import {
  resolveAgentGUITuttiModeDraftKey,
  useAgentGUITuttiModeActivation
} from "./useAgentGUITuttiModeActivation";

describe("useAgentGUITuttiModeActivation", () => {
  it("stores the home slash choice in the engine-owned draft", () => {
    const { engine } = createTestEngine();
    const draftKey = resolveAgentGUITuttiModeDraftKey("node-1");
    const { result } = renderHook(() =>
      useAgentGUITuttiModeActivation({
        activeConversationId: null,
        draftKey,
        engine,
        workspaceId: "workspace-1"
      })
    );

    act(() => result.current.setActive(true));

    expect(result.current.active).toBe(true);
    expect(
      engine.getSnapshot().tuttiModeActivation.draftsByKey[draftKey]?.active
    ).toBe(true);
  });

  it("updates an existing session through the engine command while preserving Plan", () => {
    const { commands, engine } = createTestEngine();
    engine.dispatch({
      session: normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "session-1",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        settings: { planMode: true },
        title: "Session",
        tuttiModeActivation: null,
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      }),
      type: "session/upserted"
    });
    const { result } = renderHook(() =>
      useAgentGUITuttiModeActivation({
        activeConversationId: "session-1",
        draftKey: resolveAgentGUITuttiModeDraftKey("node-1"),
        engine,
        workspaceId: "workspace-1"
      })
    );

    act(() => result.current.setActive(true));

    expect(result.current.active).toBe(true);
    expect(result.current.updatePending).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      agentSessionId: "session-1",
      source: "slash_command",
      status: "active",
      type: "tuttiMode/update",
      workspaceId: "workspace-1"
    });
    expect(
      selectEngineSession(engine.getSnapshot(), "session-1")?.settings.planMode
    ).toBe(true);
  });

  it("surfaces a failed update and retries the original activation intent", () => {
    const { commands, engine } = createTestEngine();
    engine.dispatch({
      session: normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "session-1",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        settings: {},
        title: "Session",
        tuttiModeActivation: null,
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      }),
      type: "session/upserted"
    });
    const { result } = renderHook(() =>
      useAgentGUITuttiModeActivation({
        activeConversationId: "session-1",
        draftKey: resolveAgentGUITuttiModeDraftKey("node-1"),
        engine,
        workspaceId: "workspace-1"
      })
    );

    act(() => result.current.setActive(true));
    const firstCommand = commands[0];
    expect(firstCommand?.type).toBe("tuttiMode/update");
    if (!firstCommand || firstCommand.type !== "tuttiMode/update") {
      throw new Error("expected Tutti mode update command");
    }
    act(() => {
      engine.dispatch({
        commandId: firstCommand.commandId,
        commandType: "tuttiMode/update",
        errorCode: "transport_failed",
        errorMessage: "network unavailable",
        outcome: "failed",
        type: "engine/commandResult"
      });
    });

    expect(result.current.active).toBe(false);
    expect(result.current.updateStatus).toBe("failed");
    expect(result.current.errorMessage).toBe("network unavailable");

    act(() => result.current.retry());

    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatchObject({
      source: "slash_command",
      status: "active",
      type: "tuttiMode/update"
    });
  });

  it("unblocks retry when the update's owned reconcile fails", () => {
    const { commands, engine } = createTestEngine();
    engine.dispatch({
      session: normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "session-1",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        settings: {},
        title: "Session",
        tuttiModeActivation: {
          agentSessionId: "session-1",
          createdAtUnixMs: 1,
          currentRevision: {
            activationId: "activation-1",
            createdAtUnixMs: 1,
            revision: 1,
            source: "slash_command",
            status: "active"
          },
          id: "activation-1",
          status: "active",
          updatedAtUnixMs: 1,
          workspaceId: "workspace-1"
        },
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      }),
      type: "session/upserted"
    });
    const { result } = renderHook(() =>
      useAgentGUITuttiModeActivation({
        activeConversationId: "session-1",
        draftKey: resolveAgentGUITuttiModeDraftKey("node-1"),
        engine,
        workspaceId: "workspace-1"
      })
    );

    act(() => result.current.setActive(false));
    const update = commands[0];
    if (!update || update.type !== "tuttiMode/update") {
      throw new Error("expected Tutti mode update command");
    }
    act(() => {
      engine.dispatch({
        commandId: update.commandId,
        commandType: "tuttiMode/update",
        outcome: "timedOut",
        type: "engine/commandResult"
      });
    });

    expect(result.current.updateStatus).toBe("uncertain");
    expect(result.current.updatePending).toBe(true);
    const reconcile = commands[1];
    if (!reconcile || reconcile.type !== "session/reconcile") {
      throw new Error("expected owned session reconcile command");
    }
    act(() => {
      engine.dispatch({
        commandId: reconcile.commandId,
        commandType: "session/reconcile",
        errorMessage: "reconcile failed",
        outcome: "failed",
        type: "engine/commandResult"
      });
    });

    expect(result.current.updateStatus).toBe("failed");
    expect(result.current.updatePending).toBe(false);
    expect(result.current.active).toBe(true);

    act(() => result.current.retry());

    expect(commands[2]).toMatchObject({
      source: "badge_remove",
      status: "inactive",
      type: "tuttiMode/update"
    });
  });
});

function createTestEngine() {
  const commands: EngineExternalCommand[] = [];
  const execute = vi.fn((command: EngineExternalCommand) => {
    commands.push(command);
    return new Promise<never>(() => {});
  });
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: { execute },
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler: { schedule: () => ({ cancel() {} }) }
  });
  return { commands, engine };
}
