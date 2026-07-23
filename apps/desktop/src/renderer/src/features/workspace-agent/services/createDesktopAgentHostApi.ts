import type {
  AgentTargetSetupSnapshot,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import type {
  AgentHostAgentTargetSetupSnapshot,
  AgentHostInputApi,
  AgentHostQuickPromptsApi,
  AgentHostAgentTargetSetupWatch,
  AgentHostUserProject,
  AgentHostApplyWorkspaceGitPatchInput,
  AgentHostSelectFilesInput,
  AgentProviderProbeListInput,
  PersistWriteResult,
  ReadWorkspaceAgentReadStateInput,
  WorkspaceAgentReadStateSnapshot,
  WriteWorkspaceAgentReadStateInput
} from "@tutti-os/agent-gui";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import { pathFromFileReadPayload } from "./internal/desktopAgentHostProjection.ts";
import { createDesktopAgentTargetSetupWatch } from "./internal/desktopAgentTargetSetupWatch.ts";
import {
  DesktopWorkspaceUserProjectService,
  type IWorkspaceUserProjectService
} from "../../workspace-user-project/index.ts";
import type { WorkspaceUserProject } from "@tutti-os/workspace-user-project";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface.ts";
import { requestWorkspaceTerminalLoginLaunch } from "./workspaceTerminalLoginLaunchCoordinator.ts";

interface CreateDesktopAgentHostApiInput {
  agentQuickPromptService?: AgentHostQuickPromptsApi;
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  platformApi: Pick<DesktopPlatformApi, "homeDirectory" | "os">;
  runtimeApi: DesktopRuntimeApi;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
  workspaceId: string;
}

// workspaceId and action timestamps remain daemon transport/audit metadata;
// Agent GUI Host API intentionally does not expose them.
export function projectDesktopAgentTargetSetupSnapshot(
  snapshot: AgentTargetSetupSnapshot
): AgentHostAgentTargetSetupSnapshot {
  return {
    agentTargetId: snapshot.agentTargetId,
    status: snapshot.status,
    runtimeSource: snapshot.runtimeSource,
    runtimeVersion: snapshot.runtimeVersion,
    reason: snapshot.reason,
    authMethods: snapshot.authMethods.map((method) => ({
      id: method.id,
      name: method.name,
      description: method.description ?? null,
      type: method.type ?? null,
      terminalCommand: method.terminalCommand ?? null
    })),
    account: snapshot.account
      ? {
          id: snapshot.account.id,
          displayName: snapshot.account.displayName,
          authMethodId: snapshot.account.authMethodId,
          organization: snapshot.account.organization ?? null
        }
      : null,
    plan: snapshot.plan
      ? {
          packageName: snapshot.plan.packageName,
          packageVersion: snapshot.plan.packageVersion,
          runner: snapshot.plan.runner,
          planDigest: snapshot.plan.planDigest,
          installRoot: snapshot.plan.installRoot
        }
      : null,
    action: snapshot.action
      ? {
          actionId: snapshot.action.actionId,
          clientActionId: snapshot.action.clientActionId,
          kind: snapshot.action.kind,
          status: snapshot.action.status,
          phase: snapshot.action.phase,
          errorCode: snapshot.action.errorCode ?? null,
          errorMessage: snapshot.action.errorMessage ?? null
        }
      : null
  };
}
export function createDesktopAgentHostApi({
  agentQuickPromptService,
  hostFilesApi,
  tuttidClient,
  platformApi,
  runtimeApi,
  workspaceAgentActivityService,
  workspaceUserProjectService,
  workspaceId
}: CreateDesktopAgentHostApiInput): AgentHostInputApi {
  const agentActivityService = workspaceAgentActivityService;
  const userProjectService =
    workspaceUserProjectService ??
    new DesktopWorkspaceUserProjectService({
      hostFilesApi,
      tuttidClient,
      platformApi,
      workspaceId
    });
  const agentTargetSetupWatches = new Map<
    string,
    AgentHostAgentTargetSetupWatch
  >();
  const getAgentTargetSetup = async (payload: { agentTargetId: string }) =>
    projectDesktopAgentTargetSetupSnapshot(
      await tuttidClient.getAgentTargetSetup(workspaceId, payload.agentTargetId)
    );
  const installAgentTargetRuntime = async (payload: {
    agentTargetId: string;
    planDigest: string;
    clientActionId: string;
  }) =>
    projectDesktopAgentTargetSetupSnapshot(
      await tuttidClient.installAgentTargetRuntime(
        workspaceId,
        payload.agentTargetId,
        {
          planDigest: payload.planDigest,
          clientActionId: payload.clientActionId
        }
      )
    );
  const authenticateAgentTargetRuntime = async (payload: {
    agentTargetId: string;
    methodId: string;
    clientActionId: string;
  }) =>
    projectDesktopAgentTargetSetupSnapshot(
      await tuttidClient.authenticateAgentTargetRuntime(
        workspaceId,
        payload.agentTargetId,
        {
          methodId: payload.methodId,
          clientActionId: payload.clientActionId
        }
      )
    );
  const api = {
    ...(agentQuickPromptService
      ? { quickPrompts: agentQuickPromptService }
      : {}),
    meta: {
      allowWhatsNewInTests: false,
      appVersion: null,
      hostCaptionControls: false,
      isPackaged: false,
      isTest: false,
      mainPid: null,
      pendingWorkspaceIssueNavigation: null,
      pendingWorkspaceRequestId: null,
      platform: platformApi.os,
      workspaceId,
      runtime: "electron",
      windowsPty: null
    },
    clipboard: {
      writeImage: (input: { data: string; mimeType: "image/png" }) =>
        hostFilesApi.copyImageToClipboard(input),
      writeText: (text: string) => navigator.clipboard.writeText(text)
    },
    terminalLogin: {
      run: async (input: { command: string; cwd?: string }) => {
        const handle = await requestWorkspaceTerminalLoginLaunch({
          command: input.command,
          cwd: input.cwd,
          workspaceId
        });
        if (!handle) {
          throw new Error("Terminal login is unavailable in this window.");
        }
        return handle;
      }
    },
    debug: {
      logRuntimeDiagnostics: (payload: unknown) => {
        void runtimeApi.logTerminalDiagnostic({
          details: { payload: JSON.stringify(payload).slice(0, 1000) },
          event: "agent.gui.runtime.diagnostic",
          level: "debug",
          workspaceId
        });
      },
      logTerminalDiagnostics: (payload: unknown) => {
        void runtimeApi.logTerminalDiagnostic({
          details: { payload: JSON.stringify(payload).slice(0, 1000) },
          event: "agent.gui.terminal.diagnostic",
          level: "debug",
          workspaceId
        });
      }
    },
    filesystem: {
      readFileText: async (payload: { path?: string; uri?: string }) => {
        const path = pathFromFileReadPayload(payload);
        return hostFilesApi.readLocalFileText(path);
      }
    },
    account: {
      batchGetUserInfo: () => Promise.resolve({ users: [] })
    },
    agentTargetSetup: {
      watch: (payload: { agentTargetId: string }) => {
        const agentTargetId = payload.agentTargetId.trim();
        const existing = agentTargetSetupWatches.get(agentTargetId);
        if (existing) return existing;
        const watch = createDesktopAgentTargetSetupWatch({
          agentTargetId,
          get: () => getAgentTargetSetup({ agentTargetId }),
          install: ({ planDigest, clientActionId }) =>
            installAgentTargetRuntime({
              agentTargetId,
              planDigest,
              clientActionId
            }),
          authenticate: ({ methodId, clientActionId }) =>
            authenticateAgentTargetRuntime({
              agentTargetId,
              methodId,
              clientActionId
            })
        });
        agentTargetSetupWatches.set(agentTargetId, watch);
        return watch;
      }
    },
    workspaceAgentProbes: {
      list: (payload: AgentProviderProbeListInput) =>
        runtimeApi.listWorkspaceAgentProbes({
          ...payload,
          workspaceId: payload.workspaceId || workspaceId
        })
    },
    userProjects: {
      service: userProjectService,
      checkPath: (payload: { path: string }) =>
        userProjectService.checkProjectPath(payload.path),
      create: async (payload: { name: string }) =>
        toAgentHostUserProject(
          await userProjectService.createProject(payload.name)
        ),
      getDefaultSelection: () => userProjectService.getDefaultSelection(),
      rememberDefaultSelection: (payload: { path: string | null }) => {
        return userProjectService.rememberDefaultSelection(payload);
      },
      isNoProjectPath: (payload: { path: string }) =>
        userProjectService.isNoProjectPath(payload.path),
      list: async () => {
        await userProjectService.ensureLoaded();
        return {
          projects: userProjectService.store.projects.map(
            toAgentHostUserProject
          )
        };
      },
      move: (payload: { beforeProjectId: string | null; projectId: string }) =>
        userProjectService.moveProject(payload),
      pin: (payload: { pinned: boolean; projectId: string }) =>
        userProjectService.pinProject(payload),
      prepareSelection: async (payload: {
        projectLocked: boolean;
        selectedPath: string | null;
      }) => {
        const prepared = await userProjectService.prepareSelection(payload);
        return {
          ...prepared,
          projects: prepared.projects.map(toAgentHostUserProject)
        };
      },
      remove: (payload: { path: string }) =>
        userProjectService.removeProjectPath(payload.path),
      subscribe: (listener: () => void) =>
        userProjectService.subscribe(listener),
      use: async (payload: { path: string }) =>
        toAgentHostUserProject(
          await userProjectService.registerProjectPath(payload.path)
        )
    },
    // The desktop host forwards daemon business events the Agent GUI event bus
    // understands. Today that is the model-catalog invalidation broadcast; the
    // GUI reacts by force-reloading composer options and session state.
    onHostEvent: (listener: (event: unknown) => void) => {
      const disposeModelCatalog =
        agentActivityService.onModelCatalogInvalidated((event) => {
          listener({
            scope: "global",
            type: "agent-model-catalog-invalidated",
            providers: event.providers,
            occurredAtUnixMs: event.occurredAtUnixMs
          });
        });
      const disposeComposerDefaults =
        agentActivityService.onComposerDefaultsInvalidated((event) => {
          listener({
            agentTargetId: event.agentTargetId,
            scope: "global",
            type: "agent-composer-defaults-invalidated"
          });
        });
      return () => {
        disposeModelCatalog();
        disposeComposerDefaults();
      };
    },
    persistence: {
      readWorkspaceAgentReadState: readDesktopWorkspaceAgentReadState,
      writeWorkspaceAgentReadState: writeDesktopWorkspaceAgentReadState
    },
    runtime: {
      getBaseUrl: async () => (await runtimeApi.getBackendConfig()).baseUrl
    },
    windowChrome: {
      closeCurrentWindow: async () => {},
      setTheme: async () => {}
    },
    workspace: {
      applyGitPatch: async (payload: AgentHostApplyWorkspaceGitPatchInput) => {
        logAgentGitPatchDiagnostic(runtimeApi, workspaceId, "requested", {
          cwd: payload.cwd,
          revert: payload.revert ?? false,
          atomic: payload.atomic ?? false,
          target: payload.target ?? "unstaged",
          allowBinary: payload.allowBinary ?? false,
          diffBytes: new TextEncoder().encode(payload.diff).byteLength
        });
        try {
          const result = await tuttidClient.applyWorkspaceGitPatch(
            workspaceId,
            payload
          );
          logAgentGitPatchDiagnostic(runtimeApi, workspaceId, "completed", {
            status: result.status,
            errorCode: result.errorCode ?? null,
            appliedPaths: result.appliedPaths,
            skippedPaths: result.skippedPaths,
            conflictedPaths: result.conflictedPaths,
            stderr: result.execOutput?.stderr ?? ""
          });
          return result;
        } catch (error) {
          logAgentGitPatchDiagnostic(runtimeApi, workspaceId, "failed", {
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      },
      resolveGitPatchSupport: async (payload: { cwd: string }) =>
        tuttidClient.resolveWorkspaceGitPatchSupport(workspaceId, payload.cwd),
      copyPath: async (payload: { path: string }) => {
        await navigator.clipboard.writeText(payload.path);
      },
      ensureDirectory: async () => {},
      readFile: async (payload: { path: string }) => {
        const bytes = await hostFilesApi.readPreviewFile(
          workspaceId,
          payload.path
        );
        return {
          bytes,
          content: new TextDecoder().decode(bytes),
          path: payload.path
        };
      },
      selectContextEntries: () => Promise.resolve({ entries: [] }),
      selectDirectory: async () => {
        const path = await hostFilesApi.selectDirectory();
        return path ? { path } : null;
      },
      selectFiles: async (input?: AgentHostSelectFilesInput) =>
        (await hostFilesApi.selectUploadFiles(input)).map((path) => ({
          path
        })),
      writeFile: async (payload: { content?: string; path: string }) => {
        await tuttidClient.writeWorkspaceFileText(workspaceId, {
          content: payload.content ?? "",
          path: payload.path
        });
      },
      writeFileText: async (payload: { content: string; path: string }) => {
        await tuttidClient.writeWorkspaceFileText(workspaceId, payload);
      }
    }
  };

  return api;
}

function logAgentGitPatchDiagnostic(
  runtimeApi: DesktopRuntimeApi,
  workspaceId: string,
  phase: "requested" | "completed" | "failed",
  payload: Record<string, unknown>
): void {
  void runtimeApi
    .logTerminalDiagnostic({
      details: {
        payload: JSON.stringify({ phase, ...payload })
      },
      event: "agent.git_patch.trace",
      level: phase === "failed" ? "warn" : "info",
      workspaceId
    })
    .catch(() => {});
}

function toAgentHostUserProject(
  project: WorkspaceUserProject
): AgentHostUserProject {
  const { lastUsedAtUnixMs, ...rest } = project;
  return lastUsedAtUnixMs == null ? rest : { ...rest, lastUsedAtUnixMs };
}

export function readDesktopWorkspaceAgentReadState(
  input: ReadWorkspaceAgentReadStateInput
): Promise<WorkspaceAgentReadStateSnapshot> {
  const storage = resolveLocalStorage();
  if (!storage) {
    return Promise.resolve(emptyWorkspaceAgentReadState());
  }
  const raw = storage.getItem(workspaceAgentReadStateStorageKey(input));
  if (!raw) {
    return Promise.resolve(emptyWorkspaceAgentReadState());
  }
  try {
    return Promise.resolve(normalizeWorkspaceAgentReadState(JSON.parse(raw)));
  } catch {
    return Promise.resolve(emptyWorkspaceAgentReadState());
  }
}

export function writeDesktopWorkspaceAgentReadState(
  input: WriteWorkspaceAgentReadStateInput
): Promise<PersistWriteResult> {
  const storage = resolveLocalStorage();
  if (!storage) {
    return Promise.resolve({
      ok: false,
      reason: "unavailable",
      error: { code: "persistence.unavailable" }
    });
  }
  try {
    let current = emptyWorkspaceAgentReadState();
    try {
      current = normalizeWorkspaceAgentReadState(
        JSON.parse(
          storage.getItem(workspaceAgentReadStateStorageKey(input)) ?? "null"
        )
      );
    } catch {
      current = emptyWorkspaceAgentReadState();
    }
    const next: WorkspaceAgentReadStateSnapshot = {
      ...current,
      [input.kind]: {
        readIds: normalizeIdList(input.readIds),
        unreadIds: normalizeIdList(input.unreadIds)
      }
    };
    const raw = JSON.stringify(next);
    storage.setItem(workspaceAgentReadStateStorageKey(input), raw);
    return Promise.resolve({
      ok: true,
      level: "settings_only",
      bytes: new TextEncoder().encode(raw).byteLength
    });
  } catch (error) {
    return Promise.resolve({
      ok: false,
      reason: "io",
      error: {
        code: "persistence.io_failed",
        debugMessage: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function workspaceAgentReadStateStorageKey(input: {
  roomId: string;
  userId: string;
}): string {
  return [
    "tutti.workspace-agent-read-state",
    encodeURIComponent(input.roomId.trim()),
    encodeURIComponent(input.userId.trim())
  ].join(":");
}

function resolveLocalStorage(): Storage | null {
  return typeof globalThis.localStorage === "undefined"
    ? null
    : globalThis.localStorage;
}

function emptyWorkspaceAgentReadState(): WorkspaceAgentReadStateSnapshot {
  return {
    completed: { readIds: [], unreadIds: [] },
    failed: { readIds: [], unreadIds: [] }
  };
}

function normalizeWorkspaceAgentReadState(
  value: unknown
): WorkspaceAgentReadStateSnapshot {
  const record = value && typeof value === "object" ? value : {};
  const completed = (record as { completed?: unknown }).completed;
  const failed = (record as { failed?: unknown }).failed;
  return {
    completed: normalizeWorkspaceAgentReadStateBucket(completed),
    failed: normalizeWorkspaceAgentReadStateBucket(failed)
  };
}

function normalizeWorkspaceAgentReadStateBucket(value: unknown): {
  readIds: string[];
  unreadIds: string[];
} {
  const record = value && typeof value === "object" ? value : {};
  return {
    readIds: normalizeIdList((record as { readIds?: unknown }).readIds),
    unreadIds: normalizeIdList((record as { unreadIds?: unknown }).unreadIds)
  };
}

function normalizeIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => `${item}`.trim()).filter(Boolean))]
    : [];
}
