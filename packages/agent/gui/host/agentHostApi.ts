import type {
  AgentHostBatchUserInfoInput,
  AgentHostBatchUserInfoResult,
  AgentHostDeleteWorkspaceAgentSessionInput,
  AgentHostWorkspaceAgentListInput as AgentHostListWorkspaceAgentsInput,
  AgentHostListWorkspaceAgentProbesInput,
  AgentHostWorkspaceAgentSessionMessages,
  AgentHostWorkspaceAgentSessionMessagesInput,
  AgentHostWorkspaceAgentSessionSummary,
  AgentHostWorkspaceAgentSessionSummaryInput,
  AgentHostWorkspaceAgentProbesResult,
  AgentHostWorkspaceAgentSnapshot,
  PersistWriteResult,
  ReadWorkspaceAgentReadStateInput,
  ReadWorkspaceFileResult as AgentHostReadWorkspaceFileResult,
  WorkspaceAgentReadStateSnapshot,
  WriteWorkspaceAgentReadStateInput
} from "../shared/contracts/dto";
import type { WorkspaceUserProjectService } from "@tutti-os/workspace-user-project/contracts";

type AgentHostAsyncResult<T = any> = Promise<T>;
type AgentHostRecord = Record<string, unknown>;
type AgentHostUnsubscribe = () => void;
type AgentHostWorkspaceScopedInput<
  T extends {
    workspaceId?: string | null;
  }
> = Omit<T, "workspaceId"> & {
  workspaceId: string;
};
type AgentHostWorkspaceAgentsListInput =
  AgentHostWorkspaceScopedInput<AgentHostListWorkspaceAgentsInput>;
type AgentHostWorkspaceAgentSessionMessagesRuntimeInput =
  AgentHostWorkspaceScopedInput<AgentHostWorkspaceAgentSessionMessagesInput>;
type AgentHostWorkspaceAgentSessionSummaryRuntimeInput =
  AgentHostWorkspaceScopedInput<AgentHostWorkspaceAgentSessionSummaryInput>;
type AgentHostDeleteWorkspaceAgentSessionRuntimeInput =
  AgentHostWorkspaceScopedInput<AgentHostDeleteWorkspaceAgentSessionInput>;

export type AgentHostClipboardApi = {
  writeImage?: (input: {
    data: string;
    mimeType: "image/png";
  }) => AgentHostAsyncResult<void>;
  writeText: (text: string) => AgentHostAsyncResult<void>;
};

export type AgentHostDebugApi = {
  logRuntimeDiagnostics: (
    payload: unknown
  ) => AgentHostAsyncResult<void> | void;
  logTerminalDiagnostics?: (
    payload: unknown
  ) => AgentHostAsyncResult<void> | void;
};

export type AgentHostFilesystemApi = AgentHostRecord & {
  readFileText: (payload: {
    path?: string;
    uri?: string;
  }) => AgentHostAsyncResult<{
    content: string;
    name?: string;
    path?: string;
  }>;
};

export type AgentHostMetaApi = AgentHostRecord & {
  appVersion?: string | null;
  isPackaged?: boolean;
  isTest?: boolean;
  mainPid?: number | null;
  platform?: string;
  workspaceId?: string;
};

export type AgentHostEnvironmentApi = AgentHostRecord & {
  getBaseUrl?: () => AgentHostAsyncResult<string>;
  warmupOpenclawGateway?: (input?: unknown) => AgentHostAsyncResult<unknown>;
};

export type AgentHostPersistenceApi = AgentHostRecord & {
  readWorkspaceAgentReadState: (
    input: ReadWorkspaceAgentReadStateInput
  ) => AgentHostAsyncResult<WorkspaceAgentReadStateSnapshot>;
  writeWorkspaceAgentReadState: (
    input: WriteWorkspaceAgentReadStateInput
  ) => AgentHostAsyncResult<PersistWriteResult>;
};

export type AgentHostToastApi = AgentHostRecord & {
  error: (title: string, description?: string) => void;
  info?: (title: string, description?: string) => void;
  success?: (title: string, description?: string) => void;
};

export interface AgentHostSelectedFile {
  name?: string;
  path: string;
}

export interface AgentHostSelectFilesInput {
  allowDirectories?: boolean;
}

export interface AgentHostApplyWorkspaceGitPatchInput {
  allowBinary?: boolean;
  atomic?: boolean;
  cwd: string;
  diff: string;
  revert?: boolean;
  target?: "unstaged" | "staged" | "staged-and-unstaged";
}

export interface AgentHostApplyWorkspaceGitPatchResult {
  status: "success" | "partial-success" | "error";
  appliedPaths: string[];
  skippedPaths: string[];
  conflictedPaths: string[];
  errorCode?: "not-git-repo" | string;
  execOutput?: {
    command: string;
    stdout: string;
    stderr: string;
  };
}

export interface AgentHostResolveWorkspaceGitPatchSupportInput {
  cwd: string;
}

export interface AgentHostResolveWorkspaceGitPatchSupportResult {
  supported: boolean;
  root?: string;
  errorCode?: "not-git-repo" | string;
}

export type AgentHostWorkspaceApi = AgentHostRecord & {
  applyGitPatch?: (
    input: AgentHostApplyWorkspaceGitPatchInput
  ) => AgentHostAsyncResult<AgentHostApplyWorkspaceGitPatchResult>;
  resolveGitPatchSupport?: (
    input: AgentHostResolveWorkspaceGitPatchSupportInput
  ) => AgentHostAsyncResult<AgentHostResolveWorkspaceGitPatchSupportResult>;
  copyPath?: (input: { path: string }) => AgentHostAsyncResult<void>;
  ensureDirectory: (input: { path: string }) => AgentHostAsyncResult<void>;
  getReferenceForFile?: (file: File) => {
    kind: "file" | "folder";
    path: string;
  };
  readFile: (input: {
    path: string;
  }) => AgentHostAsyncResult<AgentHostReadWorkspaceFileResult>;
  selectContextEntries?: () => AgentHostAsyncResult<{ entries: unknown[] }>;
  selectDirectory: () => AgentHostAsyncResult<{ path: string } | null>;
  selectFiles: (
    input?: AgentHostSelectFilesInput
  ) => AgentHostAsyncResult<AgentHostSelectedFile[]>;
  writeFileText: (input: {
    content: string;
    path: string;
  }) => AgentHostAsyncResult<unknown>;
};

export interface AgentHostInputApi {
  account?: AgentHostAccountApi;
  agentGuiBatch?: AgentHostAgentGuiBatchApi;
  agentSessions?: AgentHostAgentSessionsApi;
  clipboard: AgentHostClipboardApi;
  debug?: AgentHostDebugApi;
  filesystem: AgentHostFilesystemApi;
  meta?: AgentHostMetaApi;
  onHostEvent?: (listener: (event: any) => void) => AgentHostUnsubscribe;
  persistence?: AgentHostPersistenceApi;
  runtime?: AgentHostEnvironmentApi;
  toast?: AgentHostToastApi;
  userProjects?: AgentHostUserProjectsApi;
  workspace: AgentHostWorkspaceApi;
  workspaceAgentProbes?: AgentHostWorkspaceAgentProbesApi;
  workspaceAgents?: AgentHostWorkspaceAgentsApi;
}

export type AgentHostApi = AgentHostInputApi;

export type AgentHostAccountApi = AgentHostRecord & {
  batchGetUserInfo: (
    input: AgentHostBatchUserInfoInput
  ) => AgentHostAsyncResult<AgentHostBatchUserInfoResult>;
  ensureProfiles?: (input: any) => AgentHostAsyncResult<any>;
};

export type AgentHostAgentGuiBatchApi = AgentHostRecord & {
  exportRun: (input: any) => AgentHostAsyncResult<any>;
};

export type AgentHostWorkspaceAgentProbesApi = AgentHostRecord & {
  list: (
    input: AgentHostListWorkspaceAgentProbesInput
  ) => AgentHostAsyncResult<AgentHostWorkspaceAgentProbesResult>;
};

export type AgentProviderProbeListInput =
  AgentHostListWorkspaceAgentProbesInput;
export type AgentProviderProbeListResult = AgentHostWorkspaceAgentProbesResult;

export interface AgentHostUserProject {
  id: string;
  path: string;
  label: string;
  createdAtUnixMs?: number;
  updatedAtUnixMs?: number;
  lastUsedAtUnixMs?: number;
}

export type AgentHostUserProjectsApi = AgentHostRecord & {
  service?: WorkspaceUserProjectService;
  checkPath?: (input: { path: string }) => AgentHostAsyncResult<{
    exists: boolean;
    isDirectory: boolean;
    path: string;
  }>;
  create?: (input: {
    name: string;
  }) => AgentHostAsyncResult<AgentHostUserProject>;
  getDefaultSelection?: () => AgentHostAsyncResult<{
    path: string | null;
  } | null>;
  list: () => AgentHostAsyncResult<{
    projects: AgentHostUserProject[];
  }>;
  subscribe?: (listener: () => void) => AgentHostUnsubscribe;
  prepareSelection?: (input: {
    projectLocked: boolean;
    selectedPath: string | null;
  }) => AgentHostAsyncResult<{
    isSelectedPathMissing: boolean;
    projects: AgentHostUserProject[];
    selection:
      | {
          kind: "clear";
          suppressedPath: string;
        }
      | {
          kind: "none";
        }
      | {
          kind: "select";
          path: string;
        };
  }>;
  remove?: (input: { path: string }) => AgentHostAsyncResult<void>;
  isNoProjectPath?: (input: { path: string }) => boolean;
  rememberDefaultSelection?: (input: {
    path: string | null;
  }) => AgentHostAsyncResult<void>;
  use: (input: { path: string }) => AgentHostAsyncResult<AgentHostUserProject>;
};

export type AgentHostAgentSessionsApi = AgentHostRecord & {
  activate: (input: any) => AgentHostAsyncResult<any>;
  /**
   * @deprecated AgentGUI production writes must use AgentActivityRuntime.cancelSession.
   */
  cancel: (input: any) => AgentHostAsyncResult<any>;
  /**
   * @deprecated AgentGUI production writes must use AgentActivityRuntime.sendInput.
   */
  exec: (input: any) => AgentHostAsyncResult<any>;
  getComposerOptions?: (input: any) => AgentHostAsyncResult<any>;
  getState: (input: any) => AgentHostAsyncResult<any>;
  onEvent?: (listener: (event: any) => void) => AgentHostUnsubscribe;
  /**
   * @deprecated AgentGUI production writes must use AgentActivityRuntime.setSessionPinned.
   */
  pinSession?: (input: any) => AgentHostAsyncResult<any>;
  /**
   * @deprecated AgentGUI production sync must use AgentActivityRuntime.ensureSessionSynchronized.
   */
  releaseEventStream?: (input?: any) => AgentHostAsyncResult;
  /**
   * @deprecated AgentGUI production sync must use AgentActivityRuntime.ensureSessionSynchronized.
   */
  retainEventStream?: (input: any) => AgentHostAsyncResult;
  /**
   * @deprecated AgentGUI production writes must use AgentActivityRuntime.submitInteractive.
   */
  submitInteractive: (input: any) => AgentHostAsyncResult<any>;
  /**
   * @deprecated AgentGUI production UI must derive events from AgentActivityRuntime snapshots.
   */
  trackSettingsProjectChange?: (input: {
    action: "clear" | "create_new" | "select_existing";
    agentSessionId: string;
    provider?: string | null;
  }) => AgentHostAsyncResult<void>;
  subscribeEvents: (
    input: any,
    listener: (event: any) => void
  ) => AgentHostUnsubscribe;
  unactivate: (input: any) => AgentHostAsyncResult<any>;
  updateSettings: (input: any) => AgentHostAsyncResult<any>;
};

/**
 * @deprecated Legacy host DTO projection. AgentGUI production reads and writes
 * must use AgentActivityRuntime and AgentActivity* models.
 */
export type AgentHostWorkspaceAgentsApi = AgentHostRecord & {
  /**
   * @deprecated Use AgentActivityRuntime.deleteSession.
   */
  deleteSession: (
    input: AgentHostDeleteWorkspaceAgentSessionRuntimeInput
  ) => AgentHostAsyncResult<any>;
  /**
   * @deprecated Derive summaries from AgentActivitySnapshot/session messages.
   */
  getSessionSummary: (
    input: AgentHostWorkspaceAgentSessionSummaryRuntimeInput
  ) => AgentHostAsyncResult<AgentHostWorkspaceAgentSessionSummary>;
  /**
   * @deprecated Use AgentActivityRuntime.load/getSnapshot.
   */
  list: (
    input: string | AgentHostWorkspaceAgentsListInput
  ) => AgentHostAsyncResult<AgentHostWorkspaceAgentSnapshot>;
  /**
   * @deprecated Use AgentActivityRuntime.listSessionMessages.
   */
  listSessionMessages: (
    input: AgentHostWorkspaceAgentSessionMessagesRuntimeInput
  ) => AgentHostAsyncResult<AgentHostWorkspaceAgentSessionMessages>;
};

export interface AgentHostRuntimeApi {
  account?: AgentHostAccountApi;
  agentGuiBatch: AgentHostAgentGuiBatchApi;
  clipboard: AgentHostClipboardApi;
  debug?: AgentHostDebugApi;
  filesystem: AgentHostFilesystemApi;
  meta?: AgentHostMetaApi;
  onHostEvent?: (listener: (event: any) => void) => AgentHostUnsubscribe;
  persistence?: AgentHostPersistenceApi;
  runtime?: AgentHostEnvironmentApi;
  toast?: AgentHostToastApi;
  userProjects?: AgentHostUserProjectsApi;
  workspace: AgentHostWorkspaceApi;
  workspaceAgentProbes?: AgentHostWorkspaceAgentProbesApi;
}

export function toAgentHostRuntimeApi(
  hostApi: AgentHostInputApi | AgentHostRuntimeApi
): AgentHostRuntimeApi {
  return {
    account: hostApi.account,
    agentGuiBatch: hostApi.agentGuiBatch ?? ({} as AgentHostAgentGuiBatchApi),
    clipboard: hostApi.clipboard,
    debug: hostApi.debug,
    filesystem: hostApi.filesystem,
    meta: hostApi.meta,
    onHostEvent: hostApi.onHostEvent,
    persistence: hostApi.persistence,
    runtime: hostApi.runtime,
    toast: hostApi.toast,
    userProjects: hostApi.userProjects,
    workspace: hostApi.workspace,
    workspaceAgentProbes: hostApi.workspaceAgentProbes
  };
}
