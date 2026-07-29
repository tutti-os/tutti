import type {
  AgentActivitySendInput,
  AgentActivitySession,
  AgentSessionActivateEffectInput,
  AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { createWorkspaceActivityEffectPort } from "./workspaceActivityEngineCommandPort";

describe("createWorkspaceActivityEffectPort", () => {
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
      content: [{ text: "hello", type: "text" }],
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
        engine: {} as AgentSessionEngine,
        loadComposerOptions() {},
        mapSession(): AgentActivitySession {
          throw new Error("unexpected Session mapping");
        },
        mapSessionDetail() {
          throw new Error("unexpected detail mapping");
        },
        async reconcileSession() {},
        async reconcileWorkspace() {}
      })).sendInput(input, { signal: controller.signal })
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
        engine: {} as AgentSessionEngine,
        loadComposerOptions() {},
        mapSession(): AgentActivitySession {
          throw new Error("unexpected Session mapping");
        },
        mapSessionDetail() {
          throw new Error("unexpected detail mapping");
        },
        async reconcileSession() {},
        async reconcileWorkspace() {}
      })).activateSession(input)
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

  test("forwards cancellation to an existing-session activation read", async () => {
    const controller = new AbortController();
    const stopAfterCapture = new Error("stop after detail request capture");
    const getWorkspaceAgentSession = jest
      .fn()
      .mockRejectedValue(stopAfterCapture);

    await expect(
      createWorkspaceActivityEffectPort(() => ({
        client: { getWorkspaceAgentSession } as unknown as TuttidClient,
        engine: {} as AgentSessionEngine,
        loadComposerOptions() {},
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
          agentSessionId: "session-1",
          mode: "existing",
          visible: true,
          workspaceId: "workspace-1"
        },
        { signal: controller.signal }
      )
    ).rejects.toBe(stopAfterCapture);

    expect(getWorkspaceAgentSession).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      undefined,
      { signal: controller.signal }
    );
  });

  test("keeps mobile settings projection and composer refresh in the host", async () => {
    const dispatch = jest.fn();
    const loadComposerOptions = jest.fn();
    const updateWorkspaceAgentSessionSettings = jest.fn().mockResolvedValue({});
    const activitySession = {
      agentSessionId: "session-1",
      agentTargetId: "target-1",
      workspaceId: "workspace-1"
    } as AgentActivitySession;
    const controller = new AbortController();
    const engine = {
      dispatch,
      getSnapshot: () => ({
        composerOptions: {
          optionsByTargetKey: {
            "target-1": {
              behavior: { refreshModelOptionsAfterSettings: true }
            }
          }
        }
      })
    } as unknown as AgentSessionEngine;

    const result = await createWorkspaceActivityEffectPort(() => ({
      client: {
        updateWorkspaceAgentSessionSettings
      } as unknown as TuttidClient,
      engine,
      loadComposerOptions,
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
        settings: { model: "model-1" },
        workspaceId: "workspace-1"
      },
      { signal: controller.signal }
    );

    expect(updateWorkspaceAgentSessionSettings).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      { model: "model-1" },
      { signal: controller.signal }
    );
    expect(dispatch).toHaveBeenCalledWith({
      session: activitySession,
      type: "session/upserted"
    });
    expect(loadComposerOptions).toHaveBeenCalledWith({ force: true });
    expect(result).toEqual({ session: activitySession });
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
      engine: {} as AgentSessionEngine,
      loadComposerOptions() {},
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
      { signal: controller.signal }
    );
    await port.respondToInteraction(
      {
        agentSessionId: "session-1",
        requestId: "request-1",
        turnId: "turn-1",
        workspaceId: "workspace-1"
      },
      { signal: controller.signal }
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
});
