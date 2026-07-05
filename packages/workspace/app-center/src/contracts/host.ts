import type {
  WorkspaceAppInstallProgress,
  WorkspaceAppInstallUserPhase,
  WorkspaceAppRuntimeStatus
} from "./runtime.ts";
import type { WorkspaceAppFactoryJobStatus } from "./viewModel.ts";

export type WorkspaceAppCenterRuntimeStatus = WorkspaceAppRuntimeStatus;

export type { WorkspaceAppInstallProgress, WorkspaceAppInstallUserPhase };

export type WorkspaceAppCenterSource =
  | "builtin"
  | "generated"
  | "imported"
  | "local-dev";

export interface WorkspaceAppCenterLocalization {
  locale: string;
  name?: string | null;
  description?: string | null;
  tags: readonly string[];
}

export type WorkspaceAppCenterCliStatus =
  | "none"
  | "pending"
  | "active"
  | "warning"
  | "error";

export interface WorkspaceAppCenterCliIssue {
  code: string;
  message: string;
  path?: string | null;
}

export interface WorkspaceAppCenterCliState {
  active: boolean;
  issues: readonly WorkspaceAppCenterCliIssue[];
  scope?: string | null;
  status: WorkspaceAppCenterCliStatus;
}

export interface WorkspaceAppCenterReferencesState {
  listSupported: boolean;
}

export interface WorkspaceAppCenterAuthor {
  avatarUrl?: string | null;
  name: string;
  url?: string | null;
}

export interface WorkspaceAppCenterRepository {
  type: "github";
  url: string;
}

export interface WorkspaceAppCenterApp {
  authors?: readonly WorkspaceAppCenterAuthor[];
  availableIconUrl?: string | null;
  availableVersion?: string | null;
  description?: string | null;
  installationId?: string | null;
  runtimeId?: string | null;
  appId: string;
  createdAtUnixMs: number;
  enabled: boolean;
  exportable: boolean;
  failureReason?: string | null;
  iconUrl?: string | null;
  installProgress?: WorkspaceAppInstallProgress | null;
  installed: boolean;
  lastError?: string | null;
  cli?: WorkspaceAppCenterCliState;
  localPackageDir?: string | null;
  localizations?: readonly WorkspaceAppCenterLocalization[];
  minimizeBehavior: WorkspaceAppMinimizeBehavior;
  name: string;
  references: WorkspaceAppCenterReferencesState;
  repository?: WorkspaceAppCenterRepository | null;
  runtimeStatus: WorkspaceAppCenterRuntimeStatus;
  source: WorkspaceAppCenterSource;
  stateRevision: number;
  tags?: readonly string[];
  updateAvailable?: boolean;
  launchUrl?: string | null;
  version?: string | null;
  windowMinHeight?: number | null;
  windowMinWidth?: number | null;
}

export type WorkspaceAppMinimizeBehavior = "hibernate" | "keep-mounted";

export type WorkspaceAppCenterCatalogStatus =
  | "disabled"
  | "failed"
  | "loading"
  | "ready";

export interface WorkspaceAppCenterSnapshot {
  apps: readonly WorkspaceAppCenterApp[];
  catalogLastError?: string | null;
  catalogStatus: WorkspaceAppCenterCatalogStatus;
  catalogUpdatedAtUnixMs?: number | null;
}

export interface WorkspaceAppFactoryJob {
  agentTargetId?: string | null;
  agentSessionId?: string | null;
  appId?: string | null;
  createdAtUnixMs: number;
  description?: string | null;
  displayName: string;
  failureReason?: string | null;
  jobId: string;
  model?: string | null;
  prompt: string;
  provider?: string | null;
  reasoningEffort?: string | null;
  publishedVersion?: string | null;
  status: WorkspaceAppFactoryJobStatus;
  updatedAtUnixMs: number;
  validationResult?: Record<string, unknown> | null;
  workspaceId: string;
}

export interface WorkspaceAppFactorySnapshot {
  jobs: readonly WorkspaceAppFactoryJob[];
}

export interface WorkspaceAppFactoryModelOption {
  label: string;
  value: string;
}

export interface WorkspaceAppFactoryReasoningOption {
  label: string;
  value: string;
}

export interface WorkspaceAppFactoryPermissionOption {
  label: string;
  semantic?: string | null;
  value: string;
}

export interface WorkspaceAppFactoryProviderConfiguration {
  defaultModel?: string | null;
  defaultPermissionModeId?: string | null;
  defaultReasoningEffort?: string | null;
  modelOptions: readonly WorkspaceAppFactoryModelOption[];
  permissionModeOptions: readonly WorkspaceAppFactoryPermissionOption[];
  reasoningEffortOptions: readonly WorkspaceAppFactoryReasoningOption[];
}

export interface WorkspaceAppLocalRepairRequest {
  projectDir: string;
  sourceDir: string;
}

export interface WorkspaceAppLocalRepairAgentRequest extends WorkspaceAppLocalRepairRequest {
  prompt: string;
}

export type WorkspaceAppCenterLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable";

export interface WorkspaceAppCenterStoreState {
  apps: WorkspaceAppCenterApp[];
  catalogLastError: string | null;
  catalogStatus: WorkspaceAppCenterCatalogStatus;
  catalogUpdatedAtUnixMs: number | null;
  error: string | null;
  factoryJobs: WorkspaceAppFactoryJob[];
  loadStatus: WorkspaceAppCenterLoadStatus;
  openingFolderAppId: string | null;
  revision: number;
  viewStateByWorkspaceId: Record<
    string,
    WorkspaceAppCenterViewState | undefined
  >;
  workspaceId: string | null;
}

export type WorkspaceAppCenterAppTab = "community" | "my" | "recommended";

export interface WorkspaceAppCenterViewState {
  activeAppTab: WorkspaceAppCenterAppTab;
}

export type WorkspaceAppCenterReadableStoreState =
  Readonly<WorkspaceAppCenterStoreState>;

export interface WorkspaceAppCenterGateway {
  installWorkspaceApp(
    workspaceId: string,
    appId: string,
    input?: { restartRunning?: boolean }
  ): Promise<WorkspaceAppCenterSnapshot>;
  loadLocalWorkspaceApp(
    workspaceId: string,
    input: { restartRunning?: boolean; sourceDir: string }
  ): Promise<WorkspaceAppCenterSnapshot>;
  launchWorkspaceApp(
    workspaceId: string,
    appId: string
  ): Promise<WorkspaceAppCenterSnapshot>;
  deleteWorkspaceApp(
    workspaceId: string,
    appId: string
  ): Promise<WorkspaceAppCenterSnapshot>;
  listWorkspaceApps(workspaceId: string): Promise<WorkspaceAppCenterSnapshot>;
  refreshWorkspaceAppCatalog(
    workspaceId: string
  ): Promise<WorkspaceAppCenterSnapshot>;
  reloadLocalWorkspaceApp(
    workspaceId: string,
    appId: string,
    input?: { restartRunning?: boolean }
  ): Promise<WorkspaceAppCenterSnapshot>;
  uninstallWorkspaceApp(
    workspaceId: string,
    appId: string
  ): Promise<WorkspaceAppCenterSnapshot>;
  retryWorkspaceApp(
    workspaceId: string,
    appId: string
  ): Promise<WorkspaceAppCenterSnapshot>;
  rollbackWorkspaceApp(
    workspaceId: string,
    appId: string,
    version: string
  ): Promise<WorkspaceAppCenterSnapshot>;
  listWorkspaceAppFactoryJobs(
    workspaceId: string
  ): Promise<WorkspaceAppFactorySnapshot>;
  createWorkspaceAppFactoryJob(
    workspaceId: string,
    input: {
      agentTargetId: string;
      displayName: string;
      model?: string;
      permissionModeId?: string;
      prompt: string;
      reasoningEffort?: string;
    }
  ): Promise<WorkspaceAppFactorySnapshot>;
  cancelWorkspaceAppFactoryJob(
    workspaceId: string,
    jobId: string
  ): Promise<WorkspaceAppFactorySnapshot>;
  deleteWorkspaceAppFactoryJob(
    workspaceId: string,
    jobId: string
  ): Promise<WorkspaceAppFactorySnapshot>;
  retryWorkspaceAppFactoryJobValidation(
    workspaceId: string,
    jobId: string
  ): Promise<WorkspaceAppFactorySnapshot>;
  fixWorkspaceAppFactoryJob(
    workspaceId: string,
    jobId: string,
    input: { prompt: string }
  ): Promise<WorkspaceAppFactorySnapshot>;
  prepareWorkspaceAppFactoryJobModification(
    workspaceId: string,
    jobId: string
  ): Promise<WorkspaceAppFactorySnapshot>;
  publishWorkspaceAppFactoryJob(
    workspaceId: string,
    jobId: string
  ): Promise<{
    appSnapshot: WorkspaceAppCenterSnapshot;
    factorySnapshot: WorkspaceAppFactorySnapshot;
  }>;
  startEnabledWorkspaceApps(
    workspaceId: string
  ): Promise<WorkspaceAppCenterSnapshot>;
}
