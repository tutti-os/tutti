import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHostInputApi } from "@tutti-os/agent-gui";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type { WorkspaceUserProject } from "@tutti-os/workspace-user-project/contracts";
import type { ReporterEventInput } from "@renderer/features/analytics/services/reporterService.interface.ts";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import {
  USER_PROJECT_REFERENCE_SOURCE_ID,
  WORKSPACE_FILE_SOURCE_ID
} from "../../agent-reference-sources/index.ts";
import { DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID } from "../../workspace-file-manager/services/desktopWorkspaceFileLocations.ts";
import { createDesktopAgentGUIWorkbenchHostInput } from "./createDesktopAgentGUIWorkbenchHostInput.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface.ts";

const workspaceId = "workspace-1";

function createLegacyAgentReporterService(
  reporterCalls: ReporterEventInput[][]
) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      const legacyEvents = legacyAgentEvents(events);
      if (legacyEvents.length > 0) {
        reporterCalls.push(legacyEvents);
      }
    }
  };
}

function legacyAgentEvents(
  events: readonly ReporterEventInput[]
): ReporterEventInput[] {
  return events
    .filter((event) => event.name !== "agent.node_result")
    .map(stripAgentAnalyticsErrorFields);
}

function stripAgentAnalyticsErrorFields(
  event: ReporterEventInput
): ReporterEventInput {
  if (!event.name.startsWith("agent.")) {
    return event;
  }
  const eventParams = event.params ?? {};
  const {
    error_code: _errorCode,
    error_message: _errorMessage,
    ...params
  } = eventParams;
  return { ...event, params };
}

test("desktop agent GUI workbench host input reuses an injected agent host api", () => {
  const agentHostApi = {
    meta: { workspaceId }
  } as unknown as AgentHostInputApi;
  const richTextTriggerProviders = [createRichTextTriggerProvider("file")];
  const richTextAtRequests: unknown[] = [];

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({
      providers: richTextTriggerProviders,
      requests: richTextAtRequests
    }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  assert.equal(hostInput.agentHostApi, agentHostApi);
  assert.equal(typeof hostInput.agentQueuedPromptRuntime.enqueue, "function");
  assert.equal(hostInput.contextMentionProviders[0]?.id, "file");
  assert.equal(
    typeof hostInput.workspaceFileReferenceAdapter.listDirectory,
    "function"
  );
  assert.deepEqual(richTextAtRequests, [
    {
      capabilities: [
        "file",
        "workspace-issue",
        "agent-session",
        "workspace-app",
        "agent-target"
      ],
      surface: "composer",
      target: "agent-gui",
      workspaceId
    }
  ]);
});

test("desktop agent GUI workbench host input reuses workspace runtime services", () => {
  const activityService = createWorkspaceAgentActivityService([]);
  const firstHostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });
  const secondHostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });

  assert.equal(
    secondHostInput.agentActivityRuntime,
    firstHostInput.agentActivityRuntime
  );
  assert.equal(
    secondHostInput.agentQueuedPromptRuntime,
    firstHostInput.agentQueuedPromptRuntime
  );
});

test("desktop agent GUI host input drains queued prompts without mounted agent GUI panels", async () => {
  const calls: string[] = [];
  const sendInputs: unknown[] = [];
  let snapshot = activitySnapshotWithSessions([
    activitySession("session-1", { status: "working", updatedAtUnixMs: 1 })
  ]);
  const subscribers = new Set<(snapshot: AgentActivitySnapshot) => void>();
  const activityService = {
    ...createWorkspaceAgentActivityService(calls),
    getSnapshot(inputWorkspaceId: string) {
      return { ...snapshot, workspaceId: inputWorkspaceId };
    },
    async sendInput(input) {
      sendInputs.push(input);
      return {
        session: activitySession(input.agentSessionId, {
          status: "working",
          updatedAtUnixMs: 3
        }),
        turnId: "turn-1",
        turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    },
    subscribe(_workspaceId, listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }
  } satisfies IWorkspaceAgentActivityService;
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });

  hostInput.agentQueuedPromptRuntime.enqueue({
    workspaceId,
    agentSessionId: "session-1",
    prompt: {
      id: "queued-1",
      content: [{ type: "text", text: "queued without panel" }],
      createdAtUnixMs: 1
    }
  });
  await flushQueuedPromptDrainer();
  assert.equal(sendInputs.length, 0);

  snapshot = activitySnapshotWithSessions([
    activitySession("session-1", { status: "completed", updatedAtUnixMs: 2 })
  ]);
  for (const listener of subscribers) {
    listener(snapshot);
  }

  await waitForQueuedPromptDrainer(() => sendInputs.length === 1);
  assert.deepEqual(sendInputs, [
    {
      workspaceId,
      agentSessionId: "session-1",
      content: [{ type: "text", text: "queued without panel" }],
      displayPrompt: null
    }
  ]);
  assert.equal(
    hostInput.agentQueuedPromptRuntime.getSessionSnapshot({
      workspaceId,
      agentSessionId: "session-1"
    }).prompts.length,
    0
  );
});

test("desktop agent GUI queued prompt drainer waits for blocked submit availability to clear", async () => {
  const calls: string[] = [];
  const sendInputs: unknown[] = [];
  const activityService = {
    ...createWorkspaceAgentActivityService(calls),
    getSnapshot(inputWorkspaceId: string) {
      return {
        ...activitySnapshotWithSessions([
          activitySession("session-1", {
            currentPhase: "idle",
            status: "active",
            submitAvailability: { state: "blocked", reason: "active_turn" },
            turnLifecycle: { activeTurnId: "lingering-turn-1", phase: "idle" },
            updatedAtUnixMs: 2
          })
        ]),
        workspaceId: inputWorkspaceId
      };
    },
    async sendInput(input) {
      sendInputs.push(input);
      return {
        session: activitySession(input.agentSessionId, {
          status: "running",
          updatedAtUnixMs: 3
        }),
        turnId: "turn-1",
        turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    }
  } satisfies IWorkspaceAgentActivityService;
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });

  hostInput.agentQueuedPromptRuntime.enqueue({
    workspaceId,
    agentSessionId: "session-1",
    prompt: {
      id: "queued-stale-blocked",
      content: [{ type: "text", text: "queued after idle state patch" }],
      createdAtUnixMs: 1
    }
  });

  await flushQueuedPromptDrainer();
  await flushQueuedPromptDrainer();
  assert.deepEqual(sendInputs, []);
  assert.equal(
    hostInput.agentQueuedPromptRuntime.getSessionSnapshot({
      workspaceId,
      agentSessionId: "session-1"
    }).prompts.length,
    1
  );
});

test("desktop agent GUI queued prompt drainer waits for active turn id to clear", async () => {
  const calls: string[] = [];
  const sendInputs: unknown[] = [];
  const activityService = {
    ...createWorkspaceAgentActivityService(calls),
    getSnapshot(inputWorkspaceId: string) {
      return {
        ...activitySnapshotWithSessions([
          activitySession("session-1", {
            currentPhase: "idle",
            status: "active",
            submitAvailability: { state: "blocked", reason: "active_turn" },
            turnLifecycle: {
              activeTurnId: "lingering-turn-1",
              phase: "settled"
            },
            updatedAtUnixMs: 2
          })
        ]),
        workspaceId: inputWorkspaceId
      };
    },
    async sendInput(input) {
      sendInputs.push(input);
      return {
        session: activitySession(input.agentSessionId, {
          status: "running",
          updatedAtUnixMs: 3
        }),
        turnId: "turn-1",
        turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    }
  } satisfies IWorkspaceAgentActivityService;
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });

  hostInput.agentQueuedPromptRuntime.enqueue({
    workspaceId,
    agentSessionId: "session-1",
    prompt: {
      id: "queued-settled-turn",
      content: [{ type: "text", text: "queued after settled turn" }],
      createdAtUnixMs: 1
    }
  });

  await flushQueuedPromptDrainer();
  await flushQueuedPromptDrainer();
  assert.deepEqual(sendInputs, []);
  assert.equal(
    hostInput.agentQueuedPromptRuntime.getSessionSnapshot({
      workspaceId,
      agentSessionId: "session-1"
    }).prompts.length,
    1
  );
});

test("desktop agent GUI queued prompt drainer waits when submit availability is blocked for non-active-turn reasons", async () => {
  const calls: string[] = [];
  const sendInputs: unknown[] = [];
  const activityService = {
    ...createWorkspaceAgentActivityService(calls),
    getSnapshot(inputWorkspaceId: string) {
      return {
        ...activitySnapshotWithSessions([
          activitySession("session-1", {
            currentPhase: "idle",
            status: "active",
            submitAvailability: { state: "blocked", reason: "auth_required" },
            turnLifecycle: { activeTurnId: null, phase: "idle" },
            updatedAtUnixMs: 2
          })
        ]),
        workspaceId: inputWorkspaceId
      };
    },
    async sendInput(input) {
      sendInputs.push(input);
      return {
        session: activitySession(input.agentSessionId, {
          status: "running",
          updatedAtUnixMs: 3
        }),
        turnId: "turn-1",
        turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    }
  } satisfies IWorkspaceAgentActivityService;
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });

  hostInput.agentQueuedPromptRuntime.enqueue({
    workspaceId,
    agentSessionId: "session-1",
    prompt: {
      id: "queued-auth-blocked",
      content: [{ type: "text", text: "wait for auth" }],
      createdAtUnixMs: 1
    }
  });

  await flushQueuedPromptDrainer();
  assert.deepEqual(sendInputs, []);
  assert.equal(
    hostInput.agentQueuedPromptRuntime.getSessionSnapshot({
      workspaceId,
      agentSessionId: "session-1"
    }).prompts.length,
    1
  );
});

test("desktop agent GUI queued prompt drainer waits for activity change after active-turn conflict", async () => {
  const calls: string[] = [];
  const sendInputs: unknown[] = [];
  let snapshot = activitySnapshotWithSessions([
    activitySession("session-1", { status: "completed", updatedAtUnixMs: 2 })
  ]);
  const subscribers = new Set<(snapshot: AgentActivitySnapshot) => void>();
  let rejectWithActiveTurnConflict = true;
  const activityService = {
    ...createWorkspaceAgentActivityService(calls),
    getSnapshot(inputWorkspaceId: string) {
      return { ...snapshot, workspaceId: inputWorkspaceId };
    },
    async sendInput(input) {
      sendInputs.push(input);
      if (rejectWithActiveTurnConflict) {
        throw new Error("agent session already has an active turn");
      }
      return {
        session: activitySession(input.agentSessionId, {
          status: "working",
          updatedAtUnixMs: 4
        }),
        turnId: "turn-2",
        turnLifecycle: { activeTurnId: "turn-2", phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    },
    subscribe(_workspaceId, listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }
  } satisfies IWorkspaceAgentActivityService;
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });

  hostInput.agentQueuedPromptRuntime.enqueue({
    workspaceId,
    agentSessionId: "session-1",
    prompt: {
      id: "queued-conflict",
      content: [{ type: "text", text: "retry after activity changes" }],
      createdAtUnixMs: 1
    }
  });

  await waitForQueuedPromptDrainer(() => sendInputs.length === 1);
  await flushQueuedPromptDrainer();
  assert.equal(sendInputs.length, 1);
  assert.deepEqual(
    hostInput.agentQueuedPromptRuntime.getSessionSnapshot({
      workspaceId,
      agentSessionId: "session-1"
    }).retryBlock,
    {
      queuedPromptId: "queued-conflict",
      sessionStateUpdatedAtUnixMs: 2,
      conversationUpdatedAtUnixMs: null
    }
  );

  for (const listener of subscribers) {
    listener(snapshot);
  }
  await flushQueuedPromptDrainer();
  assert.equal(sendInputs.length, 1);

  rejectWithActiveTurnConflict = false;
  snapshot = activitySnapshotWithSessions([
    activitySession("session-1", { status: "completed", updatedAtUnixMs: 3 })
  ]);
  for (const listener of subscribers) {
    listener(snapshot);
  }

  await waitForQueuedPromptDrainer(() => sendInputs.length === 2);
  assert.equal(
    hostInput.agentQueuedPromptRuntime.getSessionSnapshot({
      workspaceId,
      agentSessionId: "session-1"
    }).prompts.length,
    0
  );
});

test("desktop agent GUI queued prompt drainer retries when active-turn conflict advances activity during send", async () => {
  const calls: string[] = [];
  const sendInputs: unknown[] = [];
  let snapshot = activitySnapshotWithSessions([
    activitySession("session-1", { status: "completed", updatedAtUnixMs: 2 })
  ]);
  const subscribers = new Set<(snapshot: AgentActivitySnapshot) => void>();
  let rejectWithActiveTurnConflict = true;
  const activityService = {
    ...createWorkspaceAgentActivityService(calls),
    getSnapshot(inputWorkspaceId: string) {
      return { ...snapshot, workspaceId: inputWorkspaceId };
    },
    async sendInput(input) {
      sendInputs.push(input);
      if (rejectWithActiveTurnConflict) {
        rejectWithActiveTurnConflict = false;
        snapshot = activitySnapshotWithSessions([
          activitySession("session-1", {
            status: "created",
            submitAvailability: { state: "available", reason: "" },
            turnLifecycle: { activeTurnId: null, phase: "settled" },
            updatedAtUnixMs: 3
          })
        ]);
        for (const listener of subscribers) {
          listener(snapshot);
        }
        throw new Error("agent session already has an active turn");
      }
      return {
        session: activitySession(input.agentSessionId, {
          status: "working",
          updatedAtUnixMs: 4
        }),
        turnId: "turn-2",
        turnLifecycle: { activeTurnId: "turn-2", phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    },
    subscribe(_workspaceId, listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }
  } satisfies IWorkspaceAgentActivityService;
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });

  hostInput.agentQueuedPromptRuntime.enqueue({
    workspaceId,
    agentSessionId: "session-1",
    prompt: {
      id: "queued-conflict-advanced",
      content: [{ type: "text", text: "retry after send-time activity" }],
      createdAtUnixMs: 1
    }
  });

  await waitForQueuedPromptDrainer(() => sendInputs.length === 2);
  assert.deepEqual(
    hostInput.agentQueuedPromptRuntime.getSessionSnapshot({
      workspaceId,
      agentSessionId: "session-1"
    }).prompts,
    []
  );
});

test("desktop agent GUI queued prompt drainer interrupts active turn for send-next prompts", async () => {
  const calls: string[] = [];
  const sendInputs: unknown[] = [];
  const cancelInputs: unknown[] = [];
  let snapshot = activitySnapshotWithSessions([
    activitySession("session-1", { status: "working", updatedAtUnixMs: 1 })
  ]);
  const subscribers = new Set<(snapshot: AgentActivitySnapshot) => void>();
  const activityService = {
    ...createWorkspaceAgentActivityService(calls),
    getSnapshot(inputWorkspaceId: string) {
      return { ...snapshot, workspaceId: inputWorkspaceId };
    },
    async cancelSession(input) {
      cancelInputs.push(input);
      return {
        canceled: true,
        reason: "active_turn_canceled",
        session: activitySession(input.agentSessionId, {
          status: "canceled",
          updatedAtUnixMs: 2
        })
      };
    },
    async goalControl(input) {
      return {
        goal: null,
        session: activitySession(input.agentSessionId, {
          updatedAtUnixMs: 2
        })
      };
    },
    async sendInput(input) {
      sendInputs.push(input);
      return {
        session: activitySession(input.agentSessionId, {
          status: "working",
          updatedAtUnixMs: 4
        }),
        turnId: "turn-2",
        turnLifecycle: { activeTurnId: "turn-2", phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    },
    subscribe(_workspaceId, listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }
  } satisfies IWorkspaceAgentActivityService;
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: activityService,
    workspaceId
  });

  hostInput.agentQueuedPromptRuntime.enqueue({
    workspaceId,
    agentSessionId: "session-1",
    prompt: {
      id: "queued-send-next",
      content: [{ type: "text", text: "send next after cancel" }],
      createdAtUnixMs: 1
    }
  });
  hostInput.agentQueuedPromptRuntime.promotePrompt({
    workspaceId,
    agentSessionId: "session-1",
    promptId: "queued-send-next"
  });

  await waitForQueuedPromptDrainer(() => cancelInputs.length === 1);
  assert.deepEqual(cancelInputs, [
    { workspaceId, agentSessionId: "session-1" }
  ]);
  assert.equal(sendInputs.length, 0);

  for (const listener of subscribers) {
    listener(snapshot);
  }
  await flushQueuedPromptDrainer();
  assert.equal(cancelInputs.length, 1);
  assert.equal(sendInputs.length, 0);

  snapshot = activitySnapshotWithSessions([
    activitySession("session-1", { status: "completed", updatedAtUnixMs: 3 })
  ]);
  for (const listener of subscribers) {
    listener(snapshot);
  }

  await waitForQueuedPromptDrainer(() => sendInputs.length === 1);
  assert.deepEqual(sendInputs, [
    {
      workspaceId,
      agentSessionId: "session-1",
      content: [{ type: "text", text: "send next after cancel" }],
      displayPrompt: null
    }
  ]);
});

test("desktop agent GUI resolves dropped system files as host-local references", async () => {
  const droppedFileA = new File(["a"], "report.pdf", {
    type: "application/pdf"
  });
  const droppedFileB = new File(["b"], "notes.txt", {
    type: "text/plain"
  });
  const resolvedFiles: File[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi({
      resolveDroppedPaths(files) {
        resolvedFiles.push([...files]);
        return [
          "/Users/local/Downloads/report.pdf",
          "/Users/local/Downloads/notes.txt"
        ];
      }
    }),
    richTextAtService: createRichTextAtService({ providers: [] }),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  assert.deepEqual(
    await hostInput.resolveDroppedFileReferences([droppedFileA, droppedFileB]),
    [
      {
        displayName: "report.pdf",
        hostPath: "/Users/local/Downloads/report.pdf",
        kind: "file",
        path: "/Users/local/Downloads/report.pdf",
        sourceId: "host-local-file"
      },
      {
        displayName: "notes.txt",
        hostPath: "/Users/local/Downloads/notes.txt",
        kind: "file",
        path: "/Users/local/Downloads/notes.txt",
        sourceId: "host-local-file"
      }
    ]
  );
  assert.deepEqual(resolvedFiles, [[droppedFileA, droppedFileB]]);
});

test("desktop agent GUI workbench host input creates the default agent host api", async () => {
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  assert.equal(hostInput.agentHostApi.meta?.workspaceId, workspaceId);
  assert.equal(hostInput.agentHostApi.agentSessions, undefined);
  assert.equal(hostInput.agentHostApi.workspaceAgents, undefined);
  assert.deepEqual(
    await hostInput.workspaceFileReferenceAdapter.listDirectory?.({
      workspaceId
    }),
    {
      directoryPath: "/workspace",
      entries: [],
      rootPath: "/workspace"
    }
  );
});

test("desktop agent GUI workbench host input opens workspace references through the file manager canvas preview first", async () => {
  const calls: string[] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: {
      ...createHostFilesApi(),
      async openFile(workspaceId, path) {
        calls.push(`open-file:${workspaceId}:${path}`);
      }
    },
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceFileManagerService: createWorkspaceFileManagerService({
      async openCanvasFilePreview(workspaceId, target) {
        calls.push(`preview:${workspaceId}:${target.path}:${target.fileKind}`);
        return true;
      }
    }),
    workspaceId
  });

  await hostInput.workspaceFileReferenceAdapter.openReference?.({
    kind: "file",
    path: "/workspace/image.png"
  });

  assert.deepEqual(calls, ["preview:workspace-1:/workspace/image.png:image"]);
});

test("desktop agent GUI workbench host input wires project references first", async () => {
  const projects = [
    userProject("project-1", "/Users/local/repo", "Repo"),
    userProject("project-2", "/Users/local/app", "App")
  ];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceUserProjectService: createWorkspaceUserProjectService(projects),
    workspaceId
  });

  assert.equal(
    (await hostInput.referenceSourceAggregator.listSources({ workspaceId }))[0]
      ?.sourceId,
    USER_PROJECT_REFERENCE_SOURCE_ID
  );
  assert.deepEqual(
    hostInput.resolveWorkspaceReferenceInitialTarget({
      activeConversation: null,
      composerSelectedProjectPath: "/Users/local/app",
      userProjects: projects.map(agentGUIUserProject)
    }),
    {
      sourceId: USER_PROJECT_REFERENCE_SOURCE_ID,
      params: {
        projectId: "project-2",
        projectPath: "/Users/local/app"
      }
    }
  );
});

test("desktop agent GUI workbench host input prefers active conversation project for reference target", () => {
  const project = userProject("project-2", "/Users/local/app", "App");
  const composerProject = userProject("project-1", "/Users/local/repo", "Repo");
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceUserProjectService: createWorkspaceUserProjectService([project]),
    workspaceId
  });

  const input: Parameters<
    typeof hostInput.resolveWorkspaceReferenceInitialTarget
  >[0] = {
    activeConversation: {
      cwd: "/Users/local/app/packages/ui",
      id: "session-1",
      project: agentGUIUserProject(project),
      provider: "codex",
      status: "ready",
      title: "Session",
      updatedAtUnixMs: 1
    },
    composerSelectedProjectPath: "/Users/local/repo",
    userProjects: [
      agentGUIUserProject(composerProject),
      agentGUIUserProject(project)
    ]
  };

  assert.deepEqual(hostInput.resolveWorkspaceReferenceInitialTarget(input), {
    sourceId: USER_PROJECT_REFERENCE_SOURCE_ID,
    params: {
      projectId: "project-2",
      projectPath: "/Users/local/app"
    }
  });
});

test("desktop agent GUI workbench host input ignores stale active conversation project", () => {
  const composerProject = userProject("project-1", "/Users/local/repo", "Repo");
  const staleProject = userProject("project-2", "/Users/local/app", "App");
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceUserProjectService: createWorkspaceUserProjectService([
      composerProject
    ]),
    workspaceId
  });

  assert.deepEqual(
    hostInput.resolveWorkspaceReferenceInitialTarget({
      activeConversation: {
        cwd: "/Users/local/app",
        id: "session-1",
        project: agentGUIUserProject(staleProject),
        provider: "codex",
        status: "ready",
        title: "Session",
        updatedAtUnixMs: 1
      },
      composerSelectedProjectPath: "/Users/local/repo",
      userProjects: [agentGUIUserProject(composerProject)]
    }),
    {
      sourceId: USER_PROJECT_REFERENCE_SOURCE_ID,
      params: {
        projectId: "project-1",
        projectPath: "/Users/local/repo"
      }
    }
  );
});

test("desktop agent GUI workbench host input falls back to local home reference target", () => {
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceUserProjectService: createWorkspaceUserProjectService([]),
    workspaceId
  });

  assert.deepEqual(
    hostInput.resolveWorkspaceReferenceInitialTarget({
      activeConversation: null,
      composerSelectedProjectPath: null,
      userProjects: []
    }),
    {
      sourceId: WORKSPACE_FILE_SOURCE_ID,
      params: {
        locationId: DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID
      }
    }
  );
});

test("desktop agent GUI workbench host input passes an activity runtime backed by the workspace service", () => {
  const agentHostApi = {
    meta: { workspaceId }
  } as unknown as AgentHostInputApi;
  const calls: string[] = [];
  const workspaceAgentActivityService =
    createWorkspaceAgentActivityService(calls);

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService,
    workspaceId
  });

  assert.equal(hostInput.agentHostApi, agentHostApi);
  assert.notEqual(hostInput.agentActivityRuntime, null);
  assert.equal(
    hostInput.agentActivityRuntime?.getSnapshot(workspaceId).workspaceId,
    workspaceId
  );
  assert.deepEqual(calls, [`getSnapshot:${workspaceId}`]);
});

test("desktop agent GUI workbench host input tracks runtime prompt sends", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.sendInput({
    workspaceId,
    agentSessionId: "session-runtime-send-1",
    content: [
      {
        type: "text",
        text: "/review [src/App.tsx](mention://file/src%2FApp.tsx?workspaceId=workspace-1)"
      }
    ]
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.message_sent",
        params: {
          agent_session_id: "session-runtime-send-1",
          conversation_index: 1,
          has_file_mention: true,
          has_slash_command: true,
          is_queued: false,
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks workspace file references", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.trackWorkspaceFileReferences({
    provider: "codex",
    references: [
      {
        displayName: "README.md",
        kind: "file",
        path: "/workspace/README.md"
      },
      {
        displayName: "docs",
        kind: "folder",
        path: "/workspace/docs"
      }
    ]
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.workspace_file_referenced",
        params: {
          has_directory: true,
          provider: "codex",
          reference_count: 2
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks agent provider chat ready", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.trackAgentProviderChatReady({ provider: "codex" });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.chat_ready",
        params: {
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks runtime message stops", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.cancelSession({
    workspaceId,
    agentSessionId: "session-runtime-stop-1"
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.message_stopped",
        params: {
          agent_session_id: "session-runtime-stop-1",
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input skips stopped tracking for no-op cancel", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([], {
      cancelSessionResult: {
        canceled: false,
        reason: "no_active_turn",
        session: {
          ...emptySession(),
          agentSessionId: "session-runtime-stop-1",
          status: "ready"
        }
      }
    }),
    workspaceId
  });

  await hostInput.agentActivityRuntime.cancelSession({
    workspaceId,
    agentSessionId: "session-runtime-stop-1"
  });

  assert.deepEqual(reporterCalls, []);
});

test("desktop agent GUI workbench host input tracks runtime new session activation", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.activateSession({
    workspaceId,
    agentSessionId: "session-runtime-start-1",
    cwd: "/workspace",
    initialContent: [{ type: "text", text: "Track initial prompt" }],
    mode: "new",
    provider: "codex",
    settings: {
      model: "gpt-5",
      permissionModeId: "auto"
    }
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.session_started",
        params: {
          agent_session_id: "session-runtime-start-1",
          has_custom_model: false,
          has_project: true,
          permission_mode: "auto",
          provider: "codex",
          source: "launchpad"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.message_sent",
        params: {
          agent_session_id: "session-runtime-start-1",
          conversation_index: 1,
          has_file_mention: false,
          has_slash_command: false,
          is_queued: false,
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks runtime session pin changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.setSessionPinned({
    workspaceId,
    agentSessionId: "session-runtime-pin-1",
    pinned: true
  });
  await hostInput.agentActivityRuntime.setSessionPinned({
    workspaceId,
    agentSessionId: "session-runtime-pin-1",
    pinned: false
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.conversation_pinned",
        params: {
          agent_session_id: "session-runtime-pin-1",
          provider: "codex"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.conversation_unpinned",
        params: {
          agent_session_id: "session-runtime-pin-1",
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks runtime session settings changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const terminalDiagnostics: Array<
    Parameters<DesktopRuntimeApi["logTerminalDiagnostic"]>[0]
  > = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi({ terminalDiagnostics }),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([], {
      controlStateSettings: {
        model: "gpt-5",
        permissionModeId: "auto",
        reasoningEffort: "medium"
      }
    }),
    workspaceId
  });

  await hostInput.agentActivityRuntime.updateSessionSettings({
    workspaceId,
    agentSessionId: "session-runtime-settings-1",
    settings: {
      model: "custom:local-model",
      permissionModeId: "full-access",
      reasoningEffort: "high"
    }
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.model_changed",
        params: {
          agent_session_id: "session-runtime-settings-1",
          is_custom_model: true,
          provider: "codex"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.permission_mode_changed",
        params: {
          agent_session_id: "session-runtime-settings-1",
          from_mode: "auto",
          provider: "codex",
          to_mode: "full-access"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.reasoning_effort_changed",
        params: {
          agent_session_id: "session-runtime-settings-1",
          from_effort: "medium",
          provider: "codex",
          to_effort: "high"
        }
      }
    ]
  ]);
  assert.deepEqual(terminalDiagnostics, [
    {
      details: {
        agentSessionId: "session-runtime-settings-1",
        changedFields: "model,permissionModeId,reasoningEffort",
        modelFrom: "gpt-5",
        modelTo: "custom:local-model",
        permissionModeIdFrom: "auto",
        permissionModeIdTo: "full-access",
        provider: "codex",
        reasoningEffortFrom: "medium",
        reasoningEffortTo: "high",
        source: "session"
      },
      event: "agent.gui.composer_settings.changed",
      level: "info",
      sessionId: "session-runtime-settings-1",
      workspaceId
    }
  ]);
});

test("desktop agent GUI workbench host input tracks runtime project setting changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.trackSettingsProjectChange?.({
    workspaceId,
    agentSessionId: "session-runtime-project-1",
    action: "select_existing",
    provider: "codex"
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.project_changed",
        params: {
          action: "select_existing",
          agent_session_id: "session-runtime-project-1",
          provider: "codex"
        }
      }
    ]
  ]);
});

test("desktop agent GUI workbench host input tracks draft composer setting changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const terminalDiagnostics: Array<
    Parameters<DesktopRuntimeApi["logTerminalDiagnostic"]>[0]
  > = [];
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi({ terminalDiagnostics }),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  await hostInput.agentActivityRuntime.trackDraftComposerSettingsChange?.({
    workspaceId,
    provider: "codex",
    previousSettings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "low"
    },
    nextSettings: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "high"
    }
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.settings.reasoning_effort_changed",
        params: {
          agent_session_id: null,
          from_effort: "low",
          provider: "codex",
          to_effort: "high"
        }
      }
    ]
  ]);
  assert.deepEqual(terminalDiagnostics, [
    {
      details: {
        agentSessionId: null,
        changedFields: "reasoningEffort",
        provider: "codex",
        reasoningEffortFrom: "low",
        reasoningEffortTo: "high",
        source: "draft"
      },
      event: "agent.gui.composer_settings.changed",
      level: "info",
      sessionId: undefined,
      workspaceId
    }
  ]);
});

test("desktop agent GUI workbench host input wires runtime control-state reads through the workspace activity service", async () => {
  const calls: string[] = [];
  const workspaceAgentActivityService =
    createWorkspaceAgentActivityService(calls);

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService,
    workspaceId
  });

  assert.deepEqual(
    await hostInput.agentActivityRuntime.getSessionControlState({
      workspaceId,
      agentSessionId: "session-1"
    }),
    {
      workspaceId,
      agentSessionId: "session-1",
      provider: "codex",
      status: "ready",
      updatedAtUnixMs: 1
    }
  );
  assert.deepEqual(calls, ["getSessionControlState:workspace-1:session-1"]);
});

test("desktop agent GUI workbench host input wires runtime composer options through the workspace activity service", async () => {
  const calls: string[] = [];
  const workspaceAgentActivityService =
    createWorkspaceAgentActivityService(calls);

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService,
    workspaceId
  });

  assert.deepEqual(
    await hostInput.agentActivityRuntime.getComposerOptions({
      workspaceId,
      agentTargetId: "local:codex",
      provider: "codex",
      settings: { model: "gpt-5" }
    }),
    {
      provider: "codex",
      effectiveSettings: { model: "gpt-5" }
    }
  );
  assert.deepEqual(calls, ["getComposerOptions:workspace-1:codex:local:codex"]);
});

test("desktop agent GUI workbench host input wires runtime activation through the workspace activity service", async () => {
  const calls: string[] = [];
  const workspaceAgentActivityService =
    createWorkspaceAgentActivityService(calls);

  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService,
    workspaceId
  });

  assert.deepEqual(
    await hostInput.agentActivityRuntime.activateSession({
      workspaceId,
      agentSessionId: "session-1",
      mode: "existing"
    }),
    {
      activation: { mode: "existing", status: "already_attached" },
      session: {
        agentSessionId: "session-1",
        createdAtUnixMs: 1,
        cwd: "/workspace",
        provider: "codex",
        providerSessionId: "session-1",
        resumable: false,
        status: "ready",
        updatedAtUnixMs: 1,
        workspaceId
      }
    }
  );
  assert.deepEqual(calls, ["activateSession:workspace-1:session-1:existing"]);
});

test("desktop agent GUI workbench host input forwards OpenClaw warmup through the runtime", async () => {
  const warmupOpenclawGateway = async () => ({
    accepted: true,
    ready: true
  });
  const hostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentHostApi: {
      meta: { workspaceId },
      runtime: {
        warmupOpenclawGateway
      }
    } as unknown as AgentHostInputApi,
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: createPlatformApi(),
    richTextAtService: createRichTextAtService(),
    runtimeApi: createRuntimeApi(),
    workspaceAgentActivityService: createWorkspaceAgentActivityService([]),
    workspaceId
  });

  assert.deepEqual(
    await hostInput.agentActivityRuntime.warmupOpenclawGateway?.({
      workspaceId
    }),
    {
      accepted: true,
      ready: true
    }
  );
});

function createRichTextTriggerProvider(id: string): RichTextTriggerProvider {
  return {
    id,
    trigger: "@",
    getItemKey: () => "item-1",
    getItemLabel: () => "Item",
    query: () => [],
    toInsertResult: () => ({ kind: "text", text: "Item" })
  };
}

function createRichTextAtService(
  input: {
    providers?: readonly RichTextTriggerProvider[];
    requests?: unknown[];
  } = {}
): IDesktopRichTextAtService {
  return {
    _serviceBrand: undefined,
    getProviders(request) {
      input.requests?.push(request);
      return input.providers ?? [];
    }
  };
}

function createHostFilesApi(): DesktopHostFilesApi {
  return {
    async createUserDocumentsProjectDirectory(input) {
      return { path: `/Users/local/Documents/tutti/${input.name}` };
    },
    async openExternal() {},
    async openFile() {},
    async revealInFolder() {},
    async revealWorkspaceFile() {},
    async openTerminalLink() {},
    async readLocalFileText(path) {
      return { content: "", name: "", path };
    },
    async readLocalPreviewFile() {
      return new Uint8Array();
    },
    async archiveAgentPromptFile(input) {
      return {
        name: input.displayName ?? "attachment",
        path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/report.pdf",
        sizeBytes: 10
      };
    },
    async readPreviewFile() {
      return new Uint8Array();
    },
    async selectAppArchive() {
      return null;
    },
    async selectAppArchiveExportPath() {
      return null;
    },
    async selectAppIconImage() {
      return null;
    },
    async selectDirectory() {
      return null;
    },
    async selectUploadFiles() {
      return [];
    },
    async copyImageToClipboard() {},
    async copyFilesToClipboard() {},
    async listOpenWithApplications() {
      return [];
    },
    async openFileWithApplication() {},
    async openFileWithOtherApplication() {},
    async openFileInBrowser() {},
    async resolveWorkspaceFileFileUrl() {
      return "file:///tmp/example.html";
    },
    async resolveEntryIcon() {
      return null;
    }
  };
}

function createTuttidClient(): TuttidClient {
  return {
    async checkUserProjectPath(
      request: Parameters<TuttidClient["checkUserProjectPath"]>[0]
    ) {
      return {
        exists: true,
        isDirectory: true,
        path: request.path
      };
    },
    async getAgentProviderComposerOptions(
      provider: Parameters<TuttidClient["getAgentProviderComposerOptions"]>[0],
      request: Parameters<TuttidClient["getAgentProviderComposerOptions"]>[1]
    ) {
      const settings = request?.settings ?? {};
      return {
        effectiveSettings: settings,
        modelConfig: {
          configurable: true,
          currentValue: settings.model ?? undefined,
          defaultValue: settings.model ?? undefined,
          options: settings.model
            ? [
                {
                  id: settings.model,
                  label: settings.model,
                  value: settings.model
                }
              ]
            : []
        },
        permissionConfig: {
          configurable: true,
          defaultValue: settings.permissionModeId ?? undefined,
          modes: settings.permissionModeId
            ? [
                {
                  id: settings.permissionModeId,
                  label: settings.permissionModeId,
                  semantic: "auto"
                }
              ]
            : []
        },
        provider,
        reasoningConfig: {
          configurable: true,
          currentValue: settings.reasoningEffort ?? undefined,
          defaultValue: settings.reasoningEffort ?? undefined,
          options: settings.reasoningEffort
            ? [
                {
                  id: settings.reasoningEffort,
                  label: settings.reasoningEffort,
                  value: settings.reasoningEffort
                }
              ]
            : []
        },
        runtimeContext: {},
        skills: []
      };
    },
    async getWorkspaceFileTreeSnapshot() {
      return {
        budgetExceeded: false,
        directory: {
          directoryPath: "/workspace",
          entries: [],
          prefetchState: "loaded"
        },
        prefetchBudgetMs: 500,
        prefetchDepth: 4,
        root: "/workspace"
      };
    },
    async listWorkspaceFileDirectory() {
      return {
        directoryPath: "/workspace",
        entries: [],
        root: "/workspace",
        workspaceId
      };
    },
    async listUserProjects() {
      return { projects: [] };
    },
    async useUserProject(
      request: Parameters<TuttidClient["useUserProject"]>[0]
    ) {
      return {
        createdAtUnixMs: 1,
        id: "project-1",
        label: "Project",
        path: request.path,
        updatedAtUnixMs: 1
      };
    },
    async writeWorkspaceFileText(
      workspaceId: string,
      request: Parameters<TuttidClient["writeWorkspaceFileText"]>[1]
    ) {
      return {
        entry: {
          hasChildren: false,
          kind: "file",
          mtimeMs: null,
          name: request.path.split("/").filter(Boolean).at(-1) ?? "",
          path: request.path,
          sizeBytes: request.content.length
        },
        root: "/workspace",
        workspaceId
      };
    }
  } as unknown as TuttidClient;
}

function createPlatformApi(
  overrides: Partial<
    Pick<
      DesktopPlatformApi,
      "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
    >
  > = {}
): Pick<
  DesktopPlatformApi,
  "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
> {
  return {
    homeDirectory: "/Users/local",
    os: "darwin",
    resolveDroppedEntries() {
      return [];
    },
    resolveDroppedPaths() {
      return [];
    },
    ...overrides
  };
}

function createWorkspaceFileManagerService(input: {
  openCanvasFilePreview: IWorkspaceFileManagerService["openCanvasFilePreview"];
}): Pick<
  IWorkspaceFileManagerService,
  "openCanvasFilePreview" | "resolveEntryIconUrl"
> {
  return {
    openCanvasFilePreview: input.openCanvasFilePreview,
    resolveEntryIconUrl: async () => null
  };
}

function createRuntimeApi(
  input: {
    terminalDiagnostics?: Array<
      Parameters<DesktopRuntimeApi["logTerminalDiagnostic"]>[0]
    >;
  } = {}
): DesktopRuntimeApi {
  return {
    async getBackendConfig() {
      return {
        accessToken: "token-1",
        baseUrl: "http://127.0.0.1:4000"
      };
    },
    async getBusinessEventStreamUrl() {
      return "ws://127.0.0.1:4000/v1/events/ws?access_token=token-1";
    },
    async listWorkspaceAgentProbes(probeInput) {
      return {
        capturedAtUnixMs: 1,
        providers: [],
        workspaceId: probeInput.workspaceId
      };
    },
    async getTerminalStreamUrl(input) {
      return `ws://127.0.0.1:4000/${input.workspaceId}/${input.sessionId}`;
    },
    async logRendererDiagnostic() {},
    async logTerminalDiagnostic(payload) {
      input.terminalDiagnostics?.push(payload);
    }
  };
}

function userProject(
  id: string,
  path: string,
  label: string
): WorkspaceUserProject {
  return {
    createdAtUnixMs: 1,
    id,
    label,
    path,
    updatedAtUnixMs: 1
  };
}

function agentGUIUserProject(project: WorkspaceUserProject): {
  createdAtUnixMs?: number;
  id: string;
  label: string;
  lastUsedAtUnixMs?: number;
  path: string;
  updatedAtUnixMs?: number;
} {
  return {
    ...(project.createdAtUnixMs === undefined
      ? {}
      : { createdAtUnixMs: project.createdAtUnixMs }),
    id: project.id,
    label: project.label,
    ...(typeof project.lastUsedAtUnixMs === "number"
      ? { lastUsedAtUnixMs: project.lastUsedAtUnixMs }
      : {}),
    path: project.path,
    ...(project.updatedAtUnixMs === undefined
      ? {}
      : { updatedAtUnixMs: project.updatedAtUnixMs })
  };
}

function createWorkspaceUserProjectService(
  projects: WorkspaceUserProject[]
): IWorkspaceUserProjectService {
  return {
    _serviceBrand: undefined,
    async checkProjectPath(path) {
      return { exists: true, isDirectory: true, path };
    },
    async createProject(name) {
      return userProject("created", `/Users/local/${name}`, name);
    },
    async ensureLoaded() {},
    async getDefaultSelection() {
      return null;
    },
    getRevision() {
      return 1;
    },
    getSnapshot() {
      return {
        error: null,
        initialized: true,
        isLoading: false,
        projects,
        revision: 1
      };
    },
    isNoProjectPath() {
      return false;
    },
    rememberNoProjectPath() {},
    async prepareSelection() {
      return {
        isSelectedPathMissing: false,
        projects,
        selection: { kind: "none" }
      };
    },
    async refresh() {},
    async registerProjectPath(path) {
      return userProject("registered", path, "Registered");
    },
    async removeProjectPath() {},
    async rememberDefaultSelection() {},
    async selectDirectory() {
      return null;
    },
    store: {
      error: null,
      initialized: true,
      isLoading: false,
      projects,
      revision: 1
    } as IWorkspaceUserProjectService["store"],
    subscribe() {
      return () => {};
    }
  };
}

function createWorkspaceAgentActivityService(
  calls: string[],
  options: {
    cancelSessionResult?: Awaited<
      ReturnType<IWorkspaceAgentActivityService["cancelSession"]>
    >;
    controlStateSettings?: {
      model?: string | null;
      permissionModeId?: string | null;
      reasoningEffort?: string | null;
    };
  } = {}
): IWorkspaceAgentActivityService {
  const snapshot: AgentActivitySnapshot = {
    workspaceId,
    presences: [],
    sessions: [],
    sessionMessagesById: {}
  };
  return {
    _serviceBrand: undefined,
    async activateSession(input) {
      calls.push(
        `activateSession:${input.workspaceId}:${input.agentSessionId}:${input.mode}`
      );
      return {
        activation: {
          mode: input.mode,
          status: input.mode === "existing" ? "already_attached" : "attached"
        },
        session: {
          agentSessionId: input.agentSessionId,
          createdAtUnixMs: 1,
          workspaceId: input.workspaceId,
          provider: "codex",
          providerSessionId: input.agentSessionId,
          status: "ready",
          resumable: false,
          cwd: "/workspace",
          updatedAtUnixMs: 1
        }
      };
    },
    async cancelSession(input) {
      if (options.cancelSessionResult) {
        return {
          ...options.cancelSessionResult,
          session: {
            ...options.cancelSessionResult.session,
            agentSessionId: input.agentSessionId
          }
        };
      }
      return {
        canceled: true,
        reason: "active_turn_canceled",
        session: {
          ...emptySession(),
          agentSessionId: input.agentSessionId,
          status: "canceled"
        }
      };
    },
    async goalControl(input) {
      return {
        goal: null,
        session: {
          ...emptySession(),
          agentSessionId: input.agentSessionId
        }
      };
    },
    async createSession(input) {
      return {
        ...emptySession(),
        agentSessionId: input.agentSessionId ?? "session-1",
        provider: input.provider
      };
    },
    async deleteSession() {
      return { removed: true };
    },
    async getComposerOptions(input) {
      calls.push(
        `getComposerOptions:${input.workspaceId}:${input.provider ?? ""}:${input.agentTargetId ?? ""}`
      );
      return {
        effectiveSettings: input.settings ?? {},
        provider: input.provider ?? "codex"
      };
    },
    async updateSessionSettings(input) {
      calls.push(
        `updateSessionSettings:${input.workspaceId}:${input.agentSessionId}`
      );
      return {
        agentSessionId: input.agentSessionId,
        settings: input.settings
      };
    },
    async getSession(_workspaceId, agentSessionId) {
      return { ...emptySession(), agentSessionId };
    },
    async getSessionControlState(input) {
      calls.push(
        `getSessionControlState:${input.workspaceId}:${input.agentSessionId}`
      );
      return {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        provider: "codex",
        ...(options.controlStateSettings
          ? { settings: options.controlStateSettings }
          : {}),
        status: "ready",
        updatedAtUnixMs: 1
      };
    },
    getSnapshot(inputWorkspaceId) {
      calls.push(`getSnapshot:${inputWorkspaceId}`);
      return { ...snapshot, workspaceId: inputWorkspaceId };
    },
    async listSessionMessages() {
      return { messages: [], hasMore: false, latestVersion: 0 };
    },
    async listAgentGeneratedFiles() {
      return { entries: [], workspaceId };
    },
    async listSessionsPage(input) {
      return { hasMore: false, sessions: [], workspaceId: input.workspaceId };
    },
    async listSessionSections(input) {
      return { sections: [], workspaceId: input.workspaceId };
    },
    async listSessionSectionPage(input) {
      return {
        kind: "conversations",
        sectionKey: input.sectionKey,
        sessions: [],
        hasMore: false
      };
    },
    async scanExternalSessionImports() {
      throw new Error("not implemented");
    },
    async importExternalSessions() {
      throw new Error("not implemented");
    },
    async load(inputWorkspaceId) {
      return { ...snapshot, workspaceId: inputWorkspaceId };
    },
    onSessionEvent() {
      return () => {};
    },
    onModelCatalogInvalidated() {
      return () => {};
    },
    ensureSessionSynchronized() {
      return () => {};
    },
    retainSessionEvents() {
      return () => {};
    },
    async sendInput(input) {
      return {
        session: {
          ...emptySession(),
          agentSessionId: input.agentSessionId,
          status: "working"
        },
        turnId: "turn-1",
        turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    },
    async readSessionAttachment(input) {
      return {
        attachmentId: input.attachmentId,
        mimeType: "image/png",
        data: ""
      };
    },
    async setSessionPinned(input) {
      return {
        ...emptySession(),
        agentSessionId: input.agentSessionId,
        pinnedAtUnixMs: input.pinned ? 1 : null
      };
    },
    async submitInteractive() {
      return {};
    },
    async submitPlanDecision() {},
    subscribe() {
      return () => {};
    },
    async unactivateSession(input) {
      calls.push(
        `unactivateSession:${input.workspaceId}:${input.agentSessionId}`
      );
      return {
        agentSessionId: input.agentSessionId,
        buffered: false
      };
    }
  };
}

function activitySnapshotWithSessions(
  sessions: AgentActivitySnapshot["sessions"]
): AgentActivitySnapshot {
  return {
    workspaceId,
    presences: [],
    sessions,
    sessionMessagesById: {}
  };
}

function activitySession(
  agentSessionId: string,
  overrides: Partial<AgentActivitySnapshot["sessions"][number]> = {}
): AgentActivitySnapshot["sessions"][number] {
  return {
    ...emptySession(),
    agentSessionId,
    ...overrides
  };
}

async function flushQueuedPromptDrainer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForQueuedPromptDrainer(
  condition: () => boolean
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > 1000) {
      assert.fail("Timed out waiting for queued prompt drainer.");
    }
    await flushQueuedPromptDrainer();
  }
}

function emptySession(): AgentActivitySnapshot["sessions"][number] {
  return {
    workspaceId,
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/workspace",
    title: "Session",
    status: "working",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1
  };
}
