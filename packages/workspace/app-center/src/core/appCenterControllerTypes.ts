import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterGateway,
  WorkspaceAppCenterStoreState,
  WorkspaceAppFactoryJob
} from "../contracts/host.ts";

export const defaultCatalogLoadingRefreshDelayMs = 750;
export const defaultAppOpenLaunchWaitTimeoutMs = 35_000;
export const defaultInstallRefreshDelayMs = 750;
export const defaultTransientRuntimeRefreshDelayMs = 750;
export const defaultTransientRuntimeRefreshMaxAttempts = 40;

export type WorkspaceAppCenterRefreshPolicy = "poll" | "event";

/**
 * Monotonic identity for one app operation event stream. A new operation must
 * advance desiredGeneration; events within it must advance sequence.
 */
export interface WorkspaceAppCenterOperationCursor {
  readonly desiredGeneration: number;
  readonly operationId: string;
  readonly sequence: number;
}

export type WorkspaceAppCenterOperation =
  | "app_center.refresh"
  | "app_center.refresh_catalog"
  | "app_center.start_workspace_updates"
  | "app_factory.create"
  | "app_factory.prepare_modification"
  | "app_factory.publish"
  | "workspace_app.delete"
  | "workspace_app.export"
  | "workspace_app.import"
  | "workspace_app.install"
  | "workspace_app.load_local"
  | "workspace_app.prepare_launch"
  | "workspace_app.refresh_install_state"
  | "workspace_app.refresh_launch_wait_state"
  | "workspace_app.reload_local"
  | "workspace_app.replace_icon"
  | "workspace_app.restart_and_open"
  | "workspace_app.retry"
  | "workspace_app.start_enabled"
  | "workspace_app.update";

export type WorkspaceAppCenterUiAction =
  | "create_factory_job"
  | "delete_app"
  | "export_app"
  | "import_app"
  | "install_app"
  | "load_local_app"
  | "open_app"
  | "prepare_factory_job_modification"
  | "publish_factory_job"
  | "refresh_install_state"
  | "refresh_launch_wait_state"
  | "replace_app_icon"
  | "restart_and_open_app"
  | "reload_local_app"
  | "retry_app"
  | "update_app";

export interface WorkspaceAppCenterOperationDetails {
  appId?: string;
  jobId?: string;
  operation: WorkspaceAppCenterOperation;
  uiAction?: WorkspaceAppCenterUiAction;
  workspaceId: string;
}

export interface WorkspaceAppCenterRefreshDiscard {
  currentSequence: number;
  itemCount?: number;
  operation: "app_center.refresh" | "app_center.refresh_catalog";
  sequence: number;
  snapshotKind: "apps" | "catalog_apps" | "factory_jobs";
  workspaceId: string;
}

export interface WorkspaceAppCenterControllerHooks {
  onAppDeleted?: (app: WorkspaceAppCenterApp | null) => void;
  onAppInstallFailed?: (input: {
    app: WorkspaceAppCenterApp | null;
    appId: string;
    failureReason: string | null;
  }) => void;
  onAppInstalled?: (app: WorkspaceAppCenterApp) => void;
  onAppRuntimeFailed?: (input: {
    app: WorkspaceAppCenterApp;
    failureReason: string | null;
  }) => void;
  onAppStopped?: (input: {
    app: WorkspaceAppCenterApp;
    runDurationMs: number | null;
  }) => void;
  onAppUninstalled?: (app: WorkspaceAppCenterApp | null) => void;
  onAppUpdated?: (input: {
    app: WorkspaceAppCenterApp | undefined;
    trigger: "badge_button" | "primary_action";
  }) => void;
  onCatalogRefreshed?: (input: {
    appCount: number | null;
    errorReason: string | null;
    success: boolean;
  }) => void;
  onCloseWorkspaceAppViews?: (input: {
    appIds: readonly string[];
    workspaceId: string;
  }) => void;
  onFactoryJobCreated?: (job: WorkspaceAppFactoryJob | null) => void;
  onFactorySnapshotApplied?: (input: {
    nextJobs: readonly WorkspaceAppFactoryJob[];
    previousJobs: readonly WorkspaceAppFactoryJob[];
    workspaceId: string;
  }) => void;
  onOperationFailure?: (input: {
    details: WorkspaceAppCenterOperationDetails;
    error: unknown;
    toastMessage: string;
  }) => void;
  onRefreshDiscard?: (input: WorkspaceAppCenterRefreshDiscard) => void;
}

export interface WorkspaceAppCenterControllerDependencies {
  appOpenLaunchWaitTimeoutMs?: number;
  catalogLoadingRefreshDelayMs?: number;
  createClientSubmitId?: () => string;
  formatError: (
    error: unknown,
    details?: WorkspaceAppCenterOperationDetails
  ) => string;
  gateway: WorkspaceAppCenterGateway;
  getErrorReason?: (error: unknown) => string | null;
  hooks?: WorkspaceAppCenterControllerHooks;
  installRefreshDelayMs?: number;
  now?: () => number;
  /** Defaults to `poll`. Event mode relies on host-pushed app updates. */
  refreshPolicy?: WorkspaceAppCenterRefreshPolicy;
  store?: WorkspaceAppCenterStoreState;
  transientRuntimeRefreshDelayMs?: number;
  transientRuntimeRefreshMaxAttempts?: number;
}

export function createWorkspaceAppCenterStoreState(): WorkspaceAppCenterStoreState {
  return {
    apps: [],
    catalogLastError: null,
    catalogStatus: "disabled",
    catalogUpdatedAtUnixMs: null,
    error: null,
    factoryJobs: [],
    loadStatus: "idle",
    openingFolderAppId: null,
    revision: 0,
    viewStateByWorkspaceId: {},
    workspaceId: null
  };
}
