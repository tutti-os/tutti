import type {
  AgentActivityGoalControlResult,
  AgentActivitySendInput,
  AgentActivitySession,
  AgentActivitySessionDetailSnapshot,
  AgentActivitySessionSettings,
  AgentSessionActivateEffectInput,
  TurnEditRetryCommand,
  TurnRecoverEditRetryCommand
} from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import {
  createWorkspaceActivityEffectPort,
  executeWorkspaceActivityExtensionCommand
} from "./workspaceActivityEngineCommandPort";

function unexpectedGoalControlMapping(): never {
  throw new Error("unexpected Goal Control mapping");
}

function engineEffectOptions(signal?: AbortSignal) {
  return { commandId: "command-1", origin: "engine" as const, signal };
}

describe("createWorkspaceActivityEffectPort", () => {
  test("filters unsupported settings from composer options requests", async () => {
    const stopAfterCapture = new Error("stop after composer request capture");
    const getAgentProviderComposerOptions = jest
      .fn()
      .mockRejectedValue(stopAfterCapture);
    const settings: AgentActivitySessionSettings = {
      browserUse: false,
      computerUse: false,
      model: "gpt-5"
    };
    await expect(
      executeWorkspaceActivityExtensionCommand(
        {
          client: {
            getAgentProviderComposerOptions
          } as unknown as TuttidClient,
          mapGoalControlResult: unexpectedGoalControlMapping,
          mapSession(): AgentActivitySession {
            throw new Error("unexpected Session mapping");
          },
          mapSessionDetail() {
            throw new Error("unexpected detail mapping");
          },
          async reconcileSession() {},
          async reconcileWorkspace() {}
        },
        {
          commandId: "composer-1",
          correlationId: "target-1",
          provider: "codex",
          settings,
          targetKey: "target-1",
          type: "composerOptions/load",
          workspaceId: "workspace-1"
        }
      )
    ).rejects.toBe(stopAfterCapture);

    expect(getAgentProviderComposerOptions).toHaveBeenCalledWith(
      "codex",
      {
        agentTargetId: "target-1",
        locale: expect.any(String),
        settings: { browserUse: false, model: "gpt-5" },
        workspaceId: "workspace-1"
      },
      { signal: undefined }
    );
  });

  test("explicitly rejects edit-retry commands that Mobile does not support", async () => {
    const context = {
      client: {} as TuttidClient,
      loadComposerOptions() {},
      mapGoalControlResult: unexpectedGoalControlMapping,
      mapSession(): AgentActivitySession {
        throw new Error("unexpected Session mapping");
      },
      mapSessionDetail() {
        throw new Error("unexpected detail mapping");
      },
      async reconcileSession() {},
      async reconcileWorkspace() {}
    };
    const commands: readonly (
      | TurnEditRetryCommand
      | TurnRecoverEditRetryCommand
    )[] = [
      {
        agentSessionId: "session-1",
        clientOperationId: "operation-1",
        commandId: "command-1",
        editedText: "edited prompt",
        expectedHistoryRevision: 1,
        turnId: "turn-1",
        type: "turn/editRetry",
        workspaceId: "workspace-1"
      },
      {
        action: "reconcile",
        agentSessionId: "session-1",
        commandId: "command-2",
        operationId: "operation-1",
        type: "turn/recoverEditRetry",
        workspaceId: "workspace-1"
      }
    ];

    for (const command of commands) {
      await expect(
        executeWorkspaceActivityExtensionCommand(context, command)
      ).rejects.toThrow(`unsupported mobile agent command: ${command.type}`);
    }
  });

  test("preserves every prompt semantic in the mobile transport request", async () => {
    const requests: Record<string, unknown>[] = [];
    const requestOptions: unknown[] = [];
    const sendFailure = new Error("stop after request capture");
    const controller = new AbortController();
    const client = {
      async sendWorkspaceAgentSessionInput(
        _workspaceId: string,
        _agentSessionId: string,
        request: Record<string, unknown>,
        options?: unknown
      ) {
        requests.push(request);
        requestOptions.push(options);
        throw sendFailure;
      }
    } as unknown as TuttidClient;
    const input: AgentActivitySendInput = {
      agentSessionId: "session-1",
      capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
      clientSubmitId: "submit-1",
      content: [
        {
          hostPath: "/tmp/local-only.txt",
          text: "hello",
          type: "text",
          uploadStatus: "uploaded"
        }
      ],
      displayPrompt: "/computer hello",
      guidance: true,
      submitDiagnostics: {
        blockCount: 1,
        source: "mobile-test",
        submittedAtUnixMs: 10
      },
      workspaceId: "workspace-1"
    };

    await expect(
      createWorkspaceActivityEffectPort(() => ({
        client,
        loadComposerOptions() {},
        mapGoalControlResult: unexpectedGoalControlMapping,
        mapSession(): AgentActivitySession {
          throw new Error("unexpected Session mapping");
        },
        mapSessionDetail() {
          throw new Error("unexpected detail mapping");
        },
        async reconcileSession() {},
        async reconcileWorkspace() {}
      })).sendInput(input, engineEffectOptions(controller.signal))
    ).rejects.toBe(sendFailure);

    expect(requests).toEqual([
      {
        capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
        clientSubmitId: "submit-1",
        content: [{ text: "hello", type: "text" }],
        displayPrompt: "/computer hello",
        guidance: true,
        submitDiagnostics: {
          blockCount: 1,
          source: "mobile-test",
          submittedAtUnixMs: 10
        }
      }
    ]);
    expect(requestOptions).toEqual([{ signal: controller.signal }]);
  });

  test("Goal Control forwards Engine identity and returns the shared mapping", async () => {
    const controller = new AbortController();
    const rawResult = { session: { id: "session-1" } } as Awaited<
      ReturnType<TuttidClient["goalControlWorkspaceAgentSession"]>
    >;
    const mappedResult = {
      goal: { objective: "ship it", status: "active" },
      operationId: "operation-1",
      session: {
        agentSessionId: "session-1",
        workspaceId: "workspace-1"
      } as AgentActivitySession
    } satisfies AgentActivityGoalControlResult;
    const goalControlWorkspaceAgentSession = jest
      .fn()
      .mockResolvedValue(rawResult);
    const mapGoalControlResult = jest.fn().mockReturnValue(mappedResult);
    const port = createWorkspaceActivityEffectPort(() => ({
      client: {
        goalControlWorkspaceAgentSession
      } as unknown as TuttidClient,
      mapGoalControlResult,
      mapSession(): AgentActivitySession {
        throw new Error("unexpected Session mapping");
      },
      mapSessionDetail() {
        throw new Error("unexpected detail mapping");
      },
      async reconcileSession() {},
      async reconcileWorkspace() {}
    }));

    const result = await port.controlGoal?.(
      {
        action: "set",
        agentSessionId: "session-1",
        clientSubmitId: "goal-submit-1",
        objective: "ship it",
        workspaceId: "workspace-1"
      },
      engineEffectOptions(controller.signal)
    );

    expect(goalControlWorkspaceAgentSession).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      {
        action: "set",
        clientSubmitId: "goal-submit-1",
        objective: "ship it"
      },
      { signal: controller.signal }
    );
    expect(mapGoalControlResult).toHaveBeenCalledWith(rawResult);
    expect(result).toBe(mappedResult);
  });

  test("preserves activation semantics without inventing computerUse", async () => {
    let createRequest: Record<string, unknown> | null = null;
    const stopAfterCapture = new Error("stop after create request capture");
    const client = {
      async createWorkspaceAgentSession(
        _workspaceId: string,
        request: Record<string, unknown>
      ) {
        createRequest = request;
        throw stopAfterCapture;
      }
    } as unknown as TuttidClient;
    const input: AgentSessionActivateEffectInput = {
      activationId: "activation-1",
      agentSessionId: "session-1",
      agentTargetId: "target-1",
      capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
      clientSubmitId: "submit-1",
      initialContent: [{ text: "hello", type: "text" }],
      initialTuttiModeActivation: {
        effect: 80,
        source: "slash_command",
        speed: 60,
        status: "active"
      },
      mode: "new",
      railPlacement: {
        kind: "project",
        projectPath: "/repo",
        sectionKey: "project:/repo",
        version: 1
      },
      settings: { computerUse: false },
      visible: true,
      workspaceId: "workspace-1"
    };

    await expect(
      createWorkspaceActivityEffectPort(() => ({
        client,
        loadComposerOptions() {},
        mapGoalControlResult: unexpectedGoalControlMapping,
        mapSession(): AgentActivitySession {
          throw new Error("unexpected Session mapping");
        },
        mapSessionDetail() {
          throw new Error("unexpected detail mapping");
        },
        async reconcileSession() {},
        async reconcileWorkspace() {}
      })).activateSession(input, engineEffectOptions())
    ).rejects.toBe(stopAfterCapture);

    expect(createRequest).toEqual(
      expect.objectContaining({
        agentSessionId: "session-1",
        agentTargetId: "target-1",
        capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
        clientSubmitId: "submit-1",
        initialTuttiModeActivation: {
          effect: 80,
          source: "slash_command",
          speed: 60,
          status: "active"
        },
        railPlacement: {
          kind: "project",
          projectPath: "/repo",
          sectionKey: "project:/repo",
          version: 1
        }
      })
    );
    expect(createRequest).not.toHaveProperty("computerUse");
  });

  test("uses the typed initial Goal contract without sending command text", async () => {
    let createRequest: Record<string, unknown> | null = null;
    const stopAfterCapture = new Error("stop after create request capture");
    const client = {
      async createWorkspaceAgentSession(
        _workspaceId: string,
        request: Record<string, unknown>
      ) {
        createRequest = request;
        throw stopAfterCapture;
      }
    } as unknown as TuttidClient;

    await expect(
      createWorkspaceActivityEffectPort(() => ({
        client,
        mapGoalControlResult: unexpectedGoalControlMapping,
        mapSession(): AgentActivitySession {
          throw new Error("unexpected Session mapping");
        },
        mapSessionDetail() {
          throw new Error("unexpected detail mapping");
        },
        async reconcileSession() {},
        async reconcileWorkspace() {}
      })).activateSession(
        {
          activationId: "activation-1",
          agentSessionId: "session-1",
          agentTargetId: "target-1",
          clientSubmitId: "goal-submit-1",
          initialContent: [{ text: "/goal ship it", type: "text" }],
          initialGoalControl: { action: "set", objective: "ship it" },
          mode: "new",
          visible: true,
          workspaceId: "workspace-1"
        },
        engineEffectOptions()
      )
    ).rejects.toBe(stopAfterCapture);

    expect(createRequest).toEqual(
      expect.objectContaining({
        clientSubmitId: "goal-submit-1",
        initialContent: [],
        initialGoalControl: { action: "set", objective: "ship it" }
      })
    );
  });

  test("forwards cancellation to an existing-session activation read", async () => {
    const controller = new AbortController();
    const stopAfterCapture = new Error("stop after detail request capture");
    const getWorkspaceAgentSession = jest
      .fn()
      .mockRejectedValue(stopAfterCapture);

    await expect(
      createWorkspaceActivityEffectPort(() => ({
        client: { getWorkspaceAgentSession } as unknown as TuttidClient,
        loadComposerOptions() {},
        mapGoalControlResult: unexpectedGoalControlMapping,
        mapSession(): AgentActivitySession {
          throw new Error("unexpected Session mapping");
        },
        mapSessionDetail() {
          throw new Error("unexpected detail mapping");
        },
        async reconcileSession() {},
        async reconcileWorkspace() {}
      })).activateSession(
        {
          activationId: "activation-1",
          agentSessionId: "session-1",
          mode: "existing",
          visible: true,
          workspaceId: "workspace-1"
        },
        engineEffectOptions(controller.signal)
      )
    ).rejects.toBe(stopAfterCapture);

    expect(getWorkspaceAgentSession).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      undefined,
      { signal: controller.signal }
    );
  });

  test("returns existing-session detail without writing host state", async () => {
    const rawDetail = { session: { id: "session-1" } };
    const activitySession = {
      agentSessionId: "session-1",
      workspaceId: "workspace-1"
    } as AgentActivitySession;
    const mappedDetail: AgentActivitySessionDetailSnapshot = {
      childSessions: [],
      lifecycleCapabilitiesProjected: true,
      projection: "authoritative",
      session: activitySession,
      turns: []
    };
    const getWorkspaceAgentSession = jest.fn().mockResolvedValue(rawDetail);
    const mapSessionDetail = jest.fn().mockReturnValue(mappedDetail);

    const result = await createWorkspaceActivityEffectPort(() => ({
      client: { getWorkspaceAgentSession } as unknown as TuttidClient,
      mapGoalControlResult: unexpectedGoalControlMapping,
      mapSession: () => activitySession,
      mapSessionDetail,
      async reconcileSession() {},
      async reconcileWorkspace() {}
    })).activateSession(
      {
        activationId: "activation-1",
        agentSessionId: "session-1",
        mode: "existing",
        workspaceId: "workspace-1"
      },
      engineEffectOptions()
    );

    expect(mapSessionDetail).toHaveBeenCalledWith("session-1", rawDetail);
    expect(result).toEqual({
      activation: { mode: "existing", status: "already_attached" },
      detail: mappedDetail,
      session: activitySession
    });
  });

  test("returns authoritative settings data without host-owned projection", async () => {
    const updateWorkspaceAgentSessionSettings = jest.fn().mockResolvedValue({});
    const activitySession = {
      agentSessionId: "session-1",
      agentTargetId: "target-1",
      workspaceId: "workspace-1"
    } as AgentActivitySession;
    const controller = new AbortController();
    const result = await createWorkspaceActivityEffectPort(() => ({
      client: {
        updateWorkspaceAgentSessionSettings
      } as unknown as TuttidClient,
      mapGoalControlResult: unexpectedGoalControlMapping,
      mapSession: () => activitySession,
      mapSessionDetail() {
        throw new Error("unexpected detail mapping");
      },
      async reconcileSession() {},
      async reconcileWorkspace() {}
    })).updateSessionSettings(
      {
        agentSessionId: "session-1",
        commandId: "settings-1",
        correlationId: "request-1",
        settings: {
          browserUse: false,
          computerUse: false,
          model: "model-1"
        },
        workspaceId: "workspace-1"
      },
      engineEffectOptions(controller.signal)
    );

    expect(updateWorkspaceAgentSessionSettings).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      { browserUse: false, model: "model-1" },
      { signal: controller.signal }
    );
    expect(result).toEqual({
      agentSessionId: "session-1",
      session: activitySession,
      settings: activitySession.settings
    });
  });

  test("forwards cancellation to cancel and interactive transports", async () => {
    const controller = new AbortController();
    const cancelWorkspaceAgentTurn = jest.fn().mockResolvedValue({
      cancel: { canceled: true, reason: "turn_canceled" }
    });
    const submitWorkspaceAgentInteractive = jest.fn().mockResolvedValue({});
    const activitySession = {
      agentSessionId: "session-1",
      workspaceId: "workspace-1"
    } as AgentActivitySession;
    const port = createWorkspaceActivityEffectPort(() => ({
      client: {
        cancelWorkspaceAgentTurn,
        submitWorkspaceAgentInteractive
      } as unknown as TuttidClient,
      loadComposerOptions() {},
      mapGoalControlResult: unexpectedGoalControlMapping,
      mapSession: () => activitySession,
      mapSessionDetail() {
        throw new Error("unexpected detail mapping");
      },
      async reconcileSession() {},
      async reconcileWorkspace() {}
    }));

    await port.cancelTurn(
      {
        agentSessionId: "session-1",
        turnId: "turn-1",
        workspaceId: "workspace-1"
      },
      engineEffectOptions(controller.signal)
    );
    await port.respondToInteraction(
      {
        agentSessionId: "session-1",
        requestId: "request-1",
        turnId: "turn-1",
        workspaceId: "workspace-1"
      },
      engineEffectOptions(controller.signal)
    );

    expect(cancelWorkspaceAgentTurn).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      "turn-1",
      { signal: controller.signal }
    );
    expect(submitWorkspaceAgentInteractive).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      "request-1",
      {
        action: null,
        optionId: null,
        payload: null,
        turnId: "turn-1"
      },
      { signal: controller.signal }
    );
  });

  test("projects metadata mutations with the Engine cancellation signal", async () => {
    const controller = new AbortController();
    const updateWorkspaceAgentSessionPin = jest.fn().mockResolvedValue({});
    const updateWorkspaceAgentSessionTitle = jest.fn().mockResolvedValue({});
    const deleteWorkspaceAgentSessionsBatch = jest.fn().mockResolvedValue({
      cleanupFailedSessionIds: [],
      removedMessages: 3,
      removedSessionIds: ["session-1", "session-2"],
      removedSessions: 2
    });
    const activitySession = {
      agentSessionId: "session-1",
      workspaceId: "workspace-1"
    } as AgentActivitySession;
    const port = createWorkspaceActivityEffectPort(() => ({
      client: {
        deleteWorkspaceAgentSessionsBatch,
        updateWorkspaceAgentSessionPin,
        updateWorkspaceAgentSessionTitle
      } as unknown as TuttidClient,
      loadComposerOptions() {},
      mapGoalControlResult: unexpectedGoalControlMapping,
      mapSession: () => activitySession,
      mapSessionDetail() {
        throw new Error("unexpected detail mapping");
      },
      async reconcileSession() {},
      async reconcileWorkspace() {}
    }));

    const pinResult = await port.setSessionPinned(
      {
        agentSessionId: "session-1",
        pinned: true,
        workspaceId: "workspace-1"
      },
      engineEffectOptions(controller.signal)
    );
    const renameResult = await port.renameSession(
      {
        agentSessionId: "session-1",
        title: "Renamed session",
        workspaceId: "workspace-1"
      },
      engineEffectOptions(controller.signal)
    );
    const deleteResult = await port.deleteSessions(
      {
        agentSessionIds: ["session-1", "session-2"],
        workspaceId: "workspace-1"
      },
      engineEffectOptions(controller.signal)
    );

    expect(updateWorkspaceAgentSessionPin).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      { pinned: true },
      { signal: controller.signal }
    );
    expect(updateWorkspaceAgentSessionTitle).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      { title: "Renamed session" },
      { signal: controller.signal }
    );
    expect(deleteWorkspaceAgentSessionsBatch).toHaveBeenCalledWith(
      "workspace-1",
      { sessionIds: ["session-1", "session-2"] },
      { signal: controller.signal }
    );
    expect(pinResult).toEqual({ session: activitySession });
    expect(renameResult).toEqual({ session: activitySession });
    expect(deleteResult).toEqual({
      cleanupFailedSessionIds: [],
      removedMessages: 3,
      removedSessionIds: ["session-1", "session-2"],
      removedSessions: 2
    });
  });
});
