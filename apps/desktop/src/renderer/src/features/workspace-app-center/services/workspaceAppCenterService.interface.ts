import { createDecorator } from "@tutti-os/infra/di";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppFactoryJob,
  WorkspaceAppFactoryProviderConfiguration,
  WorkspaceAppLocalRepairRequest,
  WorkspaceAppCenterReadableStoreState,
  WorkspaceAppCenterViewState
} from "@tutti-os/workspace-app-center";
import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";

export interface IWorkspaceAppCenterService {
  readonly _serviceBrand: undefined;
  readonly store: WorkspaceAppCenterReadableStoreState;

  consumeError(): string | null;
  cancelFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void>;
  createFactoryJob(input: {
    displayName: string;
    model?: string;
    permissionModeId?: string;
    provider?: string;
    prompt: string;
    reasoningEffort?: string;
    workspaceId: string;
  }): Promise<void>;
  deleteFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void>;
  deleteApp(input: { appId: string; workspaceId: string }): Promise<void>;
  exportApp(input: { appId: string; workspaceId: string }): Promise<void>;
  fixFactoryJob(input: {
    jobId: string;
    prompt: string;
    workspaceId: string;
  }): Promise<void>;
  openApp(input: { appId: string; workspaceId: string }): Promise<boolean>;
  getViewState(
    workspaceId: string,
    restoredState?: WorkspaceAppCenterViewState | null
  ): WorkspaceAppCenterViewState;
  getFactoryProviderConfiguration(input: {
    provider: string;
    workspaceId: string;
  }): Promise<WorkspaceAppFactoryProviderConfiguration>;
  prepareAppLaunch(input: {
    appId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppCenterApp | null>;
  importApp(input: { workspaceId: string }): Promise<void>;
  installApp(input: { appId: string; workspaceId: string }): Promise<void>;
  loadLocalApp(input: {
    workspaceId: string;
  }): Promise<WorkspaceAppLocalRepairRequest | null>;
  openAppFolder(input: { appId: string; workspaceId: string }): Promise<void>;
  openAppPackageFolder(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  prepareFactoryJobModification(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppFactoryJob | null>;
  publishFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void>;
  refresh(workspaceId: string): Promise<void>;
  refreshCatalog(workspaceId: string): Promise<void>;
  reloadLocalApp(input: { appId: string; workspaceId: string }): Promise<void>;
  replaceAppIcon(input: { appId: string; workspaceId: string }): Promise<void>;
  restartAndOpenApp(input: {
    appId: string;
    intent?: TuttiExternalWorkspaceOpenRouteIntent;
    workspaceId: string;
  }): Promise<boolean>;
  isWorkspaceAppViewOpen(input: {
    appId: string;
    workspaceId: string;
  }): boolean;
  retryFactoryValidation(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void>;
  retryApp(input: { appId: string; workspaceId: string }): Promise<void>;
  setViewState(input: {
    state: Partial<WorkspaceAppCenterViewState>;
    workspaceId: string;
  }): void;
  setWorkspaceAppLauncher(
    launcher:
      | ((input: {
          appId: string;
          intent?: TuttiExternalWorkspaceOpenRouteIntent;
          prepared: boolean;
          prevStatus?: WorkspaceAppCenterApp["runtimeStatus"];
          workspaceId: string;
        }) => Promise<boolean>)
      | null
  ): void;
  setWorkspaceAppViewCloser(
    closer: ((input: { appId: string; workspaceId: string }) => void) | null
  ): void;
  setWorkspaceAppViewOpenChecker(
    checker: ((input: { appId: string; workspaceId: string }) => boolean) | null
  ): void;
  startWorkspacePolling(workspaceId: string): () => void;
  subscribe(listener: () => void): () => void;
  uninstallApp(input: { appId: string; workspaceId: string }): Promise<void>;
  updateApp(input: {
    appId: string;
    trigger: "badge_button" | "primary_action";
    workspaceId: string;
  }): Promise<void>;
}

export const IWorkspaceAppCenterService =
  createDecorator<IWorkspaceAppCenterService>("workspace-app-center-service");
