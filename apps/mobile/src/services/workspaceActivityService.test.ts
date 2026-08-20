import {
  canonicalInteractionKey,
  selectPendingActivations,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type {
  TuttidClient,
  WorkspaceAgentInteraction,
  WorkspaceAgentEditRetryAvailability,
  WorkspaceAgentSession,
  WorkspaceAgentSessionDetailResponse,
  WorkspaceAgentSessionMessage,
  WorkspaceAgentTurn,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { AgentDirectoryService } from "./agentDirectoryService";
import { ComposerDraftService } from "./composerDraftService";
import { MobileUserProjectDirectoryService } from "./mobileUserProjectDirectoryService";
import type { ClockPort } from "./servicePorts";
import type { AgentLiveDelivery, DeviceLinkPort } from "./servicePorts";
import { WorkspaceActivityService } from "./workspaceActivityService";
import { WorkspaceNavigationService } from "./workspaceNavigationService";

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  lastOpenedAt: null,
  name: "Workspace"
};

const fullSessionDetailProjection = {
  editRetry: createEditRetryAvailability(),
  lifecycleCapabilitiesProjected: true,
  projection: "full"
} as const;

function createEditRetryAvailability(): WorkspaceAgentEditRetryAvailability {
  return {
    availableActions: [],
    eligible: false,
    historyRevision: 0,
    recoveryState: "completed",
    supported: false
  };
}

describe("WorkspaceActivityService", () => {
  test("disposes the conversation Rail it owns", () => {
    const service = createService(
      createClient({ listMessages: emptyMessagePage })
    );
    const disposeRail = jest.spyOn(service.rail, "dispose");

    service.dispose();

    expect(disposeRail).toHaveBeenCalledTimes(1);
  });

  test("projects canonical session identity and authoritative message paging", async () => {
    const messageQueries: Array<Record<string, unknown>> = [];
    const client = createClient({
      listMessages: async (_workspaceId, agentSessionId, query) => {
        messageQueries.push(query);
        const older = "beforeVersion" in query;
        return {
          agentSessionId,
          hasMore: !older,
          latestVersion: 7,
          messages: [
            createMessage(
              older ? "message-older" : "message-latest",
              older ? 3 : 7
            )
          ]
        };
      }
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();

    const initial = service.getSnapshot();
    expect(initial.selectedAgentSessionId).toBe("session-1");
    expect(initial.selectedSession?.userId).toBe("account-user-1");
    expect(
      initial.activity.sessionMessagesById["session-1"]?.map(
        (message) => message.messageId
      )
    ).toEqual(["message-latest"]);
    expect(initial.conversation?.sourceDetail.session.agentSessionId).toBe(
      "session-1"
    );
    expect(initial.conversation?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "message", speaker: "assistant" })
      ])
    );
    expect(messageQueries[0]).toEqual({ limit: 100, order: "desc" });

    await service.loadOlderMessages();
    await flushAsyncWork();

    expect(messageQueries[1]).toEqual({
      beforeVersion: 7,
      limit: 100,
      order: "desc"
    });
    expect(
      service
        .getSnapshot()
        .activity.sessionMessagesById["session-1"]?.map(
          (message) => message.messageId
        )
    ).toEqual(["message-older", "message-latest"]);

    service.dispose();
  });

  test("projects a conversation project from its rail key instead of cwd or Rail membership", async () => {
    const expectedProject = createUserProject();
    const wrongProject = createUserProject({
      id: "project-2",
      label: "wrong",
      path: "/workspace/wrong",
      sectionKey: "project:wrong"
    });
    const session = {
      ...createSession(),
      cwd: "/workspace/wrong/.tutti/agent/worktrees/session-1",
      railSectionKey: expectedProject.sectionKey
    };
    const service = createService(
      createClient({
        listMessages: emptyMessagePage,
        listSections: async () => ({
          pinned: { hasMore: false, sessions: [], totalCount: 0 },
          sections: [
            {
              hasMore: false,
              kind: "project",
              sectionKey: wrongProject.sectionKey,
              sessions: [session],
              totalCount: 1,
              userProject: wrongProject
            },
            {
              hasMore: false,
              kind: "project",
              sectionKey: expectedProject.sectionKey,
              sessions: [],
              totalCount: 0,
              userProject: expectedProject
            }
          ],
          workspaceId: workspace.id
        }),
        projects: [expectedProject, wrongProject],
        session: () => session
      })
    );

    await service.start();
    await flushAsyncWork();

    expect(
      service
        .getSnapshot()
        .activityConversations.find(
          (conversation) => conversation.id === session.id
        )?.project
    ).toMatchObject({
      id: expectedProject.id,
      sectionKey: expectedProject.sectionKey
    });

    service.dispose();
  });

  test("projects processing before the active Turn receives its first message", async () => {
    const activeSession = createSession();
    activeSession.activeTurnId = "turn-1";
    activeSession.activeTurn = {
      agentSessionId: activeSession.id,
      completedCommand: null,
      error: null,
      fileChanges: null,
      origin: "user_prompt",
      outcome: null,
      phase: "running",
      providerForkBindingAvailable: false,
      providerForkBindingState: "unavailable",
      settledAtUnixMs: null,
      startedAtUnixMs: 2,
      turnId: "turn-1",
      updatedAtUnixMs: 3
    };
    const service = createService(
      createClient({
        listMessages: emptyMessagePage,
        session: () => activeSession
      })
    );

    await service.start();
    await flushAsyncWork();

    expect(
      service
        .getSnapshot()
        .conversation?.rows.some((row) => row.kind === "processing")
    ).toBe(true);
    expect(
      service.getSnapshot().activity.sessionMessagesById["session-1"] ?? []
    ).toEqual([]);

    service.dispose();
  });

  test("routes an existing-session submission through the engine command port", async () => {
    const sends: Array<{
      agentSessionId: string;
      input: Record<string, unknown>;
      workspaceId: string;
    }> = [];
    const client = createClient({
      listMessages: async (_workspaceId, agentSessionId) => ({
        agentSessionId,
        hasMore: false,
        latestVersion: 0,
        messages: []
      }),
      send: async (workspaceId, agentSessionId, input) => {
        sends.push({ agentSessionId, input, workspaceId });
        return new Promise<never>(() => undefined);
      }
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    const submitPrompt = jest.spyOn(engine, "submitPrompt");
    service.setDraft("continue");
    await service.send();
    await flushAsyncWork();

    expect(submitPrompt).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      clientSubmitId: expect.any(String),
      content: [{ text: "continue", type: "text" }],
      routing: "auto",
      runtimeContent: [{ text: "continue", type: "text" }],
      submitDiagnostics: {
        blockCount: 1,
        promptLength: 8,
        source: "mobile",
        submittedAtUnixMs: expect.any(Number)
      }
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      agentSessionId: "session-1",
      input: {
        content: [{ text: "continue", type: "text" }]
      },
      workspaceId: "workspace-1"
    });
    expect(service.getSnapshot().draft).toBe("");
    expect(service.getSnapshot().sending).toBe(true);

    service.dispose();
  });

  test("routes an existing-session Goal command through the shared Engine operation", async () => {
    const goalResult = {
      goal: { objective: "ship it", status: "active" as const },
      operationId: "goal-operation-1",
      session: {
        ...createSession(),
        goal: { objective: "ship it", status: "active" as const },
        updatedAtUnixMs: 2
      },
      state: {
        desired: { objective: "ship it", status: "active" as const },
        lastEvidence: { source: "mobile-test" },
        observed: { objective: "ship it", status: "active" as const },
        pendingOperationId: null,
        revision: 1,
        syncStatus: "synced" as const,
        tombstoned: false,
        updatedAtUnixMs: 2
      }
    };
    let resolveGoalControl!: (result: typeof goalResult) => void;
    const goalControl = jest.fn(
      () =>
        new Promise<typeof goalResult>((resolve) => {
          resolveGoalControl = resolve;
        })
    );
    const send = jest.fn(() => new Promise<never>(() => undefined));
    const service = createService(
      createClient({
        goalControl,
        listMessages: emptyMessagePage,
        send
      })
    );

    await service.start();
    await flushAsyncWork();
    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    const controlGoal = jest.spyOn(engine, "controlGoal");
    service.setDraft("/goal ship it");

    await service.send();

    expect(controlGoal).toHaveBeenCalledWith({
      action: "set",
      agentSessionId: "session-1",
      clientSubmitId: expect.any(String),
      objective: "ship it"
    });
    expect(goalControl).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      {
        action: "set",
        clientSubmitId: expect.any(String),
        objective: "ship it"
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(send).not.toHaveBeenCalled();
    expect(service.getSnapshot().draft).toBe("/goal ship it");
    expect(service.getSnapshot().sending).toBe(true);

    resolveGoalControl(goalResult);
    await flushAsyncWork();

    expect(service.getSnapshot().draft).toBe("");
    expect(service.getSnapshot().sending).toBe(false);

    service.dispose();
  });

  test("reuses the Engine Goal identity for an outcome-unknown alias retry", async () => {
    const goalControl = jest
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({
        goal: null,
        operationId: "goal-operation-1",
        session: { ...createSession(), goal: null, updatedAtUnixMs: 2 },
        state: {
          desired: null,
          lastEvidence: { source: "mobile-test" },
          observed: null,
          pendingOperationId: null,
          revision: 1,
          syncStatus: "synced",
          tombstoned: true,
          updatedAtUnixMs: 2
        }
      });
    const service = createService(
      createClient({ goalControl, listMessages: emptyMessagePage })
    );

    await service.start();
    await flushAsyncWork();
    service.setDraft("/goal reset");
    await service.send();
    await flushAsyncWork();

    expect(service.getSnapshot().draft).toBe("/goal reset");
    expect(service.getSnapshot().ambiguousSubmission).toBe(true);
    const firstClientSubmitId = goalControl.mock.calls[0]?.[2].clientSubmitId;

    service.setDraft("/goal clear");
    await service.send();
    await flushAsyncWork();

    expect(goalControl).toHaveBeenCalledTimes(2);
    expect(goalControl.mock.calls[1]?.[2].clientSubmitId).toBe(
      firstClientSubmitId
    );
    expect(service.getSnapshot().draft).toBe("");
    expect(service.getSnapshot().ambiguousSubmission).toBe(false);

    service.dispose();
  });

  test("uses a new Goal identity after a definitive rejection", async () => {
    const goalControl = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("invalid goal"), { code: "invalid_request" })
      )
      .mockResolvedValueOnce({
        goal: null,
        operationId: "goal-operation-2",
        session: { ...createSession(), goal: null, updatedAtUnixMs: 2 },
        state: {
          desired: null,
          lastEvidence: { source: "mobile-test" },
          observed: null,
          pendingOperationId: null,
          revision: 1,
          syncStatus: "synced",
          tombstoned: true,
          updatedAtUnixMs: 2
        }
      });
    const service = createService(
      createClient({ goalControl, listMessages: emptyMessagePage })
    );

    await service.start();
    await flushAsyncWork();
    service.setDraft("/goal clear");
    await service.send();
    await flushAsyncWork();

    expect(service.getSnapshot().draft).toBe("/goal clear");
    expect(service.getSnapshot().ambiguousSubmission).toBe(false);
    const failedClientSubmitId = goalControl.mock.calls[0]?.[2].clientSubmitId;

    await service.send();
    await flushAsyncWork();

    expect(goalControl).toHaveBeenCalledTimes(2);
    expect(goalControl.mock.calls[1]?.[2].clientSubmitId).not.toBe(
      failedClientSubmitId
    );
    expect(service.getSnapshot().draft).toBe("");

    service.dispose();
  });

  test("routes a new-session Goal command through typed activation without a Turn", async () => {
    let createInput:
      | Parameters<TuttidClient["createWorkspaceAgentSession"]>[1]
      | null = null;
    const service = createService(
      createClient({
        composerOptions: async () => ({
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: true,
            planModeExclusiveWithPermissionMode: false,
            prewarmDraftSession: false,
            refreshModelOptionsAfterSettings: false
          },
          effectiveSettings: {},
          provider: "codex"
        }),
        create: async (_workspaceId, input) => {
          createInput = input;
          return {
            ...createSession(),
            agentTargetId: "target-1",
            goal: { objective: "ship it", status: "active" },
            id: input.agentSessionId
          };
        },
        listMessages: emptyMessagePage,
        session: () => null,
        targets: [createTarget()]
      })
    );

    await service.start();
    await flushAsyncWork();
    service.startCreating();
    await flushAsyncWork();
    service.setDraft("/goal ship it");

    await service.send();
    await flushAsyncWork();

    expect(createInput).toMatchObject({
      initialContent: [],
      initialGoalControl: { action: "set", objective: "ship it" }
    });
    expect(service.getSnapshot().sending).toBe(false);
    service.dispose();
  });

  test("preserves the Mobile draft when the Engine rejects submission admission", async () => {
    const service = createService(
      createClient({ listMessages: emptyMessagePage })
    );

    await service.start();
    await flushAsyncWork();
    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    jest.spyOn(engine, "submitPrompt").mockReturnValue({
      accepted: false,
      queued: false
    });
    service.setDraft("continue");

    await service.send();

    expect(service.getSnapshot().draft).toBe("continue");
    service.dispose();
  });

  test("stops presenting a new-session activation as sending after attach", async () => {
    let createCalls = 0;
    const client = createClient({
      composerOptions: async () => ({
        behavior: {
          collapseModelOptionsToLatest: false,
          modelOptionsAuthoritative: true,
          planModeExclusiveWithPermissionMode: false,
          prewarmDraftSession: false,
          refreshModelOptionsAfterSettings: false
        },
        effectiveSettings: {},
        provider: "codex"
      }),
      create: async (_workspaceId, input) => {
        createCalls += 1;
        return {
          ...createSession(),
          agentTargetId: "target-1",
          id: input.agentSessionId
        };
      },
      listMessages: emptyMessagePage,
      session: () => null,
      targets: [createTarget()]
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    const activateSession = jest.spyOn(engine, "activateSession");
    service.startCreating();
    await flushAsyncWork();
    service.setDraft("start");
    await service.send();
    await flushAsyncWork();

    expect(activateSession).toHaveBeenCalledTimes(1);
    expect(activateSession).toHaveBeenCalledWith({
      agentSessionId: expect.any(String),
      agentTargetId: "target-1",
      clientSubmitId: expect.any(String),
      initialContent: [{ text: "start", type: "text" }],
      initialTurnExpected: true,
      mode: "new",
      railPlacement: {
        kind: "conversations",
        sectionKey: "conversations",
        version: 1
      },
      requestId: expect.any(String),
      runtimeContent: [{ text: "start", type: "text" }],
      settings: {},
      submitDiagnostics: {
        blockCount: 1,
        promptLength: 5,
        source: "mobile",
        submittedAtUnixMs: expect.any(Number)
      },
      visible: true
    });
    const activationInput = activateSession.mock.calls[0]?.[0];
    expect(activationInput?.mode).toBe("new");
    if (activationInput?.mode === "new") {
      expect(activationInput.requestId).toBe(activationInput.clientSubmitId);
    }
    expect(createCalls).toBe(1);
    expect(service.getSnapshot().selectedAgentSessionId).not.toBeNull();
    expect(service.getSnapshot().sending).toBe(false);

    service.dispose();
  });

  test("uses the selected project for composer options and new-session placement", async () => {
    const composerRequests: Array<Record<string, unknown>> = [];
    let createInput:
      | Parameters<TuttidClient["createWorkspaceAgentSession"]>[1]
      | null = null;
    const service = createService(
      createClient({
        composerOptions: async (_provider, request) => {
          composerRequests.push(request ?? {});
          return {
            behavior: {
              collapseModelOptionsToLatest: false,
              modelOptionsAuthoritative: true,
              planModeExclusiveWithPermissionMode: false,
              prewarmDraftSession: false,
              refreshModelOptionsAfterSettings: false
            },
            effectiveSettings: {},
            provider: "codex"
          };
        },
        create: async (_workspaceId, input) => {
          createInput = input;
          return {
            ...createSession(),
            agentTargetId: "target-1",
            cwd: "/workspace/tutti",
            id: input.agentSessionId,
            railSectionKey: "project:tutti"
          };
        },
        listMessages: emptyMessagePage,
        projects: [createUserProject()],
        session: () => null,
        targets: [createTarget()]
      })
    );

    await service.start();
    await flushAsyncWork();
    service.startCreating();
    service.selectProject("/workspace/tutti");
    await flushAsyncWork();
    service.setDraft("start in project");
    await service.send();
    await flushAsyncWork();

    expect(composerRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cwd: "/workspace/tutti" })
      ])
    );
    expect(createInput).toMatchObject({
      cwd: "/workspace/tutti",
      railPlacement: {
        kind: "project",
        projectPath: "/workspace/tutti",
        sectionKey: "project:tutti",
        version: 1
      }
    });
    expect(service.getSnapshot().selectedProjectPath).toBeNull();
    service.dispose();
  });

  test("waits for the selected directory composer options before creating", async () => {
    let resolveComposerOptions!: (value: Record<string, unknown>) => void;
    const composerOptions = new Promise<Record<string, unknown>>((resolve) => {
      resolveComposerOptions = resolve;
    });
    const create = jest.fn(async (_workspaceId, input) => ({
      ...createSession(),
      agentTargetId: "target-1",
      id: input.agentSessionId
    }));
    const service = createService(
      createClient({
        composerOptions: async () => composerOptions,
        create,
        listMessages: emptyMessagePage,
        projects: [createUserProject()],
        session: () => null,
        targets: [createTarget()]
      })
    );

    await service.start();
    service.startCreating();
    service.selectProject("/workspace/tutti");
    service.setDraft("start after options");
    await service.send();

    expect(create).not.toHaveBeenCalled();

    resolveComposerOptions({
      behavior: {
        collapseModelOptionsToLatest: false,
        modelOptionsAuthoritative: true,
        planModeExclusiveWithPermissionMode: false,
        prewarmDraftSession: false,
        refreshModelOptionsAfterSettings: false
      },
      effectiveSettings: { model: "directory-default" },
      provider: "codex"
    });
    await flushAsyncWork();
    await service.send();
    await flushAsyncWork();

    expect(create).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        cwd: "/workspace/tutti",
        model: null
      }),
      expect.any(Object)
    );
    service.dispose();
  });

  test("locks the creation context while activation delivery is ambiguous", async () => {
    const clock = new RecordingClock();
    const firstProject = createUserProject();
    const secondProject = createUserProject({
      id: "project-2",
      label: "other",
      path: "/workspace/other",
      sectionKey: "project:other"
    });
    const service = createService(
      createClient({
        composerOptions: async () => ({
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: true,
            planModeExclusiveWithPermissionMode: false,
            prewarmDraftSession: false,
            refreshModelOptionsAfterSettings: false
          },
          effectiveSettings: {},
          provider: "codex"
        }),
        create: () => new Promise<WorkspaceAgentSession>(() => undefined),
        listMessages: emptyMessagePage,
        projects: [firstProject, secondProject],
        session: () => null,
        targets: [createTarget()]
      }),
      { clock }
    );

    await service.start();
    await flushAsyncWork();
    service.startCreating();
    service.selectProject(firstProject.path);
    await flushAsyncWork();
    service.setDraft("start");
    await service.send();
    clock.runNext(90_000);
    await flushAsyncWork();

    expect(service.getSnapshot().ambiguousSubmission).toBe(true);
    service.selectProject(secondProject.path);
    expect(service.getSnapshot().selectedProjectPath).toBe(firstProject.path);
    service.dispose();
  });

  test("preserves an explicit Agent when creation is started again", async () => {
    const service = createService(
      createClient({
        listMessages: emptyMessagePage,
        session: () => null,
        targets: [createTarget(), createTarget({ id: "target-2" })]
      })
    );

    await service.start();
    service.startCreating();
    service.selectTarget("target-1");
    service.startCreating();

    expect(service.getSnapshot().selectedAgentTargetId).toBe("target-1");
    service.dispose();
  });

  test("preserves the new-Session draft when activation admission is rejected", async () => {
    const service = createService(
      createClient({
        composerOptions: async () => ({
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: true,
            planModeExclusiveWithPermissionMode: false,
            prewarmDraftSession: false,
            refreshModelOptionsAfterSettings: false
          },
          effectiveSettings: {},
          provider: "codex"
        }),
        listMessages: emptyMessagePage,
        session: () => null,
        targets: [createTarget()]
      })
    );

    await service.start();
    await flushAsyncWork();
    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    jest.spyOn(engine, "activateSession").mockReturnValue(false);
    service.startCreating();
    service.setDraft("start");

    await service.send();

    expect(service.getSnapshot().draft).toBe("start");
    expect(service.getSnapshot().sending).toBe(false);
    service.dispose();
  });

  test("restores a canceled activation draft and uses a fresh submission identity", async () => {
    const createInputs: Array<
      Parameters<TuttidClient["createWorkspaceAgentSession"]>[1]
    > = [];
    const service = createService(
      createClient({
        composerOptions: async () => ({
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: true,
            planModeExclusiveWithPermissionMode: false,
            prewarmDraftSession: false,
            refreshModelOptionsAfterSettings: false
          },
          effectiveSettings: {},
          provider: "codex"
        }),
        create: (_workspaceId, input) => {
          createInputs.push(input);
          return new Promise<WorkspaceAgentSession>(() => undefined);
        },
        listMessages: emptyMessagePage,
        session: () => null,
        targets: [createTarget()]
      })
    );

    await service.start();
    await flushAsyncWork();
    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    service.startCreating();
    await flushAsyncWork();
    service.setDraft("start");

    await service.send();
    const activation = selectPendingActivations(engine.getSnapshot()).find(
      (candidate) => candidate.mode === "new"
    );
    expect(activation).toBeDefined();
    expect(service.getSnapshot().draft).toBe("");

    engine.stopSession({
      agentSessionId: activation!.agentSessionId
    });
    await flushAsyncWork();

    expect(service.getSnapshot().draft).toBe("start");
    expect(service.getSnapshot().ambiguousSubmission).toBe(false);

    await service.send();

    expect(createInputs).toHaveLength(2);
    expect(createInputs[1]?.clientSubmitId).not.toBe(
      createInputs[0]?.clientSubmitId
    );
    service.dispose();
  });

  test("loads target-scoped composer options through the engine and presents daemon defaults", async () => {
    const composerRequests: Array<Record<string, unknown>> = [];
    const client = createClient({
      composerOptions: async (_provider, request) => {
        composerRequests.push(request ?? {});
        return {
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: true,
            planModeExclusiveWithPermissionMode: false,
            prewarmDraftSession: false,
            refreshModelOptionsAfterSettings: false
          },
          effectiveSettings: { model: "gpt-5" },
          modelConfig: {
            configurable: true,
            options: [{ label: "GPT-5", value: "gpt-5" }]
          },
          provider: "codex"
        };
      },
      listMessages: emptyMessagePage,
      session: () => ({ ...createSession(), agentTargetId: "target-1" }),
      targets: [createTarget()]
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();

    expect(composerRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentTargetId: "target-1",
          locale: "en",
          workspaceId: "workspace-1"
        })
      ])
    );
    expect(service.getSnapshot().composerOptions?.models).toEqual([
      { label: "GPT-5", value: "gpt-5" }
    ]);
    expect(service.getSnapshot().composerSettings.model).toBe("gpt-5");
    expect(service.getSnapshot().composerSettingsSupport.model).toBe(true);

    service.dispose();
  });

  test("routes existing-session composer settings through the engine command", async () => {
    const settingsRequests: Array<Record<string, unknown>> = [];
    const client = createClient({
      listMessages: emptyMessagePage,
      session: () => ({ ...createSession(), agentTargetId: "target-1" }),
      settings: async (_workspaceId, _sessionId, settings) => {
        settingsRequests.push(settings);
        return { ...createSession(), agentTargetId: "target-1", settings };
      }
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    const updateSessionSettings = jest.spyOn(engine, "updateSessionSettings");
    service.updateComposerSettings({ planMode: true });
    await flushAsyncWork();

    expect(updateSessionSettings).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      settings: { planMode: true }
    });
    expect(settingsRequests).toEqual([{ planMode: true }]);
    expect(service.getSnapshot().selectedSession?.settings.planMode).toBe(true);

    service.dispose();
  });

  test("routes Session stop through the Engine semantic operation", async () => {
    const service = createService(
      createClient({ listMessages: emptyMessagePage })
    );

    await service.start();
    await flushAsyncWork();
    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    const stopSession = jest.spyOn(engine, "stopSession");

    service.stop();

    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith({
      agentSessionId: "session-1"
    });
    service.dispose();
  });

  test("treats a new Mobile settings selection as a retry after unknown delivery", async () => {
    const settingsRequests: Array<Record<string, unknown>> = [];
    const client = createClient({
      listMessages: emptyMessagePage,
      session: () => ({ ...createSession(), agentTargetId: "target-1" }),
      settings: (_workspaceId, _sessionId, settings) => {
        settingsRequests.push(settings);
        if (settingsRequests.length === 1) {
          return new Promise<WorkspaceAgentSession>(() => undefined);
        }
        return Promise.resolve({
          ...createSession(),
          agentTargetId: "target-1",
          settings
        });
      }
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    service.updateComposerSettings({ planMode: true });
    await flushAsyncWork();

    const engine = (
      service as unknown as {
        engine: AgentSessionEngine;
      }
    ).engine;
    const firstCommandId =
      engine.getSnapshot().sessionLifecycle.operationBySessionId["session-1"]
        ?.settingsUpdate.commandId;
    expect(firstCommandId).toBeTruthy();
    engine.dispatch({
      commandId: firstCommandId!,
      commandType: "session/updateSettings",
      correlationId: "session-1",
      outcome: "timedOut",
      type: "engine/commandResult"
    });

    service.updateComposerSettings({ model: "model-2" });
    await flushAsyncWork();

    expect(settingsRequests).toEqual([
      { planMode: true },
      { model: "model-2", planMode: true }
    ]);

    service.dispose();
  });

  test("keeps Interaction submission and availability in Engine-owned state", async () => {
    let interactiveCalls = 0;
    const interaction = createInteraction();
    const turn: WorkspaceAgentTurn = {
      ...createTurn("session-1", interaction.turnId),
      phase: "waiting",
      settledAtUnixMs: null
    };
    const session = {
      ...createSession(),
      activeTurn: turn,
      activeTurnId: turn.turnId,
      latestTurn: turn,
      latestTurnInteractions: [interaction],
      pendingInteractions: [interaction]
    };
    const client = createClient({
      interactive: async () => {
        interactiveCalls += 1;
        return new Promise<never>(() => undefined);
      },
      listMessages: emptyMessagePage,
      session: () => session
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    service.respondToInteraction(interaction, { optionId: "allow-once" });
    service.respondToInteraction(interaction, { optionId: "allow-once" });
    await flushAsyncWork();

    const interactionKey = canonicalInteractionKey(
      interaction.agentSessionId,
      interaction.turnId,
      interaction.requestId
    );
    expect(interactiveCalls).toBe(1);
    expect(service.getSnapshot().interactionStates[interactionKey]).toEqual({
      failed: false,
      runtimeAvailable: true,
      submitting: true
    });

    service.pause();
    expect(service.getSnapshot().interactionStates[interactionKey]).toEqual({
      failed: false,
      runtimeAvailable: false,
      submitting: true
    });
    service.dispose();
  });

  test("retries a failed Interaction only when the user explicitly submits the same response", async () => {
    const interaction = createInteraction();
    const requests: Record<string, unknown>[] = [];
    let attempt = 0;
    const turn: WorkspaceAgentTurn = {
      ...createTurn("session-1", interaction.turnId),
      phase: "waiting",
      settledAtUnixMs: null
    };
    const session = {
      ...createSession(),
      activeTurn: turn,
      activeTurnId: turn.turnId,
      latestTurn: turn,
      latestTurnInteractions: [interaction],
      pendingInteractions: [interaction]
    };
    const client = createClient({
      interactive: async (_workspaceId, _agentSessionId, _requestId, input) => {
        requests.push(input);
        attempt += 1;
        if (attempt === 1) throw new Error("temporary failure");
        return session;
      },
      listMessages: emptyMessagePage,
      session: () => session
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    service.respondToInteraction(interaction, { optionId: "allow-once" });
    await flushAsyncWork();

    const interactionKey = canonicalInteractionKey(
      interaction.agentSessionId,
      interaction.turnId,
      interaction.requestId
    );
    expect(
      service.getSnapshot().interactionStates[interactionKey]?.failed
    ).toBe(true);

    service.respondToInteraction(interaction, {});
    await flushAsyncWork();
    expect(requests).toHaveLength(1);

    service.respondToInteraction(interaction, { optionId: "allow-once" });
    await flushAsyncWork();

    expect(requests).toEqual([
      {
        action: null,
        optionId: "allow-once",
        payload: null,
        turnId: interaction.turnId
      },
      {
        action: null,
        optionId: "allow-once",
        payload: null,
        turnId: interaction.turnId
      }
    ]);
    service.dispose();
  });

  test("fails closed when a response does not match a canonical pending Interaction", async () => {
    let interactiveCalls = 0;
    const client = createClient({
      interactive: async () => {
        interactiveCalls += 1;
        return createSession();
      },
      listMessages: emptyMessagePage
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    service.respondToInteraction(createInteraction(), {
      optionId: "allow-once"
    });
    await flushAsyncWork();

    expect(interactiveCalls).toBe(0);
    service.dispose();
  });

  test("routes pin changes through the canonical session mutation command", async () => {
    let session = createSession();
    const pinRequests: boolean[] = [];
    const client = createClient({
      listMessages: async (_workspaceId, agentSessionId) => ({
        agentSessionId,
        hasMore: false,
        latestVersion: 0,
        messages: []
      }),
      pin: async (_workspaceId, _agentSessionId, input) => {
        pinRequests.push(input.pinned);
        session = { ...session, pinnedAtUnixMs: input.pinned ? 1_000 : null };
        return session;
      },
      session: () => session
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    await service.toggleSessionPinned("session-1");

    expect(pinRequests).toEqual([true]);
    expect(service.getSnapshot().activity.sessions[0]?.pinnedAtUnixMs).toBe(
      1_000
    );

    service.dispose();
  });

  test("renames a session through the engine without reloading rail membership", async () => {
    let session: WorkspaceAgentSession | null = createSession();
    const renameRequests: string[] = [];
    const client = createClient({
      listMessages: emptyMessagePage,
      rename: async (_workspaceId, _agentSessionId, input) => {
        renameRequests.push(input.title);
        session = { ...session!, title: input.title };
        return session;
      },
      session: () => session
    });
    const service = createService(client);
    const reconcileRail = jest.spyOn(service.rail, "reconcile");

    await service.start();
    await flushAsyncWork();
    reconcileRail.mockClear();
    await service.renameSession("session-1", "  Renamed session  ");

    expect(renameRequests).toEqual(["Renamed session"]);
    expect(reconcileRail).not.toHaveBeenCalled();
    expect(service.getSnapshot().selectedSession?.title).toBe(
      "Renamed session"
    );

    service.dispose();
  });

  test("deletes a session through the canonical mutation command", async () => {
    let session: WorkspaceAgentSession | null = createSession();
    const deleteRequests: string[][] = [];
    const client = createClient({
      deleteBatch: async (_workspaceId, input) => {
        deleteRequests.push(input.sessionIds);
        session = null;
        return {
          cleanupFailedSessionIds: [],
          removedMessages: 3,
          removedSessionIds: ["session-1"],
          removedSessions: 1
        };
      },
      listMessages: emptyMessagePage,
      session: () => session
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    await service.deleteSession("session-1");

    expect(deleteRequests).toEqual([["session-1"]]);
    expect(service.getSnapshot().activity.sessions).toEqual([]);
    expect(service.getSnapshot().selectedAgentSessionId).toBeNull();

    service.dispose();
  });

  test("applies a remote session deletion without letting the rail revive it", async () => {
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    let session: WorkspaceAgentSession | null = createSession();
    const client = createClient({
      listMessages: emptyMessagePage,
      session: () => session
    });
    const service = createService(client, {
      deviceLink: createLiveDeviceLink((listener) => {
        liveListener = listener;
      })
    });

    await service.start();
    await flushAsyncWork();
    session = null;
    liveListener!({
      agentSessionId: "session-1",
      kind: "session_deleted"
    });

    expect(service.getSnapshot().activity.sessions).toEqual([]);
    expect(service.getSnapshot().selectedAgentSessionId).toBeNull();

    service.dispose();
  });

  test("rehydrates a remotely restored session after clearing its live tombstone", async () => {
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    let session: WorkspaceAgentSession | null = createSession();
    const client = createClient({
      listMessages: emptyMessagePage,
      session: () => session
    });
    const service = createService(client, {
      deviceLink: createLiveDeviceLink((listener) => {
        liveListener = listener;
      })
    });

    await service.start();
    await flushAsyncWork();
    session = null;
    liveListener!({
      agentSessionId: "session-1",
      kind: "session_deleted"
    });
    expect(service.getSnapshot().activity.sessions).toEqual([]);

    session = createSession();
    liveListener!({
      agentSessionId: "session-1",
      kind: "session_restored"
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(
      service
        .getSnapshot()
        .activity.sessions.map((candidate) => candidate.agentSessionId)
    ).toEqual(["session-1"]);

    service.dispose();
  });

  test("ignores an obsolete live subscription after background resume", async () => {
    const liveListeners: Array<(delivery: AgentLiveDelivery) => void> = [];
    const service = createService(
      createClient({ listMessages: emptyMessagePage }),
      {
        deviceLink: createLiveDeviceLink((listener) => {
          liveListeners.push(listener);
        })
      }
    );

    await service.start();
    await flushAsyncWork();
    expect(liveListeners).toHaveLength(1);
    liveListeners[0]!({ kind: "connection", status: "connected" });
    expect(service.isTransportConnected()).toBe(true);

    service.pause();
    service.resume();
    expect(liveListeners).toHaveLength(2);
    expect(service.isTransportConnected()).toBe(false);

    liveListeners[0]!({ kind: "connection", status: "connected" });
    expect(service.isTransportConnected()).toBe(false);
    liveListeners[1]!({ kind: "connection", status: "connected" });
    expect(service.isTransportConnected()).toBe(true);

    service.dispose();
  });

  test("projects live message deltas and disables fallback message polling", async () => {
    const clock = new RecordingClock();
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    const client = createClient({
      listMessages: async (_workspaceId, agentSessionId) => ({
        agentSessionId,
        hasMore: false,
        latestVersion: 1,
        messages: [createMessage("message-1", 1)]
      })
    });
    const deviceLink = {
      closeLink: async () => undefined,
      requestAgentHTTP: async () => ({
        body: "",
        errorCode: "",
        headers: {},
        protocolEpoch: 1,
        status: 204
      }),
      subscribeAgentLive: (
        _workspaceId: string,
        listener: (delivery: AgentLiveDelivery) => void
      ) => {
        liveListener = listener;
        return { close() {} };
      }
    } satisfies DeviceLinkPort;
    const service = createService(client, { clock, deviceLink });

    await service.start();
    await flushAsyncWork();
    liveListener!({ kind: "connection", status: "connected" });
    await flushAsyncWork();
    liveListener!({
      event: {
        agentSessionId: "session-1",
        data: {
          agentSessionId: "session-1",
          content: { operation: "append_text", text: "!" },
          kind: "text",
          messageId: "message-1",
          occurredAtUnixMs: 2,
          role: "assistant",
          turnId: "turn-1",
          workspaceId: workspace.id
        },
        eventType: "message_delta",
        workspaceId: workspace.id
      },
      kind: "event"
    });

    expect(
      service.getSnapshot().activity.sessionMessagesById["session-1"]?.[0]
        ?.payload.text
    ).toBe("message-1!");
    expect(clock.activeDelays()).not.toContain(1_000);

    service.dispose();
  });

  test("applies a continuous live Session audit without a redundant detail read", async () => {
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    let detailReads = 0;
    const client = createClient({
      detail: async () => {
        detailReads += 1;
        return {
          ...fullSessionDetailProjection,
          childSessions: [],
          session: createSession(),
          turns: []
        };
      },
      listMessages: async (_workspaceId, agentSessionId) => ({
        agentSessionId,
        hasMore: false,
        latestVersion: 1,
        messages: [createMessage("message-1", 1)]
      })
    });
    const deviceLink = {
      closeLink: async () => undefined,
      requestAgentHTTP: async () => ({
        body: "",
        errorCode: "",
        headers: {},
        protocolEpoch: 1,
        status: 204
      }),
      subscribeAgentLive: (
        _workspaceId: string,
        listener: (delivery: AgentLiveDelivery) => void
      ) => {
        liveListener = listener;
        return { close() {} };
      }
    } satisfies DeviceLinkPort;
    const service = createService(client, { deviceLink });

    await service.start();
    await flushAsyncWork();
    const detailReadsAfterInitialHydration = detailReads;
    liveListener!({
      event: {
        agentSessionId: "session-1",
        data: {
          agentSessionId: "session-1",
          audit: {
            auditId: "audit-1",
            occurredAtUnixMs: 2,
            payload: { text: "/goal clear" },
            role: "user",
            version: 2
          },
          eventType: "session_audit",
          workspaceId: workspace.id
        },
        eventType: "session_audit",
        workspaceId: workspace.id
      },
      kind: "event"
    });
    await flushAsyncWork();

    expect(
      service
        .getSnapshot()
        .activity.sessionMessagesById["session-1"]?.map(
          (message) => message.messageId
        )
    ).toEqual(["message-1", "audit-1"]);
    expect(detailReadsAfterInitialHydration).toBe(2);
    expect(detailReads).toBe(detailReadsAfterInitialHydration);

    service.dispose();
  });

  test("runs an authoritative live reconcile while an older page is in flight", async () => {
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    let resolveOlder: ((value: ReturnType<typeof messagePage>) => void) | null =
      null;
    const queries: Array<Record<string, unknown>> = [];
    const client = createClient({
      detail: async () => ({
        ...fullSessionDetailProjection,
        childSessions: [],
        session: createSession(),
        turns: []
      }),
      listMessages: async (_workspaceId, agentSessionId, query) => {
        queries.push(query);
        if ("beforeVersion" in query) {
          return new Promise((resolve) => {
            resolveOlder = resolve;
          });
        }
        const version = queries.length === 1 ? 5 : 6;
        return {
          ...messagePage(agentSessionId, `message-${version}`, version),
          hasMore: version === 5
        };
      }
    });
    const service = createService(client, {
      deviceLink: createLiveDeviceLink((listener) => {
        liveListener = listener;
      })
    });

    await service.start();
    await flushAsyncWork();
    const older = service.loadOlderMessages();
    await flushAsyncWork();
    liveListener!(sessionDiscontinuity());
    await flushAsyncWork();

    expect(queries).toEqual([
      { limit: 100, order: "desc" },
      { beforeVersion: 5, limit: 100, order: "desc" },
      { afterVersion: 0, order: "asc" }
    ]);
    expect(
      service
        .getSnapshot()
        .activity.sessionMessagesById["session-1"]?.some(
          (message) => message.version === 6
        )
    ).toBe(true);

    resolveOlder!(messagePage("session-1", "message-1", 1));
    await older;
    service.dispose();
  });

  test("queues authoritative live reconcile behind in-flight incremental polling", async () => {
    const clock = new RecordingClock();
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    let resolveIncremental:
      | ((value: ReturnType<typeof messagePage>) => void)
      | null = null;
    const queries: Array<Record<string, unknown>> = [];
    const client = createClient({
      detail: async () => ({
        ...fullSessionDetailProjection,
        childSessions: [],
        session: createSession(),
        turns: []
      }),
      listMessages: async (_workspaceId, agentSessionId, query) => {
        queries.push(query);
        if (query.afterVersion === 0 && queries.length === 2) {
          return new Promise((resolve) => {
            resolveIncremental = resolve;
          });
        }
        const version = queries.length === 1 ? 5 : 7;
        return messagePage(agentSessionId, `message-${version}`, version);
      }
    });
    const service = createService(client, {
      clock,
      deviceLink: createLiveDeviceLink((listener) => {
        liveListener = listener;
      })
    });

    await service.start();
    await flushAsyncWork();
    clock.runNext(1_000);
    await flushAsyncWork();
    liveListener!(sessionDiscontinuity());
    await flushAsyncWork();

    expect(queries).toEqual([
      { limit: 100, order: "desc" },
      { afterVersion: 0, order: "asc" }
    ]);
    resolveIncremental!(messagePage("session-1", "message-6", 6));
    await flushAsyncWork();

    expect(queries).toEqual([
      { limit: 100, order: "desc" },
      { afterVersion: 0, order: "asc" },
      { afterVersion: 0, order: "asc" }
    ]);
    expect(
      service
        .getSnapshot()
        .activity.sessionMessagesById["session-1"]?.some(
          (message) => message.version === 7
        )
    ).toBe(true);

    service.dispose();
  });

  test("surfaces and clears authoritative message reconcile failures", async () => {
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    let failReconcile = true;
    let messageVersion = 1;
    const client = createClient({
      detail: async () => ({
        ...fullSessionDetailProjection,
        childSessions: [],
        session: createSession(),
        turns: []
      }),
      listMessages: async (_workspaceId, agentSessionId, query) => {
        if ("afterVersion" in query && failReconcile) {
          throw new Error("message reconcile failed");
        }
        messageVersion += 1;
        return messagePage(
          agentSessionId,
          `message-${messageVersion}`,
          messageVersion
        );
      }
    });
    const service = createService(client, {
      deviceLink: createLiveDeviceLink((listener) => {
        liveListener = listener;
      })
    });

    await service.start();
    await flushAsyncWork();
    liveListener!(sessionDiscontinuity());
    await flushAsyncWork();
    expect(service.getSnapshot().errorCode).toBe("request_failed");

    failReconcile = false;
    service.pause();
    service.resume();
    await flushAsyncWork();
    expect(service.getSnapshot().errorCode).toBeNull();

    service.dispose();
  });

  test("loads a newly selected Session without waiting for the previous Session request", async () => {
    let resolveFirst: ((value: ReturnType<typeof messagePage>) => void) | null =
      null;
    const requestedSessionIds: string[] = [];
    const second = { ...createSession(), id: "session-2", title: "Second" };
    const client = createClient({
      listMessages: async (_workspaceId, agentSessionId) => {
        requestedSessionIds.push(agentSessionId);
        if (agentSessionId === "session-1") {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return messagePage(agentSessionId, "message-2", 2);
      },
      sessions: () => [createSession(), second]
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    service.selectSession("session-2");
    await flushAsyncWork();

    expect(requestedSessionIds).toEqual(["session-1", "session-2"]);
    expect(
      service.getSnapshot().activity.sessionMessagesById["session-2"]?.[0]
        ?.messageId
    ).toBe("message-2");

    resolveFirst!(messagePage("session-1", "message-1", 1));
    await flushAsyncWork();
    service.dispose();
  });

  test("reconciles one authoritative detail aggregate with child Sessions", async () => {
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    const root = createSession();
    const childInteraction = {
      ...createInteraction(),
      agentSessionId: "child-1",
      requestId: "child-request-1",
      turnId: "child-turn-1"
    };
    const childTurn: WorkspaceAgentTurn = {
      ...createTurn("child-1", childInteraction.turnId),
      phase: "waiting",
      settledAtUnixMs: null
    };
    const child = {
      ...createChildSession(root.id),
      activeTurn: childTurn,
      activeTurnId: childTurn.turnId,
      latestTurn: childTurn,
      latestTurnInteractions: [childInteraction],
      pendingInteractions: [childInteraction]
    };
    const client = createClient({
      detail: async () => ({
        ...fullSessionDetailProjection,
        childSessions: [child],
        session: root,
        turns: [createTurn(root.id, "turn-root-1")]
      }),
      listMessages: emptyMessagePage
    });
    const deviceLink = {
      closeLink: async () => undefined,
      requestAgentHTTP: async () => ({
        body: "",
        errorCode: "",
        headers: {},
        protocolEpoch: 1,
        status: 204
      }),
      subscribeAgentLive: (
        _workspaceId: string,
        listener: (delivery: AgentLiveDelivery) => void
      ) => {
        liveListener = listener;
        return { close() {} };
      }
    } satisfies DeviceLinkPort;
    const service = createService(client, { deviceLink });

    await service.start();
    await flushAsyncWork();
    liveListener!({ kind: "connection", status: "connected" });
    liveListener!({
      kind: "discontinuity",
      reason: "canonical_update",
      reconcileKeys: [
        {
          agentSessionId: root.id,
          kind: "session",
          workspaceId: workspace.id
        }
      ]
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(
      service
        .getSnapshot()
        .activity.sessions.map((session) => session.agentSessionId)
    ).toEqual(expect.arrayContaining([root.id, child.id]));
    expect(
      service
        .getSnapshot()
        .activity.sessions.find(
          (session) => session.agentSessionId === child.id
        )
    ).toEqual(
      expect.objectContaining({
        kind: "child",
        parentAgentSessionId: root.id,
        rootAgentSessionId: root.id,
        userId: "account-user-1"
      })
    );
    const childInteractionKey = canonicalInteractionKey(
      childInteraction.agentSessionId,
      childInteraction.turnId,
      childInteraction.requestId
    );
    expect(
      service.getSnapshot().interactionStates[childInteractionKey]
        ?.runtimeAvailable
    ).toBe(true);

    service.pause();
    expect(
      service.getSnapshot().interactionStates[childInteractionKey]
        ?.runtimeAvailable
    ).toBe(false);
    service.resume();
    expect(
      service.getSnapshot().interactionStates[childInteractionKey]
        ?.runtimeAvailable
    ).toBe(false);
    liveListener!({ kind: "connection", status: "connected" });
    expect(
      service.getSnapshot().interactionStates[childInteractionKey]
        ?.runtimeAvailable
    ).toBe(true);

    service.dispose();
  });

  test("accepts only the matching attachment catch-up barrier", async () => {
    const clock = new RecordingClock();
    let closeCount = 0;
    let liveListener: ((delivery: AgentLiveDelivery) => void) | null = null;
    const deviceLink = {
      closeLink: async () => undefined,
      requestAgentHTTP: async () => ({
        body: "",
        errorCode: "",
        headers: {},
        protocolEpoch: 1,
        status: 204
      }),
      subscribeAgentLive: (
        _workspaceId: string,
        listener: (delivery: AgentLiveDelivery) => void
      ) => {
        liveListener = listener;
        return {
          close() {
            closeCount += 1;
          }
        };
      }
    } satisfies DeviceLinkPort;
    const service = createService(
      createClient({ listMessages: emptyMessagePage }),
      { clock, deviceLink }
    );

    await service.start();
    await flushAsyncWork();
    liveListener!({ kind: "connection", status: "connected" });
    const firstAttachment = {
      agentSessionId: "owner-session-1",
      attachmentRevision: 1,
      bindingId: "binding-1",
      callerTurnId: "caller-turn-1",
      canonicalTurnId: "canonical-turn-1",
      workspaceId: workspace.id
    };
    liveListener!({
      attachment: firstAttachment,
      kind: "attachment_changed"
    });
    liveListener!({
      attachment: firstAttachment,
      kind: "attachment_caught_up"
    });
    const replacementAttachment = {
      ...firstAttachment,
      attachmentRevision: 2
    };
    liveListener!({
      attachment: replacementAttachment,
      kind: "attachment_changed"
    });

    expect(closeCount).toBe(0);
    expect(clock.activeDelays()).not.toContain(1_000);

    liveListener!({
      attachment: firstAttachment,
      kind: "attachment_caught_up"
    });

    expect(closeCount).toBe(1);
    expect(clock.activeDelays()).toContain(1_000);

    service.dispose();
  });
});

function createService(
  client: TuttidClient,
  options: {
    clock?: ClockPort;
    deviceLink?: DeviceLinkPort;
  } = {}
): WorkspaceActivityService {
  const clock = options.clock ?? new ManualClock();
  return new WorkspaceActivityService(
    workspace,
    client,
    new AgentDirectoryService(client),
    new MobileUserProjectDirectoryService(client),
    new WorkspaceNavigationService(),
    new ComposerDraftService(),
    clock,
    "account-user-1",
    options.deviceLink
  );
}

function createClient(options: {
  composerOptions?(
    provider: string,
    request?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  create?(
    workspaceId: string,
    input: Parameters<TuttidClient["createWorkspaceAgentSession"]>[1]
  ): Promise<WorkspaceAgentSession>;
  goalControl?(
    workspaceId: string,
    agentSessionId: string,
    input: Parameters<TuttidClient["goalControlWorkspaceAgentSession"]>[2]
  ): ReturnType<TuttidClient["goalControlWorkspaceAgentSession"]>;
  detail?(
    workspaceId: string,
    agentSessionId: string
  ): Promise<WorkspaceAgentSessionDetailResponse>;
  interactive?(
    workspaceId: string,
    agentSessionId: string,
    requestId: string,
    input: Record<string, unknown>
  ): Promise<WorkspaceAgentSession>;
  deleteBatch?(
    workspaceId: string,
    input: { sessionIds: string[] }
  ): Promise<{
    cleanupFailedSessionIds: string[];
    removedMessages: number;
    removedSessionIds: string[];
    removedSessions: number;
  }>;
  listMessages(
    workspaceId: string,
    agentSessionId: string,
    query: Record<string, unknown>
  ): Promise<{
    agentSessionId: string;
    hasMore: boolean;
    latestVersion: number;
    messages: WorkspaceAgentSessionMessage[];
  }>;
  listSections?: NonNullable<TuttidClient["listWorkspaceAgentSessionSections"]>;
  projects?: Awaited<ReturnType<TuttidClient["listUserProjects"]>>["projects"];
  send?(
    workspaceId: string,
    agentSessionId: string,
    input: Record<string, unknown>
  ): Promise<never>;
  pin?(
    workspaceId: string,
    agentSessionId: string,
    input: { pinned: boolean }
  ): Promise<WorkspaceAgentSession>;
  rename?(
    workspaceId: string,
    agentSessionId: string,
    input: { title: string }
  ): Promise<WorkspaceAgentSession>;
  session?(): WorkspaceAgentSession | null;
  sessions?(): WorkspaceAgentSession[];
  settings?(
    workspaceId: string,
    agentSessionId: string,
    settings: Record<string, unknown>
  ): Promise<WorkspaceAgentSession>;
  targets?: Array<{
    id: string;
    provider: string;
    name: string;
  }>;
}): TuttidClient {
  const railSessions = () =>
    options.sessions?.() ??
    (() => {
      const session =
        options.session === undefined ? createSession() : options.session();
      return session ? [session] : [];
    })();
  return {
    createWorkspaceAgentSession: options.create,
    deleteWorkspaceAgentSessionsBatch: options.deleteBatch,
    getAgentProviderComposerOptions: options.composerOptions,
    goalControlWorkspaceAgentSession: options.goalControl,
    getWorkspaceAgentSession: async (
      ...args: Parameters<NonNullable<TuttidClient["getWorkspaceAgentSession"]>>
    ) => {
      const detail = options.detail
        ? await options.detail(args[0], args[1])
        : await (async () => {
            const session = railSessions().find(
              (candidate) => candidate.id === args[1]
            );
            if (!session) throw new Error("session not found");
            return {
              ...fullSessionDetailProjection,
              childSessions: [],
              session,
              turns: session.latestTurn ? [session.latestTurn] : []
            };
          })();
      const projection = args[2] ?? "full";
      return {
        ...detail,
        lifecycleCapabilitiesProjected: projection === "full",
        projection
      };
    },
    listAgentTargets: async () => ({ targets: options.targets ?? [] }),
    listUserProjects: async () => ({ projects: options.projects ?? [] }),
    listWorkspaceAgentSessionMessages: options.listMessages,
    listWorkspaceAgentPinnedSessionPage: async () => {
      const sessions = railSessions().filter(
        (session) => session.pinnedAtUnixMs != null
      );
      return {
        page: {
          hasMore: false,
          sessions,
          totalCount: sessions.length
        },
        workspaceId: workspace.id
      };
    },
    listWorkspaceAgentSessionSectionPage: async (
      _workspaceId: string,
      request: Parameters<
        NonNullable<TuttidClient["listWorkspaceAgentSessionSectionPage"]>
      >[1]
    ) => {
      const sessions = railSessions().filter(
        (session) =>
          session.pinnedAtUnixMs == null &&
          session.railSectionKey === request.sectionKey
      );
      return {
        section: {
          hasMore: false,
          kind:
            request.sectionKey === "conversations"
              ? ("conversations" as const)
              : ("project" as const),
          sectionKey: request.sectionKey,
          sessions,
          totalCount: sessions.length
        },
        workspaceId: workspace.id
      };
    },
    listWorkspaceAgentSessionSections:
      options.listSections ??
      (async () => {
        const sessions = railSessions();
        if (sessions.length === 0) {
          return {
            pinned: { hasMore: false, sessions: [], totalCount: 0 },
            sections: [],
            workspaceId: workspace.id
          };
        }
        const pinnedSessions = sessions.filter(
          (session) => session.pinnedAtUnixMs != null
        );
        const conversationSessions = sessions.filter(
          (session) => session.pinnedAtUnixMs == null
        );
        return {
          pinned: {
            hasMore: false,
            sessions: pinnedSessions,
            totalCount: pinnedSessions.length
          },
          sections:
            conversationSessions.length === 0
              ? []
              : [
                  {
                    hasMore: false,
                    kind: "conversations" as const,
                    sectionKey: "conversations",
                    sessions: conversationSessions,
                    totalCount: conversationSessions.length
                  }
                ],
          workspaceId: workspace.id
        };
      }),
    sendWorkspaceAgentSessionInput: options.send,
    submitWorkspaceAgentInteractive: options.interactive,
    updateWorkspaceAgentSessionPin: options.pin,
    updateWorkspaceAgentSessionSettings: options.settings,
    updateWorkspaceAgentSessionTitle: options.rename
  } as unknown as TuttidClient;
}

function createTarget(
  overrides: Partial<ReturnType<typeof createTargetBase>> = {}
) {
  return { ...createTargetBase(), ...overrides };
}

function createTargetBase() {
  return {
    availability: { status: "ready" },
    createdAtUnixMs: 1,
    enabled: true,
    id: "target-1",
    launchRef: { provider: "codex", type: "builtin_local" as const },
    name: "Codex",
    provider: "codex",
    sortOrder: 1,
    source: "system" as const,
    updatedAtUnixMs: 1
  };
}

function createUserProject(
  overrides: Partial<ReturnType<typeof createUserProjectBase>> = {}
) {
  return { ...createUserProjectBase(), ...overrides };
}

function createUserProjectBase() {
  return {
    createdAtUnixMs: 1,
    id: "project-1",
    label: "tutti",
    lastUsedAtUnixMs: 1,
    path: "/workspace/tutti",
    pinnedAtUnixMs: 0,
    sectionKey: "project:tutti",
    updatedAtUnixMs: 1
  };
}

async function emptyMessagePage(
  _workspaceId: string,
  agentSessionId: string
): Promise<{
  agentSessionId: string;
  hasMore: boolean;
  latestVersion: number;
  messages: WorkspaceAgentSessionMessage[];
}> {
  return {
    agentSessionId,
    hasMore: false,
    latestVersion: 0,
    messages: []
  };
}

function createSession(): WorkspaceAgentSession {
  return {
    activeTurn: null,
    activeTurnId: null,
    agentTargetId: null,
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/",
    endedAtUnixMs: null,
    forkedFrom: null,
    goal: null,
    goalSyncState: null,
    id: "session-1",
    imported: false,
    kind: "root",
    latestTurn: null,
    latestTurnInteractions: [],
    lifecycleCapabilities: { fork: false, forkThroughTurn: false },
    messageVersion: 0,
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    railSectionKey: "conversations",
    resumable: true,
    rootAgentSessionId: null,
    rootTurnId: null,
    settings: {},
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 2,
    usage: null,
    visible: true
  };
}

function createChildSession(rootAgentSessionId: string): WorkspaceAgentSession {
  return {
    ...createSession(),
    id: "child-1",
    kind: "child",
    parentAgentSessionId: rootAgentSessionId,
    parentToolCallId: "tool-call-1",
    parentTurnId: "turn-root-1",
    rootAgentSessionId,
    rootTurnId: "turn-root-1",
    title: "Child"
  };
}

function createTurn(
  agentSessionId: string,
  turnId: string
): WorkspaceAgentTurn {
  return {
    agentSessionId,
    completedCommand: null,
    error: null,
    fileChanges: null,
    origin: "user_prompt",
    outcome: null,
    phase: "settled",
    providerForkBindingAvailable: false,
    providerForkBindingState: "recovery_required",
    settledAtUnixMs: 3,
    startedAtUnixMs: 2,
    turnId,
    updatedAtUnixMs: 3
  };
}

function createInteraction(): WorkspaceAgentInteraction {
  return {
    agentSessionId: "session-1",
    createdAtUnixMs: 3,
    input: {
      options: [{ label: "Allow", optionId: "allow-once" }]
    },
    kind: "approval",
    metadata: {},
    output: null,
    requestId: "request-1",
    status: "pending",
    toolName: "Approval",
    turnId: "turn-1",
    updatedAtUnixMs: 3
  };
}

function createMessage(
  messageId: string,
  version: number
): WorkspaceAgentSessionMessage {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId,
    occurredAtUnixMs: version,
    payload: { text: messageId },
    role: "assistant",
    sequence: version,
    turnId: "turn-1",
    version
  };
}

function messagePage(
  agentSessionId: string,
  messageId: string,
  version: number
) {
  return {
    agentSessionId,
    hasMore: false,
    latestVersion: version,
    messages: [
      {
        ...createMessage(messageId, version),
        agentSessionId
      }
    ]
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let turn = 0; turn < 24; turn += 1) {
    await Promise.resolve();
  }
}

class ManualClock implements ClockPort {
  now(): number {
    return 1_000;
  }

  schedule(): { cancel(): void } {
    return { cancel: () => undefined };
  }
}

class RecordingClock implements ClockPort {
  private readonly tasks: Array<{
    canceled: boolean;
    delayMs: number;
    task: () => void;
  }> = [];

  now(): number {
    return 1_000;
  }

  schedule(delayMs: number, callback: () => void): { cancel(): void } {
    const task = { canceled: false, delayMs, task: callback };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.canceled = true;
      }
    };
  }

  activeDelays(): number[] {
    return this.tasks
      .filter((task) => !task.canceled)
      .map((task) => task.delayMs);
  }

  runNext(delayMs: number): void {
    const task = this.tasks.find(
      (candidate) => !candidate.canceled && candidate.delayMs === delayMs
    );
    if (!task) throw new Error(`no active ${delayMs}ms task`);
    task.canceled = true;
    task.task();
  }
}

function createLiveDeviceLink(
  onSubscribe: (listener: (delivery: AgentLiveDelivery) => void) => void
): DeviceLinkPort {
  return {
    closeLink: async () => undefined,
    requestAgentHTTP: async () => ({
      body: "",
      errorCode: "",
      headers: {},
      protocolEpoch: 1,
      status: 204
    }),
    subscribeAgentLive: (_workspaceId, listener) => {
      onSubscribe(listener);
      return { close() {} };
    }
  };
}

function sessionDiscontinuity(): AgentLiveDelivery {
  return {
    kind: "discontinuity",
    reason: "canonical_update",
    reconcileKeys: [
      {
        agentSessionId: "session-1",
        kind: "session",
        workspaceId: workspace.id
      }
    ]
  };
}
