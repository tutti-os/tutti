import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentHostInputApi,
  AgentHostQuickPromptsApi
} from "@tutti-os/agent-gui";
import type {
  AgentTargetSetupSnapshot,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type {
  DesktopClipboardImagePayload,
  DesktopTerminalDiagnosticPayload,
  DesktopTerminalStreamUrlRequest
} from "@shared/contracts/ipc";
import {
  createDesktopAgentHostApi,
  projectDesktopAgentTargetSetupSnapshot
} from "./createDesktopAgentHostApi.ts";
import { WorkspaceAgentActivityService } from "./internal/workspaceAgentActivityService.ts";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import { registerWorkspaceTerminalLoginLaunchHandler } from "./workspaceTerminalLoginLaunchCoordinator.ts";

const workspaceId = "workspace-1";

test("desktop agent host api projects the optional quick prompts capability", () => {
  const quickPrompts = {} as AgentHostQuickPromptsApi;
  const api = createAgentHostApi({ agentQuickPromptService: quickPrompts });

  assert.equal(api.quickPrompts, quickPrompts);
});

test("desktop agent host api routes terminal login through the launch coordinator", async () => {
  const api = createAgentHostApi();
  const closeCalls: string[] = [];
  const requests: Array<{
    command: string;
    cwd?: string;
    workspaceId: string;
  }> = [];
  const unregister = registerWorkspaceTerminalLoginLaunchHandler(
    workspaceId,
    async (request) => {
      requests.push(request);
      return {
        close: () => {
          closeCalls.push("close");
        }
      };
    }
  );
  try {
    const handle = await api.terminalLogin?.run({
      command: "/opt/kimi/bin/kimi login"
    });
    assert.deepEqual(requests, [
      { command: "/opt/kimi/bin/kimi login", cwd: undefined, workspaceId }
    ]);
    handle?.close();
    assert.deepEqual(closeCalls, ["close"]);
  } finally {
    unregister();
  }

  await assert.rejects(
    () =>
      api.terminalLogin?.run({ command: "/opt/kimi/bin/kimi login" }) ??
      Promise.reject(new Error("missing terminalLogin")),
    /Terminal login is unavailable/
  );
});

type DesktopAgentHostApiUnderTest = AgentHostInputApi & {
  persistence: NonNullable<AgentHostInputApi["persistence"]>;
  userProjects: NonNullable<AgentHostInputApi["userProjects"]>;
};

test("desktop agent host api forwards model catalog and target defaults invalidation as host events", async () => {
  const topicHandlers = new Map<string, (event: unknown) => void>();
  const tuttidClient = createTuttidClient();
  const activityService = new WorkspaceAgentActivityService({
    eventStreamClient: {
      connect: async () => {},
      dispose: () => {},
      publishIntent: async () => {},
      subscribe: (topic: string, listener: (event: unknown) => void) => {
        topicHandlers.set(topic, listener);
        return () => {};
      },
      subscribeConnectionState: () => () => {}
    } as never,
    tuttidClient,
    runtimeApi: createRuntimeApi()
  });
  const api = createAgentHostApi({
    tuttidClient,
    workspaceAgentActivityService: activityService
  }) as unknown as {
    onHostEvent?: (listener: (event: unknown) => void) => () => void;
  };

  // The stream subscription starts with the first workspace controller.
  await activityService.getComposerOptions({
    agentTargetId: "local:codex",
    provider: "codex",
    workspaceId
  });
  const invalidationHandler = topicHandlers.get(
    "agent.model.catalog.invalidated"
  );
  assert.ok(invalidationHandler, "expected model catalog topic subscription");

  const hostEvents: unknown[] = [];
  const unsubscribe = api.onHostEvent?.((event) => {
    hostEvents.push(event);
  });
  invalidationHandler({
    payload: { providers: ["codex", "claude-code"], occurredAtUnixMs: 4200 }
  });

  assert.deepEqual(hostEvents, [
    {
      scope: "global",
      type: "agent-model-catalog-invalidated",
      providers: ["codex", "claude-code"],
      occurredAtUnixMs: 4200
    }
  ]);
  const defaultsInvalidationHandler = topicHandlers.get(
    "preferences.agent.composer.defaults.changed"
  );
  assert.ok(
    defaultsInvalidationHandler,
    "expected target defaults topic subscription"
  );
  defaultsInvalidationHandler({
    payload: { agentTargetId: "local:codex" }
  });
  assert.deepEqual(hostEvents.at(-1), {
    agentTargetId: "local:codex",
    scope: "global",
    type: "agent-composer-defaults-invalidated"
  });
  unsubscribe?.();
  invalidationHandler({
    payload: { providers: ["codex"], occurredAtUnixMs: 4300 }
  });
  assert.equal(hostEvents.length, 2);
});

test("desktop agent host api writes images through the host clipboard", async () => {
  const copiedImages: DesktopClipboardImagePayload[] = [];
  const api = createAgentHostApi({
    hostFilesApi: createHostFilesApi({
      async copyImageToClipboard(input) {
        copiedImages.push(input);
      }
    })
  });

  await api.clipboard.writeImage?.({
    data: "cG5n",
    mimeType: "image/png"
  });

  assert.deepEqual(copiedImages, [{ data: "cG5n", mimeType: "image/png" }]);
});

test("desktop agent host api does not inject legacy agent data host apis", () => {
  const api = createAgentHostApi();

  assert.equal(api.agentSessions, undefined);
  assert.equal("workspaceAgents" in api, false);
});

test("desktop agent host api reuses one target setup watch per target", () => {
  const api = createAgentHostApi();
  const setup = api.agentTargetSetup;
  assert.ok(setup);

  const first = setup.watch({ agentTargetId: "extension:gemini" });
  const same = setup.watch({ agentTargetId: " extension:gemini " });
  const other = setup.watch({ agentTargetId: "extension:codebuddy" });

  assert.equal(first, same);
  assert.notEqual(first, other);
});

test("desktop agent host api explicitly projects daemon target setup snapshots", () => {
  const snapshot: AgentTargetSetupSnapshot = {
    workspaceId: "workspace-transport-only",
    agentTargetId: "extension:gemini",
    status: "installing",
    runtimeSource: "managed",
    runtimeVersion: "1.2.3",
    reason: "runtime update required",
    authMethods: [
      {
        id: "oauth-personal",
        name: "Log in with Google",
        description: "Personal account"
      },
      {
        id: "login",
        name: "Login with Kimi account",
        type: "terminal",
        terminalCommand: "/opt/kimi-code/bin/kimi login"
      }
    ],
    account: {
      id: "account-1",
      displayName: "Rhinoc",
      authMethodId: "oauth-personal",
      organization: "Tutti"
    },
    plan: {
      agentTargetId: "extension:gemini",
      extensionInstallationId: "gemini-installation",
      agentKey: "gemini",
      extensionVersion: "2.0.0",
      runtimeKind: "standard-acp",
      platform: "darwin-arm64",
      runner: "binary",
      packageName: "grok-0.2.103-macos-aarch64",
      packageVersion: "1.2.3",
      installRoot: "/state/runtimes/gemini/1.2.3",
      installCommand: ["download", "https://example.com/grok"],
      executable: "grok",
      launchArgs: ["agent", "stdio"],
      planDigest: "a".repeat(64)
    },
    action: {
      actionId: "action-1",
      clientActionId: "client-action-1",
      kind: "install",
      status: "running",
      phase: "installing",
      errorCode: null,
      errorMessage: null,
      createdAtUnixMs: 100,
      updatedAtUnixMs: 200
    }
  };

  assert.deepEqual(projectDesktopAgentTargetSetupSnapshot(snapshot), {
    agentTargetId: "extension:gemini",
    status: "installing",
    runtimeSource: "managed",
    runtimeVersion: "1.2.3",
    reason: "runtime update required",
    authMethods: [
      {
        id: "oauth-personal",
        name: "Log in with Google",
        description: "Personal account",
        type: null,
        terminalCommand: null
      },
      {
        id: "login",
        name: "Login with Kimi account",
        description: null,
        type: "terminal",
        terminalCommand: "/opt/kimi-code/bin/kimi login"
      }
    ],
    account: {
      id: "account-1",
      displayName: "Rhinoc",
      authMethodId: "oauth-personal",
      organization: "Tutti"
    },
    plan: {
      packageName: "grok-0.2.103-macos-aarch64",
      packageVersion: "1.2.3",
      runner: "binary",
      planDigest: "a".repeat(64),
      installRoot: "/state/runtimes/gemini/1.2.3"
    },
    action: {
      actionId: "action-1",
      clientActionId: "client-action-1",
      kind: "install",
      status: "running",
      phase: "installing",
      errorCode: null,
      errorMessage: null
    }
  });
});

test("desktop agent host api remembers the default project selection per workspace", async () => {
  const projectSelectionWorkspaceId = "workspace-project-selection-host-api";
  const firstApi = createAgentHostApi({
    workspaceId: projectSelectionWorkspaceId
  });

  assert.equal(await firstApi.userProjects.getDefaultSelection?.(), null);

  await firstApi.userProjects.rememberDefaultSelection?.({ path: null });
  assert.deepEqual(await firstApi.userProjects.getDefaultSelection?.(), {
    path: null
  });

  const secondApi = createAgentHostApi({
    workspaceId: projectSelectionWorkspaceId
  });
  assert.deepEqual(await secondApi.userProjects.getDefaultSelection?.(), {
    path: null
  });

  await secondApi.userProjects.use({ path: "/workspace/tutti" });
  assert.deepEqual(await firstApi.userProjects.getDefaultSelection?.(), {
    path: "/workspace/tutti"
  });
});

test("desktop agent host api delegates user project calls to the workspace user project service", async () => {
  const calls: Array<{ input?: unknown; method: string }> = [];
  const store = {
    error: null,
    initialized: true,
    isLoading: false,
    projects: [
      {
        createdAtUnixMs: 1,
        id: "project-listed",
        label: "Listed",
        lastUsedAtUnixMs: null,
        path: "/workspace/listed",
        pinnedAtUnixMs: 10,
        updatedAtUnixMs: 1
      }
    ],
    revision: 1
  } as IWorkspaceUserProjectService["store"];
  const workspaceUserProjectService: IWorkspaceUserProjectService = {
    _serviceBrand: undefined,
    store,
    async checkProjectPath(path) {
      calls.push({ input: path, method: "checkProjectPath" });
      return {
        exists: true,
        isDirectory: true,
        path
      };
    },
    async createProject(name) {
      calls.push({ input: name, method: "createProject" });
      return {
        id: "project-created",
        label: name,
        lastUsedAtUnixMs: null,
        path: `/workspace/${name}`,
        pinnedAtUnixMs: 0
      };
    },
    async ensureLoaded() {
      calls.push({ method: "ensureLoaded" });
    },
    async prepareSelection(input) {
      calls.push({ input, method: "prepareSelection" });
      return {
        isSelectedPathMissing: false,
        projects: store.projects,
        selection: { kind: "none" as const }
      };
    },
    async getDefaultSelection() {
      calls.push({ method: "getDefaultSelection" });
      return { path: "/workspace/listed" };
    },
    getRevision() {
      return store.revision;
    },
    getSnapshot() {
      return store;
    },
    isNoProjectPath(path) {
      calls.push({ input: path, method: "isNoProjectPath" });
      return path.includes("session-");
    },
    async moveProject(input) {
      calls.push({ input, method: "moveProject" });
    },
    async pinProject(input) {
      calls.push({ input, method: "pinProject" });
    },
    rememberNoProjectPath(path) {
      calls.push({ input: path, method: "rememberNoProjectPath" });
    },
    async refresh() {
      calls.push({ method: "refresh" });
    },
    async registerProjectPath(path) {
      calls.push({ input: path, method: "registerProjectPath" });
      return {
        id: "project-used",
        label: "Used",
        path,
        pinnedAtUnixMs: 0
      };
    },
    async removeProjectPath(path) {
      calls.push({ input: path, method: "removeProjectPath" });
    },
    async rememberDefaultSelection(input) {
      calls.push({ input, method: "rememberDefaultSelection" });
    },
    async selectDirectory() {
      calls.push({ method: "selectDirectory" });
      return { path: "/workspace/listed" };
    },
    subscribe(listener) {
      calls.push({ input: listener, method: "subscribe" });
      return () => {
        calls.push({ method: "unsubscribe" });
      };
    }
  };
  const api = createAgentHostApi({
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        throw new Error("userProjects.list should use the service");
      },
      async useUserProject() {
        throw new Error("userProjects.use should use the service");
      }
    }),
    workspaceUserProjectService
  });

  const listResult = await api.userProjects.list();
  const created = await api.userProjects.create?.({ name: "created" });
  const used = await api.userProjects.use({ path: "/workspace/used" });
  const prepared = await api.userProjects.prepareSelection?.({
    projectLocked: true,
    selectedPath: "/workspace/listed"
  });
  await api.userProjects.move?.({
    beforeProjectId: "project-listed",
    projectId: "project-used"
  });
  await api.userProjects.pin({ pinned: true, projectId: "project-listed" });
  await api.userProjects.remove?.({ path: "/workspace/listed" });
  const listener = () => {};
  const unsubscribe = api.userProjects.subscribe?.(listener);
  unsubscribe?.();

  assert.deepEqual(listResult, {
    projects: [
      {
        createdAtUnixMs: 1,
        id: "project-listed",
        label: "Listed",
        path: "/workspace/listed",
        pinnedAtUnixMs: 10,
        updatedAtUnixMs: 1
      }
    ]
  });
  assert.equal("lastUsedAtUnixMs" in listResult.projects[0]!, false);
  assert.deepEqual(created, {
    id: "project-created",
    label: "created",
    path: "/workspace/created",
    pinnedAtUnixMs: 0
  });
  assert.equal("lastUsedAtUnixMs" in created!, false);
  assert.deepEqual(used, {
    id: "project-used",
    label: "Used",
    path: "/workspace/used",
    pinnedAtUnixMs: 0
  });
  assert.deepEqual(prepared, {
    isSelectedPathMissing: false,
    projects: [
      {
        createdAtUnixMs: 1,
        id: "project-listed",
        label: "Listed",
        path: "/workspace/listed",
        pinnedAtUnixMs: 10,
        updatedAtUnixMs: 1
      }
    ],
    selection: { kind: "none" }
  });
  assert.deepEqual(await api.userProjects.checkPath?.({ path: "/workspace" }), {
    exists: true,
    isDirectory: true,
    path: "/workspace"
  });
  assert.deepEqual(await api.userProjects.getDefaultSelection?.(), {
    path: "/workspace/listed"
  });
  await api.userProjects.rememberDefaultSelection?.({ path: null });
  assert.equal(
    api.userProjects.isNoProjectPath?.({ path: "/workspace/session-1" }),
    true
  );
  assert.deepEqual(calls, [
    { method: "ensureLoaded" },
    { input: "created", method: "createProject" },
    { input: "/workspace/used", method: "registerProjectPath" },
    {
      input: {
        projectLocked: true,
        selectedPath: "/workspace/listed"
      },
      method: "prepareSelection"
    },
    {
      input: {
        beforeProjectId: "project-listed",
        projectId: "project-used"
      },
      method: "moveProject"
    },
    {
      input: { pinned: true, projectId: "project-listed" },
      method: "pinProject"
    },
    { input: "/workspace/listed", method: "removeProjectPath" },
    { input: listener, method: "subscribe" },
    { method: "unsubscribe" },
    { input: "/workspace", method: "checkProjectPath" },
    { method: "getDefaultSelection" },
    { input: { path: null }, method: "rememberDefaultSelection" },
    { input: "/workspace/session-1", method: "isNoProjectPath" }
  ]);
});

test("desktop agent host api reuses desktop host file operations", async () => {
  const usedProjectPaths: string[] = [];
  const writtenFiles: Array<{
    content: string;
    path: string;
    workspaceId: string;
  }> = [];
  const appliedPatches: Array<{
    diff: string;
    revert?: boolean;
    workspaceId: string;
  }> = [];
  const resolvedPatchSupport: Array<{
    cwd: string;
    workspaceId: string;
  }> = [];
  const selectedUploadFileInputs: unknown[] = [];
  const api = createAgentHostApi({
    hostFilesApi: createHostFilesApi({
      async createUserDocumentsProjectDirectory(input) {
        assert.deepEqual(input, { name: "Demo project" });
        return { path: "/Users/local/Documents/tutti/Demo project" };
      },
      async readPreviewFile(requestWorkspaceId, path) {
        assert.equal(requestWorkspaceId, workspaceId);
        assert.equal(path, "/workspace/file.txt");
        return new TextEncoder().encode("hello");
      },
      async readLocalFileText(path) {
        assert.equal(path, "/tmp/prompt.md");
        return {
          content: "prompt",
          name: "prompt.md",
          path
        };
      },
      async selectDirectory() {
        return "/workspace";
      },
      async selectUploadFiles(input) {
        selectedUploadFileInputs.push(input);
        return ["/tmp/a.txt", "/tmp/b.txt"];
      }
    }),
    tuttidClient: createTuttidClient({
      async checkUserProjectPath(payload) {
        return {
          exists: true,
          isDirectory: true,
          path: payload.path
        };
      },
      async useUserProject(payload) {
        usedProjectPaths.push(payload.path);
        return {
          createdAtUnixMs: 1,
          id: "project-1",
          label: "Demo project",
          lastUsedAtUnixMs: 1,
          path: payload.path,
          pinnedAtUnixMs: 0,
          sectionKey: `project:${payload.path}`,
          updatedAtUnixMs: 1
        };
      },
      async writeWorkspaceFileText(requestWorkspaceId, request) {
        writtenFiles.push({
          content: request.content,
          path: request.path,
          workspaceId: requestWorkspaceId
        });
        return {
          entry: {
            createdTimeMs: null,
            hasChildren: false,
            kind: "file",
            lastOpenedMs: null,
            mtimeMs: null,
            name: request.path.split("/").filter(Boolean).at(-1) ?? "",
            path: request.path,
            sizeBytes: request.content.length
          },
          root: "/workspace",
          workspaceId: requestWorkspaceId
        };
      },
      async applyWorkspaceGitPatch(requestWorkspaceId, request) {
        appliedPatches.push({
          diff: request.diff,
          revert: request.revert,
          workspaceId: requestWorkspaceId
        });
        return {
          appliedPaths: ["src/app.ts"],
          conflictedPaths: [],
          skippedPaths: [],
          status: "success"
        };
      },
      async resolveWorkspaceGitPatchSupport(requestWorkspaceId, cwd) {
        resolvedPatchSupport.push({
          cwd,
          workspaceId: requestWorkspaceId
        });
        return {
          root: cwd,
          supported: true
        };
      }
    }),
    platformApi: createPlatformApi({
      homeDirectory: "/Users/local",
      os: "darwin"
    })
  });

  assert.deepEqual(await api.workspace.selectDirectory(), {
    path: "/workspace"
  });
  assert.deepEqual(await api.userProjects.create?.({ name: "Demo project" }), {
    createdAtUnixMs: 1,
    id: "project-1",
    label: "Demo project",
    lastUsedAtUnixMs: 1,
    path: "/Users/local/Documents/tutti/Demo project",
    pinnedAtUnixMs: 0,
    sectionKey: "project:/Users/local/Documents/tutti/Demo project",
    updatedAtUnixMs: 1
  });
  assert.deepEqual(await api.userProjects.checkPath?.({ path: "/workspace" }), {
    exists: true,
    isDirectory: true,
    path: "/workspace"
  });
  assert.deepEqual(usedProjectPaths, [
    "/Users/local/Documents/tutti/Demo project"
  ]);
  assert.deepEqual(
    await api.workspace.selectFiles({ allowDirectories: false }),
    [{ path: "/tmp/a.txt" }, { path: "/tmp/b.txt" }]
  );
  assert.deepEqual(selectedUploadFileInputs, [{ allowDirectories: false }]);
  const readFileResult = await api.workspace.readFile({
    path: "/workspace/file.txt"
  });
  assert.deepEqual(readFileResult, {
    bytes: new TextEncoder().encode("hello"),
    content: "hello",
    path: "/workspace/file.txt"
  });
  assert.deepEqual(
    await api.filesystem.readFileText({ uri: "file:///tmp/prompt.md" }),
    {
      content: "prompt",
      name: "prompt.md",
      path: "/tmp/prompt.md"
    }
  );
  await api.workspace.writeFileText({
    content: "updated",
    path: "/workspace/file.txt"
  });
  assert.deepEqual(
    await api.workspace.applyGitPatch?.({
      cwd: "/workspace",
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      revert: true
    }),
    {
      appliedPaths: ["src/app.ts"],
      conflictedPaths: [],
      skippedPaths: [],
      status: "success"
    }
  );
  assert.deepEqual(
    await api.workspace.resolveGitPatchSupport?.({ cwd: "/workspace" }),
    {
      root: "/workspace",
      supported: true
    }
  );
  assert.deepEqual(writtenFiles, [
    {
      content: "updated",
      path: "/workspace/file.txt",
      workspaceId
    }
  ]);
  assert.deepEqual(appliedPatches, [
    {
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      revert: true,
      workspaceId
    }
  ]);
  assert.deepEqual(resolvedPatchSupport, [
    {
      cwd: "/workspace",
      workspaceId
    }
  ]);
});

test("workspace agent read-state write recovers from corrupt localStorage", async () => {
  const storage = new Map<string, string>();
  const localStorageMock: Storage = {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key) {
      return storage.get(key) ?? null;
    },
    key(index) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key) {
      storage.delete(key);
    },
    setItem(key, value) {
      storage.set(key, value);
    }
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock
  });
  try {
    const api = createAgentHostApi();
    const input = { roomId: workspaceId, userId: "user-1" };
    storage.set(
      "tutti.workspace-agent-read-state:workspace-1:user-1",
      "{broken"
    );

    const result = await api.persistence.writeWorkspaceAgentReadState({
      ...input,
      kind: "completed",
      readIds: ["done-1"],
      unreadIds: ["done-2"]
    });

    assert.equal(result.ok, true);
    assert.equal("reason" in result, false);
    assert.deepEqual(await api.persistence.readWorkspaceAgentReadState(input), {
      completed: { readIds: ["done-1"], unreadIds: ["done-2"] },
      failed: { readIds: [], unreadIds: [] }
    });
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "localStorage", previous);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});

type CreateAgentHostApiTestOverrides = Partial<
  Parameters<typeof createDesktopAgentHostApi>[0]
>;

function createAgentHostApi(
  overrides: CreateAgentHostApiTestOverrides = {}
): DesktopAgentHostApiUnderTest {
  const {
    hostFilesApi: overriddenHostFilesApi,
    runtimeApi: overriddenRuntimeApi,
    tuttidClient: overriddenTuttidClient,
    workspaceAgentActivityService: overriddenWorkspaceAgentActivityService,
    ...apiOverrides
  } = overrides;
  const hostFilesApi = overriddenHostFilesApi ?? createHostFilesApi();
  const tuttidClient = overriddenTuttidClient ?? createTuttidClient();
  const runtimeApi = overriddenRuntimeApi ?? createRuntimeApi();
  return createDesktopAgentHostApi({
    hostFilesApi,
    tuttidClient,
    platformApi: createPlatformApi(),
    runtimeApi,
    workspaceAgentActivityService:
      overriddenWorkspaceAgentActivityService ??
      new WorkspaceAgentActivityService({
        hostFilesApi,
        runtimeApi,
        tuttidClient
      }),
    workspaceId,
    ...apiOverrides
  }) as DesktopAgentHostApiUnderTest;
}

function createHostFilesApi(
  overrides: Partial<DesktopHostFilesApi> = {}
): DesktopHostFilesApi {
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
        path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/attachment",
        sizeBytes: 1
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
    },
    ...overrides
  };
}

function createPlatformApi(
  overrides: Partial<Pick<DesktopPlatformApi, "homeDirectory" | "os">> = {}
): Pick<DesktopPlatformApi, "homeDirectory" | "os"> {
  return {
    homeDirectory: "/Users/local",
    os: "darwin",
    ...overrides
  };
}

function createRuntimeApi(): DesktopRuntimeApi {
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
    async listWorkspaceAgentProbes(input) {
      return {
        capturedAtUnixMs: 1,
        providers: [],
        workspaceId: input.workspaceId
      };
    },
    async getTerminalStreamUrl(input: DesktopTerminalStreamUrlRequest) {
      return `ws://127.0.0.1:4000/${input.workspaceId}/${input.sessionId}`;
    },
    async logTerminalDiagnostic(_payload: DesktopTerminalDiagnosticPayload) {},
    async logRendererDiagnostic() {}
  };
}

function createTuttidClient(
  overrides: Partial<TuttidClient> = {}
): TuttidClient {
  return {
    async listUserProjects() {
      return { projects: [] };
    },
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
      provider: Parameters<TuttidClient["getAgentProviderComposerOptions"]>[0]
    ) {
      return {
        provider,
        effectiveSettings: {},
        modelConfig: {
          configurable: false,
          options: []
        },
        permissionConfig: {
          configurable: false,
          modes: []
        },
        reasoningConfig: {
          configurable: false,
          options: []
        },
        runtimeContext: {},
        skills: [],
        capabilityCatalog: []
      };
    },
    async deleteUserProject() {},
    async pinUserProject() {
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
        pinnedAtUnixMs: 0,
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
    },
    async applyWorkspaceGitPatch(
      _workspaceId: string,
      _request: Parameters<TuttidClient["applyWorkspaceGitPatch"]>[1]
    ) {
      return {
        appliedPaths: [],
        conflictedPaths: [],
        skippedPaths: [],
        status: "success"
      };
    },
    async resolveWorkspaceGitPatchSupport(_workspaceId: string, cwd: string) {
      return {
        root: cwd,
        supported: true
      };
    },
    ...overrides
  } as unknown as TuttidClient;
}
