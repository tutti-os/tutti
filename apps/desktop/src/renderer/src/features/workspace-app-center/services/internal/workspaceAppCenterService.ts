import type {
  DesktopHostFilesApi,
  DesktopRuntimeApi,
  DesktopHostWorkspaceApi
} from "@preload/types";
import type {
  AgentProviderComposerOptionsResponse,
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import { createDesktopErrorI18nRuntime } from "../../../../../../shared/i18n/index.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import {
  getDesktopErrorCode,
  resolveDesktopErrorMessage
} from "../../../../lib/desktopErrors.ts";
import { AppCenterAppDeletedReporter } from "../../../analytics/reporters/app-center-app-deleted/appCenterAppDeletedReporter.ts";
import { AppCenterAppInstallFailedReporter } from "../../../analytics/reporters/app-center-app-install-failed/appCenterAppInstallFailedReporter.ts";
import { AppCenterAppInstalledReporter } from "../../../analytics/reporters/app-center-app-installed/appCenterAppInstalledReporter.ts";
import { AppCenterAppStoppedReporter } from "../../../analytics/reporters/app-center-app-stopped/appCenterAppStoppedReporter.ts";
import { AppCenterAppUninstalledReporter } from "../../../analytics/reporters/app-center-app-uninstalled/appCenterAppUninstalledReporter.ts";
import { AppCenterAppUpdatedReporter } from "../../../analytics/reporters/app-center-app-updated/appCenterAppUpdatedReporter.ts";
import { AppCenterCatalogRefreshedReporter } from "../../../analytics/reporters/app-center-catalog-refreshed/appCenterCatalogRefreshedReporter.ts";
import { AppCenterFactoryJobCreatedReporter } from "../../../analytics/reporters/app-center-factory-job-created/appCenterFactoryJobCreatedReporter.ts";
import { ErrorAppRuntimeFailedReporter } from "../../../analytics/reporters/error-app-runtime-failed/errorAppRuntimeFailedReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppFactoryJob,
  WorkspaceAppFactoryProviderConfiguration,
  WorkspaceAppFactorySnapshot,
  WorkspaceAppCenterGateway,
  WorkspaceAppCenterRuntimeStatus,
  WorkspaceAppCenterSnapshot,
  WorkspaceAppCenterViewState
} from "../workspaceAppCenterTypes";
import {
  normalizeWorkspaceAppCenterApp,
  normalizeWorkspaceAppFactoryJob
} from "./adapters/desktopWorkspaceAppCenterGateway.ts";
import {
  recordWorkspaceAppCenterOperationFailure,
  type WorkspaceAppCenterOperationDetails
} from "./workspaceAppCenterDiagnostics.ts";
import { createWorkspaceAppCenterStore } from "./workspaceAppCenterStore.ts";

const catalogLoadingRefreshDelayMs = 750;
const appOpenLaunchWaitTimeoutMs = 35_000;
const installRefreshDelayMs = 750;
const factoryJobDiagnosticLimit = 20;
type AgentProviderComposerOptionsClient = Pick<
  TuttidClient,
  "getAgentProviderComposerOptions"
>;

export interface WorkspaceAppCenterServiceDependencies {
  eventStreamClient: TuttidEventStreamClient;
  appOpenLaunchWaitTimeoutMs?: number;
  gateway: WorkspaceAppCenterGateway;
  hostFilesApi: Pick<
    DesktopHostFilesApi,
    | "revealInFolder"
    | "selectAppArchive"
    | "selectAppArchiveExportPath"
    | "selectAppIconImage"
  >;
  hostWorkspaceApi: Pick<DesktopHostWorkspaceApi, "openWorkspaceAppFolder">;
  tuttidClient?: AgentProviderComposerOptionsClient;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi?: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
}

type WorkspaceAppLauncher = (input: {
  appId: string;
  prepared: boolean;
  prevStatus?: WorkspaceAppCenterRuntimeStatus;
  workspaceId: string;
}) => Promise<void>;

export class WorkspaceAppCenterService implements IWorkspaceAppCenterService {
  readonly _serviceBrand = undefined;
  readonly store = createWorkspaceAppCenterStore();

  private readonly dependencies: WorkspaceAppCenterServiceDependencies;
  private readonly listeners = new Set<() => void>();
  private workspaceAppLauncher: WorkspaceAppLauncher | null = null;
  private workspaceAppViewCloser:
    | ((input: { appId: string; workspaceId: string }) => void)
    | null = null;
  private catalogRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private installRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private pendingInstallKeys = new Set<string>();
  private pendingInstallReportKeys = new Set<string>();
  private pendingFactoryPublishKeys = new Set<string>();
  private appLoadSequence = 0;
  private factoryLoadSequence = 0;
  private updates: WorkspaceAppCenterUpdateState | null = null;

  constructor(dependencies: WorkspaceAppCenterServiceDependencies) {
    this.dependencies = dependencies;
  }

  consumeError(): string | null {
    const error = this.store.error;
    if (error === null) {
      return null;
    }
    this.store.error = null;
    this.bumpRevision();
    return error;
  }

  async installApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    const installKey = appRuntimeKey(input.workspaceId, input.appId);
    if (this.pendingInstallKeys.has(installKey)) {
      return;
    }
    const previousApps = this.store.apps;
    const appBeforeInstall =
      previousApps.find((app) => app.appId === input.appId) ?? null;
    this.pendingInstallKeys.add(installKey);
    this.pendingInstallReportKeys.add(installKey);
    this.markAppInstalling(input.appId);
    try {
      const snapshot = await this.dependencies.gateway.installWorkspaceApp(
        input.workspaceId,
        input.appId
      );
      this.applySnapshot(input.workspaceId, snapshot);
      if (this.pendingInstallKeys.has(installKey)) {
        this.scheduleInstallRefresh(input.workspaceId, input.appId);
      }
    } catch (error) {
      this.pendingInstallKeys.delete(installKey);
      this.pendingInstallReportKeys.delete(installKey);
      this.clearInstallRefreshTimer(input.workspaceId, input.appId);
      this.store.apps = previousApps;
      this.reportAppInstallFailed({
        app: appBeforeInstall,
        appId: input.appId,
        failureReason: getAnalyticsErrorReason(error)
      });
      this.recordOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.install",
        uiAction: "install_app",
        workspaceId: input.workspaceId
      });
    }
  }

  async openApp(input: { appId: string; workspaceId: string }): Promise<void> {
    const previousApp = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    const launchableApp = await this.prepareAppLaunch(input);
    if (!launchableApp) {
      return;
    }
    await this.workspaceAppLauncher?.({
      appId: launchableApp.appId,
      prepared: true,
      prevStatus: previousApp?.runtimeStatus ?? launchableApp.runtimeStatus,
      workspaceId: input.workspaceId
    });
  }

  getViewState(
    workspaceId: string,
    restoredState?: WorkspaceAppCenterViewState | null
  ): WorkspaceAppCenterViewState {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return normalizeWorkspaceAppCenterViewState(restoredState);
    }
    const existing = this.store.viewStateByWorkspaceId[normalizedWorkspaceId];
    if (existing) {
      return existing;
    }
    const nextState = normalizeWorkspaceAppCenterViewState(restoredState);
    this.store.viewStateByWorkspaceId = {
      ...this.store.viewStateByWorkspaceId,
      [normalizedWorkspaceId]: nextState
    };
    return nextState;
  }

  async prepareAppLaunch(input: {
    appId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppCenterApp | null> {
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    if (this.store.workspaceId !== input.workspaceId || !app?.installed) {
      return null;
    }
    const currentLaunchableApp = this.resolveLaunchableApp(input);
    if (currentLaunchableApp) {
      return currentLaunchableApp;
    }
    this.markAppStarting(input.appId);
    try {
      const snapshot = await this.dependencies.gateway.retryWorkspaceApp(
        input.workspaceId,
        input.appId
      );
      this.applySnapshot(input.workspaceId, snapshot);
    } catch (error) {
      this.recordOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.prepare_launch",
        uiAction: "open_app",
        workspaceId: input.workspaceId
      });
      return null;
    }

    const launchableApp = await this.waitForLaunchableApp(input);
    if (!launchableApp) {
      return null;
    }
    return launchableApp;
  }

  setViewState(input: {
    state: Partial<WorkspaceAppCenterViewState>;
    workspaceId: string;
  }): void {
    const normalizedWorkspaceId = input.workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return;
    }
    const previous = this.getViewState(normalizedWorkspaceId);
    const nextState = normalizeWorkspaceAppCenterViewState({
      ...previous,
      ...input.state
    });
    if (areWorkspaceAppCenterViewStatesEqual(previous, nextState)) {
      return;
    }
    this.store.viewStateByWorkspaceId = {
      ...this.store.viewStateByWorkspaceId,
      [normalizedWorkspaceId]: nextState
    };
    this.bumpRevision();
  }

  async createFactoryJob(input: {
    displayName: string;
    model?: string;
    permissionModeId?: string;
    provider?: string;
    prompt: string;
    reasoningEffort?: string;
    workspaceId: string;
  }): Promise<void> {
    const previousJobIds = new Set(
      this.store.factoryJobs.map((job) => job.jobId)
    );
    const snapshot =
      await this.dependencies.gateway.createWorkspaceAppFactoryJob(
        input.workspaceId,
        {
          displayName: input.displayName,
          ...(input.model?.trim() ? { model: input.model.trim() } : {}),
          ...(input.permissionModeId?.trim()
            ? { permissionModeId: input.permissionModeId.trim() }
            : {}),
          ...(input.provider?.trim()
            ? { provider: input.provider.trim() }
            : {}),
          prompt: input.prompt,
          ...(input.reasoningEffort?.trim()
            ? { reasoningEffort: input.reasoningEffort.trim() }
            : {})
        }
      );
    this.applyFactorySnapshot(input.workspaceId, snapshot);
    this.reportFactoryJobCreated(
      snapshot.jobs.find((job) => !previousJobIds.has(job.jobId)) ?? null
    );
  }

  async getFactoryProviderConfiguration(
    provider: string
  ): Promise<WorkspaceAppFactoryProviderConfiguration> {
    const normalizedProvider = provider.trim();
    if (!normalizedProvider || !this.dependencies.tuttidClient) {
      return emptyFactoryProviderConfiguration();
    }
    const response =
      await this.dependencies.tuttidClient.getAgentProviderComposerOptions(
        normalizedProvider as Parameters<
          AgentProviderComposerOptionsClient["getAgentProviderComposerOptions"]
        >[0]
      );
    return normalizeFactoryProviderConfiguration(response);
  }

  async cancelFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void> {
    const snapshot =
      await this.dependencies.gateway.cancelWorkspaceAppFactoryJob(
        input.workspaceId,
        input.jobId
      );
    this.applyFactorySnapshot(input.workspaceId, snapshot);
  }

  async deleteFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void> {
    const snapshot =
      await this.dependencies.gateway.deleteWorkspaceAppFactoryJob(
        input.workspaceId,
        input.jobId
      );
    this.applyFactorySnapshot(input.workspaceId, snapshot);
  }

  async deleteApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    try {
      const snapshot = await this.dependencies.gateway.deleteWorkspaceApp(
        input.workspaceId,
        input.appId
      );
      this.pendingInstallKeys.delete(
        appRuntimeKey(input.workspaceId, input.appId)
      );
      this.pendingInstallReportKeys.delete(
        appRuntimeKey(input.workspaceId, input.appId)
      );
      this.clearInstallRefreshTimer(input.workspaceId, input.appId);
      this.applySnapshot(input.workspaceId, snapshot);
      this.reportAppDeleted(app ?? null);
    } catch (error) {
      this.recordOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.delete",
        uiAction: "delete_app",
        workspaceId: input.workspaceId
      });
    }
  }

  async importApp(input: { workspaceId: string }): Promise<void> {
    const archivePath = await this.dependencies.hostFilesApi.selectAppArchive();
    if (!archivePath) {
      return;
    }
    try {
      const snapshot = await this.dependencies.gateway.importWorkspaceApp(
        input.workspaceId,
        { archivePath }
      );
      this.applySnapshot(input.workspaceId, snapshot);
    } catch (error) {
      this.recordOperationError(error, {
        operation: "workspace_app.import",
        uiAction: "import_app",
        workspaceId: input.workspaceId
      });
    }
  }

  async exportApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    if (!app?.exportable) {
      return;
    }
    const destinationPath =
      await this.dependencies.hostFilesApi.selectAppArchiveExportPath({
        defaultPath: defaultWorkspaceAppArchiveName(app)
      });
    if (!destinationPath) {
      return;
    }
    try {
      await this.dependencies.gateway.exportWorkspaceApp(
        input.workspaceId,
        input.appId,
        { destinationPath, ...(app.version ? { version: app.version } : {}) }
      );
      await this.dependencies.hostFilesApi.revealInFolder(destinationPath);
    } catch (error) {
      this.recordOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.export",
        uiAction: "export_app",
        workspaceId: input.workspaceId
      });
    }
  }

  async replaceAppIcon(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    const sourcePath =
      await this.dependencies.hostFilesApi.selectAppIconImage();
    if (!sourcePath) {
      return;
    }
    try {
      const app = await this.dependencies.gateway.replaceWorkspaceAppIcon(
        input.workspaceId,
        input.appId,
        { sourcePath }
      );
      this.applyAppSnapshot(input.workspaceId, app);
    } catch (error) {
      this.recordOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.replace_icon",
        uiAction: "replace_app_icon",
        workspaceId: input.workspaceId
      });
    }
  }

  async retryFactoryValidation(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void> {
    const snapshot =
      await this.dependencies.gateway.retryWorkspaceAppFactoryJobValidation(
        input.workspaceId,
        input.jobId
      );
    this.applyFactorySnapshot(input.workspaceId, snapshot);
  }

  async fixFactoryJob(input: {
    jobId: string;
    prompt: string;
    workspaceId: string;
  }): Promise<void> {
    const snapshot = await this.dependencies.gateway.fixWorkspaceAppFactoryJob(
      input.workspaceId,
      input.jobId,
      { prompt: input.prompt }
    );
    this.applyFactorySnapshot(input.workspaceId, snapshot);
  }

  async prepareFactoryJobModification(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppFactoryJob | null> {
    try {
      const snapshot =
        await this.dependencies.gateway.prepareWorkspaceAppFactoryJobModification(
          input.workspaceId,
          input.jobId
        );
      this.applyFactorySnapshot(input.workspaceId, snapshot);
      return (
        snapshot.jobs.find((candidate) => candidate.jobId === input.jobId) ??
        null
      );
    } catch (error) {
      this.recordOperationError(error, {
        jobId: input.jobId,
        operation: "app_factory.prepare_modification",
        uiAction: "prepare_factory_job_modification",
        workspaceId: input.workspaceId
      });
      return null;
    }
  }

  async publishFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void> {
    const publishKey = factoryJobKey(input.workspaceId, input.jobId);
    if (this.pendingFactoryPublishKeys.has(publishKey)) {
      return;
    }
    this.pendingFactoryPublishKeys.add(publishKey);
    let result: Awaited<
      ReturnType<WorkspaceAppCenterGateway["publishWorkspaceAppFactoryJob"]>
    >;
    try {
      result = await this.dependencies.gateway.publishWorkspaceAppFactoryJob(
        input.workspaceId,
        input.jobId
      );
    } catch (error) {
      if (this.pendingFactoryPublishKeys.delete(publishKey)) {
        this.recordOperationError(error, {
          jobId: input.jobId,
          operation: "app_factory.publish",
          uiAction: "publish_factory_job",
          workspaceId: input.workspaceId
        });
      }
      return;
    }
    this.pendingFactoryPublishKeys.delete(publishKey);
    this.applyFactorySnapshot(input.workspaceId, result.factorySnapshot);
    this.applySnapshot(input.workspaceId, result.appSnapshot);
    const job = result.factorySnapshot.jobs.find(
      (candidate) => candidate.jobId === input.jobId
    );
    if (job?.appId) {
      await this.openApp({ appId: job.appId, workspaceId: input.workspaceId });
    }
  }

  async refresh(workspaceId: string): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return;
    }

    const appSequence = ++this.appLoadSequence;
    const factorySequence = ++this.factoryLoadSequence;
    const wasIdle = this.store.loadStatus === "idle";
    this.store.workspaceId = normalizedWorkspaceId;
    this.store.error = null;
    if (wasIdle) {
      this.store.loadStatus = "loading";
    }

    try {
      const [appResult, factoryResult] = await Promise.allSettled([
        this.dependencies.gateway.listWorkspaceApps(normalizedWorkspaceId),
        this.dependencies.gateway.listWorkspaceAppFactoryJobs(
          normalizedWorkspaceId
        )
      ]);

      if (
        appResult.status === "fulfilled" &&
        appSequence !== this.appLoadSequence
      ) {
        this.recordRefreshDiscard({
          currentSequence: this.appLoadSequence,
          itemCount: appResult.value.apps.length,
          operation: "app_center.refresh",
          sequence: appSequence,
          snapshotKind: "apps",
          workspaceId: normalizedWorkspaceId
        });
      }
      if (
        factoryResult.status === "fulfilled" &&
        factorySequence !== this.factoryLoadSequence
      ) {
        this.recordRefreshDiscard({
          currentSequence: this.factoryLoadSequence,
          itemCount: factoryResult.value.jobs.length,
          operation: "app_center.refresh",
          sequence: factorySequence,
          snapshotKind: "factory_jobs",
          workspaceId: normalizedWorkspaceId
        });
      }

      let error: unknown = null;
      if (
        appResult.status === "rejected" &&
        appSequence === this.appLoadSequence
      ) {
        error = appResult.reason;
      } else if (
        factoryResult.status === "rejected" &&
        factorySequence === this.factoryLoadSequence
      ) {
        error = factoryResult.reason;
      }
      if (error) {
        const message = formatAppCenterError(error);
        this.recordOperationFailure(error, message, {
          operation: "app_center.refresh",
          workspaceId: normalizedWorkspaceId
        });
        this.store.error = message;
        this.store.loadStatus = "unavailable";
        this.bumpRevision();
        return;
      }

      if (
        appResult.status === "fulfilled" &&
        appSequence === this.appLoadSequence
      ) {
        this.applySnapshot(normalizedWorkspaceId, appResult.value);
      }
      if (
        factoryResult.status === "fulfilled" &&
        factorySequence === this.factoryLoadSequence
      ) {
        this.applyFactorySnapshot(normalizedWorkspaceId, factoryResult.value);
      }
    } catch (error) {
      const message = formatAppCenterError(error);
      this.recordOperationFailure(error, message, {
        operation: "app_center.refresh",
        workspaceId: normalizedWorkspaceId
      });
      this.store.error = message;
      this.store.loadStatus = "unavailable";
      this.bumpRevision();
    }
  }

  async refreshCatalog(workspaceId: string): Promise<void> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return;
    }

    const sequence = ++this.appLoadSequence;
    this.store.workspaceId = normalizedWorkspaceId;
    this.store.error = null;
    try {
      const snapshot =
        await this.dependencies.gateway.refreshWorkspaceAppCatalog(
          normalizedWorkspaceId
        );
      if (sequence !== this.appLoadSequence) {
        this.recordRefreshDiscard({
          currentSequence: this.appLoadSequence,
          itemCount: snapshot.apps.length,
          operation: "app_center.refresh_catalog",
          sequence,
          snapshotKind: "catalog_apps",
          workspaceId: normalizedWorkspaceId
        });
        return;
      }
      this.applySnapshot(normalizedWorkspaceId, snapshot);
      this.reportCatalogRefreshed({
        appCount: snapshot.apps.length,
        errorReason: null,
        success: true
      });
    } catch (error) {
      if (sequence !== this.appLoadSequence) {
        this.recordRefreshDiscard({
          currentSequence: this.appLoadSequence,
          operation: "app_center.refresh_catalog",
          sequence,
          snapshotKind: "catalog_apps",
          workspaceId: normalizedWorkspaceId
        });
        return;
      }
      const message = formatAppCenterError(error);
      this.recordOperationFailure(error, message, {
        operation: "app_center.refresh_catalog",
        workspaceId: normalizedWorkspaceId
      });
      this.store.error = message;
      this.store.loadStatus = "unavailable";
      this.bumpRevision();
      this.reportCatalogRefreshed({
        appCount: null,
        errorReason: getAnalyticsErrorReason(error),
        success: false
      });
    }
  }

  startWorkspacePolling(workspaceId: string): () => void {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return noop;
    }

    if (this.updates?.workspaceId === normalizedWorkspaceId) {
      return this.updates.dispose;
    }

    this.updates?.dispose();
    let disposed = false;
    let hasConnected = false;
    let startupRefreshActive = true;

    const unsubscribeAppUpdated = this.dependencies.eventStreamClient.subscribe(
      "workspace.app.updated",
      (event) => {
        if (!disposed) {
          this.applyAppUpdate(normalizedWorkspaceId, event.payload.app);
        }
      },
      {
        scope: {
          workspaceId: normalizedWorkspaceId
        }
      }
    );
    const unsubscribeFactoryJobUpdated =
      this.dependencies.eventStreamClient.subscribe(
        "workspace.appfactory.job.updated",
        (event) => {
          if (!disposed) {
            this.applyFactoryJobUpdate(
              normalizedWorkspaceId,
              normalizeWorkspaceAppFactoryJob(event.payload.job)
            );
          }
        },
        {
          scope: {
            workspaceId: normalizedWorkspaceId
          }
        }
      );
    const unsubscribeConnectionState =
      this.dependencies.eventStreamClient.subscribeConnectionState((state) => {
        if (disposed || state !== "connected") {
          return;
        }
        if (hasConnected) {
          void this.refresh(normalizedWorkspaceId);
          return;
        }
        if (!startupRefreshActive) {
          hasConnected = true;
          void this.refresh(normalizedWorkspaceId);
          return;
        }
        hasConnected = true;
      });

    void this.startWorkspaceUpdates(
      normalizedWorkspaceId,
      () => disposed,
      () => {
        hasConnected = true;
      },
      () => {
        startupRefreshActive = false;
      }
    );

    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeConnectionState();
      unsubscribeAppUpdated();
      unsubscribeFactoryJobUpdated();
      this.clearCatalogRefreshTimer();
      this.clearInstallRefreshTimers();
      if (this.updates?.workspaceId === normalizedWorkspaceId) {
        this.updates = null;
      }
    };
    this.updates = {
      dispose,
      workspaceId: normalizedWorkspaceId
    };
    return dispose;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async openAppFolder(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    this.store.openingFolderAppId = input.appId;
    try {
      await this.dependencies.hostWorkspaceApi.openWorkspaceAppFolder({
        ...input,
        folderKind: "workspace"
      });
    } finally {
      if (this.store.openingFolderAppId === input.appId) {
        this.store.openingFolderAppId = null;
      }
    }
  }

  async openAppPackageFolder(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    if (!app || app.source === "builtin") {
      return;
    }
    const version = app?.version?.trim();
    if (!version) {
      return;
    }
    this.store.openingFolderAppId = input.appId;
    try {
      await this.dependencies.hostWorkspaceApi.openWorkspaceAppFolder({
        ...input,
        folderKind: "package",
        version
      });
    } finally {
      if (this.store.openingFolderAppId === input.appId) {
        this.store.openingFolderAppId = null;
      }
    }
  }

  async uninstallApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    const snapshot = await this.dependencies.gateway.uninstallWorkspaceApp(
      input.workspaceId,
      input.appId
    );
    this.applySnapshot(input.workspaceId, snapshot);
    this.reportAppUninstalled(app ?? null);
  }

  async updateApp(input: {
    appId: string;
    trigger: "badge_button" | "primary_action";
    workspaceId: string;
  }): Promise<void> {
    const installKey = appRuntimeKey(input.workspaceId, input.appId);
    if (this.pendingInstallKeys.has(installKey)) {
      return;
    }
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    const previousApps = this.store.apps;
    this.pendingInstallKeys.add(installKey);
    this.markAppInstalling(input.appId, { preserveInstalled: true });
    try {
      const snapshot = await this.dependencies.gateway.installWorkspaceApp(
        input.workspaceId,
        input.appId
      );
      this.applySnapshot(input.workspaceId, snapshot);
      this.reportAppUpdated({
        app,
        trigger: input.trigger
      });
      if (this.pendingInstallKeys.has(installKey)) {
        this.scheduleInstallRefresh(input.workspaceId, input.appId);
      }
    } catch (error) {
      this.pendingInstallKeys.delete(installKey);
      this.clearInstallRefreshTimer(input.workspaceId, input.appId);
      this.store.apps = previousApps;
      this.recordOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.update",
        uiAction: "update_app",
        workspaceId: input.workspaceId
      });
    }
  }

  async retryApp(input: { appId: string; workspaceId: string }): Promise<void> {
    this.markAppStarting(input.appId);
    const snapshot = await this.dependencies.gateway.retryWorkspaceApp(
      input.workspaceId,
      input.appId
    );
    this.applySnapshot(input.workspaceId, snapshot);
  }

  setWorkspaceAppLauncher(launcher: WorkspaceAppLauncher | null): void {
    this.workspaceAppLauncher = launcher;
  }

  setWorkspaceAppViewCloser(
    closer: ((input: { appId: string; workspaceId: string }) => void) | null
  ): void {
    this.workspaceAppViewCloser = closer;
  }

  private applySnapshot(
    workspaceId: string,
    snapshot: WorkspaceAppCenterSnapshot
  ): void {
    const nextApps = sortWorkspaceAppCenterApps(
      this.mergeSnapshotAppsByStateRevision(
        workspaceId,
        this.withPendingInstallState(workspaceId, snapshot.apps)
      )
    );
    for (const app of nextApps) {
      this.settlePendingInstallReport({
        app,
        failureReason: app.failureReason ?? app.lastError ?? null,
        workspaceId
      });
    }
    const appIdsToClose =
      this.store.workspaceId === workspaceId
        ? removedOrUninstalledAppIds(this.store.apps, nextApps)
        : [];
    this.scheduleCatalogLoadingRefresh(workspaceId, snapshot);
    const changed =
      this.store.workspaceId !== workspaceId ||
      this.store.catalogLastError !== (snapshot.catalogLastError ?? null) ||
      this.store.catalogStatus !== snapshot.catalogStatus ||
      this.store.catalogUpdatedAtUnixMs !==
        (snapshot.catalogUpdatedAtUnixMs ?? null) ||
      this.store.error !== null ||
      this.store.loadStatus !== "ready" ||
      !areWorkspaceAppCenterAppsEqual(this.store.apps, nextApps);
    if (!changed) {
      return;
    }
    this.store.apps = nextApps;
    this.store.catalogLastError = snapshot.catalogLastError ?? null;
    this.store.catalogStatus = snapshot.catalogStatus;
    this.store.catalogUpdatedAtUnixMs = snapshot.catalogUpdatedAtUnixMs ?? null;
    this.store.error = null;
    this.store.loadStatus = "ready";
    this.store.workspaceId = workspaceId;
    this.bumpRevision();
    this.closeWorkspaceAppViews(workspaceId, appIdsToClose);
  }

  private mergeSnapshotAppsByStateRevision(
    workspaceId: string,
    snapshotApps: readonly WorkspaceAppCenterApp[]
  ): WorkspaceAppCenterApp[] {
    if (this.store.workspaceId !== workspaceId) {
      return [...snapshotApps];
    }
    const currentAppsById = new Map(
      this.store.apps.map((app) => [app.appId, app])
    );
    return snapshotApps.map((snapshotApp) => {
      const currentApp = currentAppsById.get(snapshotApp.appId);
      if (!currentApp || currentApp.stateRevision < snapshotApp.stateRevision) {
        return snapshotApp;
      }
      const installKey = appRuntimeKey(workspaceId, snapshotApp.appId);
      if (this.pendingInstallKeys.has(installKey)) {
        const pendingSettled = this.isPendingInstallSettled(
          installKey,
          snapshotApp
        );
        if (
          pendingSettled &&
          currentApp.stateRevision <= snapshotApp.stateRevision
        ) {
          return snapshotApp;
        }
      }
      return mergeWorkspaceAppCatalogFields(currentApp, snapshotApp);
    });
  }

  private scheduleCatalogLoadingRefresh(
    workspaceId: string,
    snapshot: WorkspaceAppCenterSnapshot
  ): void {
    if (snapshot.catalogStatus !== "loading") {
      this.clearCatalogRefreshTimer();
      return;
    }
    if (this.updates?.workspaceId !== workspaceId || this.catalogRefreshTimer) {
      return;
    }
    this.catalogRefreshTimer = setTimeout(() => {
      this.catalogRefreshTimer = null;
      if (this.updates?.workspaceId !== workspaceId) {
        return;
      }
      void this.refresh(workspaceId);
    }, catalogLoadingRefreshDelayMs);
  }

  private clearCatalogRefreshTimer(): void {
    if (!this.catalogRefreshTimer) {
      return;
    }
    clearTimeout(this.catalogRefreshTimer);
    this.catalogRefreshTimer = null;
  }

  private withPendingInstallState(
    workspaceId: string,
    apps: readonly WorkspaceAppCenterApp[]
  ): WorkspaceAppCenterApp[] {
    return apps.map((app) => {
      const installKey = appRuntimeKey(workspaceId, app.appId);
      if (!this.pendingInstallKeys.has(installKey)) {
        return app;
      }
      if (this.isPendingInstallSettled(installKey, app)) {
        return app;
      }
      return {
        ...app,
        enabled: true,
        installed: this.pendingInstallReportKeys.has(installKey)
          ? false
          : app.installed,
        runtimeStatus: "installing"
      };
    });
  }

  private scheduleInstallRefresh(workspaceId: string, appId: string): void {
    const key = appRuntimeKey(workspaceId, appId);
    if (this.installRefreshTimers.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      this.installRefreshTimers.delete(key);
      if (!this.pendingInstallKeys.has(key)) {
        return;
      }
      void this.refreshInstallState(workspaceId, appId);
    }, installRefreshDelayMs);
    this.installRefreshTimers.set(key, timer);
  }

  private clearInstallRefreshTimer(workspaceId: string, appId: string): void {
    const key = appRuntimeKey(workspaceId, appId);
    const timer = this.installRefreshTimers.get(key);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.installRefreshTimers.delete(key);
  }

  private clearInstallRefreshTimers(): void {
    for (const timer of this.installRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.installRefreshTimers.clear();
    this.pendingInstallKeys.clear();
    this.pendingInstallReportKeys.clear();
  }

  private async refreshInstallState(
    workspaceId: string,
    appId: string
  ): Promise<void> {
    try {
      const snapshot =
        await this.dependencies.gateway.listWorkspaceApps(workspaceId);
      this.applySnapshot(workspaceId, snapshot);
    } catch (error) {
      this.recordOperationError(error, {
        appId,
        operation: "workspace_app.refresh_install_state",
        uiAction: "refresh_install_state",
        workspaceId
      });
    }
    if (this.pendingInstallKeys.has(appRuntimeKey(workspaceId, appId))) {
      this.scheduleInstallRefresh(workspaceId, appId);
    }
  }

  private applyFactorySnapshot(
    workspaceId: string,
    snapshot: WorkspaceAppFactorySnapshot
  ): void {
    if (this.store.workspaceId !== workspaceId) {
      this.store.workspaceId = workspaceId;
    }
    const nextJobs = sortWorkspaceAppFactoryJobs(snapshot.jobs);
    if (areWorkspaceAppFactoryJobsEqual(this.store.factoryJobs, nextJobs)) {
      return;
    }
    const previousJobs = this.store.factoryJobs;
    this.store.factoryJobs = nextJobs;
    this.recordFactorySnapshotApplied(workspaceId, previousJobs, nextJobs);
    this.bumpRevision();
  }

  private applyAppUpdate(
    workspaceId: string,
    app: Parameters<typeof normalizeWorkspaceAppCenterApp>[0]
  ): void {
    if (this.store.workspaceId !== workspaceId) {
      return;
    }
    const currentApp = this.store.apps.find(
      (candidate) => candidate.appId === app.appId
    );
    if (!currentApp) {
      return;
    }
    const nextApp = normalizeWorkspaceAppCenterApp({
      ...app,
      createdAtUnixMs: app.createdAtUnixMs ?? currentApp.createdAtUnixMs
    });
    const acceptedRuntimeTransition =
      nextApp.stateRevision > currentApp.stateRevision;
    if (
      acceptedRuntimeTransition &&
      nextApp.runtimeStatus === "failed" &&
      currentApp.runtimeStatus !== "failed"
    ) {
      this.reportAppRuntimeFailed({
        app: nextApp,
        failureReason: app.failureReason ?? app.lastError ?? null
      });
    }
    if (
      acceptedRuntimeTransition &&
      currentApp.runtimeStatus === "running" &&
      nextApp.runtimeStatus !== "running"
    ) {
      this.reportAppStopped({
        app: currentApp,
        runDurationMs: resolveAppRunDurationMs(
          app.startedAtUnixMs,
          this.dependencies.reporterNow?.() ?? Date.now()
        )
      });
    }
    this.applyAppSnapshot(workspaceId, nextApp, {
      installFailureReason: app.failureReason ?? app.lastError ?? null
    });
  }

  private applyAppSnapshot(
    workspaceId: string,
    nextApp: WorkspaceAppCenterApp,
    options: { installFailureReason?: string | null } = {}
  ): void {
    if (this.store.workspaceId !== workspaceId) {
      return;
    }
    const currentApp = this.store.apps.find(
      (candidate) => candidate.appId === nextApp.appId
    );
    if (currentApp && nextApp.stateRevision <= currentApp.stateRevision) {
      this.settlePendingInstallReport({
        app: currentApp,
        failureReason:
          options.installFailureReason ??
          currentApp.failureReason ??
          currentApp.lastError ??
          null,
        workspaceId
      });
      return;
    }
    const appIdsToClose =
      currentApp?.installed === true && !nextApp.installed
        ? [nextApp.appId]
        : [];

    const nextApps = sortWorkspaceAppCenterApps([
      ...this.store.apps.filter(
        (candidate) => candidate.appId !== nextApp.appId
      ),
      nextApp
    ]);
    if (areWorkspaceAppCenterAppsEqual(this.store.apps, nextApps)) {
      return;
    }
    this.store.apps = nextApps;
    this.store.error = null;
    this.store.loadStatus = "ready";
    this.bumpRevision();
    this.settlePendingInstallReport({
      app: nextApp,
      failureReason:
        options.installFailureReason ??
        nextApp.failureReason ??
        nextApp.lastError ??
        null,
      workspaceId
    });
    this.closeWorkspaceAppViews(workspaceId, appIdsToClose);
  }

  private applyFactoryJobUpdate(
    workspaceId: string,
    job: WorkspaceAppFactoryJob
  ): void {
    if (this.store.workspaceId !== workspaceId) {
      return;
    }
    const currentJob = this.store.factoryJobs.find(
      (candidate) => candidate.jobId === job.jobId
    );
    if (currentJob && job.updatedAtUnixMs < currentJob.updatedAtUnixMs) {
      return;
    }
    const nextJobs = sortWorkspaceAppFactoryJobs([
      ...this.store.factoryJobs.filter(
        (candidate) => candidate.jobId !== job.jobId
      ),
      job
    ]);
    if (areWorkspaceAppFactoryJobsEqual(this.store.factoryJobs, nextJobs)) {
      return;
    }
    this.store.factoryJobs = nextJobs;
    this.bumpRevision();
  }

  private async startWorkspaceUpdates(
    workspaceId: string,
    isDisposed: () => boolean,
    markConnected: () => void,
    markStartupRefreshSettled: () => void
  ): Promise<void> {
    try {
      await this.dependencies.eventStreamClient.connect();
      if (isDisposed()) {
        return;
      }
      await this.refresh(workspaceId);
      if (isDisposed()) {
        return;
      }
      markConnected();
      await this.startEnabledApps(workspaceId);
    } catch (error) {
      if (isDisposed()) {
        return;
      }
      const message = formatAppCenterError(error);
      this.recordOperationFailure(error, message, {
        operation: "app_center.start_workspace_updates",
        workspaceId
      });
      this.store.error = message;
      this.store.loadStatus = "unavailable";
      this.bumpRevision();
    } finally {
      markStartupRefreshSettled();
    }
  }

  private async startEnabledApps(workspaceId: string): Promise<void> {
    this.markEnabledAppsStarting();
    try {
      const snapshot =
        await this.dependencies.gateway.startEnabledWorkspaceApps(workspaceId);
      this.applySnapshot(workspaceId, snapshot);
    } catch (error) {
      const message = formatAppCenterError(error);
      this.recordOperationFailure(error, message, {
        operation: "workspace_app.start_enabled",
        workspaceId
      });
      this.store.error = message;
      this.store.loadStatus = "unavailable";
      this.bumpRevision();
    }
  }

  private markAppStarting(appId: string): void {
    this.store.apps = this.store.apps.map((app) =>
      app.appId === appId
        ? {
            ...app,
            enabled: true,
            installed: true,
            runtimeStatus: "preparing"
          }
        : app
    );
    this.bumpRevision();
  }

  private waitForLaunchableApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppCenterApp | null> {
    const current = this.resolveLaunchableApp(input);
    if (current) {
      return Promise.resolve(current);
    }
    if (this.shouldAbortLaunchWait(input)) {
      return Promise.resolve(null);
    }

    const launchWaitTimeoutMs =
      this.dependencies.appOpenLaunchWaitTimeoutMs ??
      appOpenLaunchWaitTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = noop;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settle = (app: WorkspaceAppCenterApp | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        unsubscribe();
        resolve(app);
      };
      timeout = setTimeout(() => {
        void this.refreshLaunchWaitState(input).then((app) => {
          if (!app) {
            this.markLaunchWaitTimedOut(input);
          }
          settle(app);
        });
      }, launchWaitTimeoutMs);
      unsubscribe = this.subscribe(() => {
        const app = this.store.apps.find(
          (candidate) => candidate.appId === input.appId
        );
        if (this.shouldAbortLaunchWait(input, app)) {
          settle(null);
          return;
        }
        const launchable = this.resolveLaunchableApp(input);
        if (launchable) {
          settle(launchable);
        }
      });
    });
  }

  private async refreshLaunchWaitState(input: {
    appId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppCenterApp | null> {
    try {
      const snapshot = await this.dependencies.gateway.listWorkspaceApps(
        input.workspaceId
      );
      this.applySnapshot(input.workspaceId, snapshot);
    } catch (error) {
      this.recordOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.refresh_launch_wait_state",
        uiAction: "refresh_launch_wait_state",
        workspaceId: input.workspaceId
      });
      return null;
    }
    return this.resolveLaunchableApp(input);
  }

  private markLaunchWaitTimedOut(input: {
    appId: string;
    workspaceId: string;
  }): void {
    if (this.store.workspaceId !== input.workspaceId) {
      return;
    }
    let changed = false;
    this.store.apps = this.store.apps.map((app) => {
      if (
        app.appId !== input.appId ||
        !app.installed ||
        (app.runtimeStatus !== "preparing" && app.runtimeStatus !== "starting")
      ) {
        return app;
      }
      changed = true;
      return {
        ...app,
        runtimeStatus: "failed"
      };
    });
    if (changed) {
      this.bumpRevision();
    }
  }

  private shouldAbortLaunchWait(
    input: { appId: string; workspaceId: string },
    app = this.store.apps.find((candidate) => candidate.appId === input.appId)
  ): boolean {
    return (
      this.store.workspaceId !== input.workspaceId ||
      !app?.installed ||
      app.runtimeStatus === "failed"
    );
  }

  private resolveLaunchableApp(input: {
    appId: string;
    workspaceId: string;
  }): WorkspaceAppCenterApp | null {
    if (this.store.workspaceId !== input.workspaceId) {
      return null;
    }
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    return app?.installed && app.runtimeStatus === "running" && app.url
      ? app
      : null;
  }

  private markAppInstalling(
    appId: string,
    options: { preserveInstalled?: boolean } = {}
  ): void {
    this.store.apps = this.store.apps.map((app) =>
      app.appId === appId
        ? {
            ...app,
            availableVersion: null,
            enabled: true,
            installed:
              options.preserveInstalled === true ? app.installed : false,
            runtimeStatus: "installing",
            updateAvailable: false
          }
        : app
    );
    this.bumpRevision();
  }

  private markEnabledAppsStarting(): void {
    let changed = false;
    this.store.apps = this.store.apps.map((app) => {
      if (
        !app.enabled ||
        !app.installed ||
        app.runtimeStatus === "running" ||
        app.runtimeStatus === "preparing" ||
        app.runtimeStatus === "starting"
      ) {
        return app;
      }
      changed = true;
      return {
        ...app,
        runtimeStatus: "preparing"
      };
    });
    if (changed) {
      this.bumpRevision();
    }
  }

  private recordOperationError(
    error: unknown,
    details: WorkspaceAppCenterOperationDetails
  ): void {
    const message = formatAppCenterError(error, details);
    this.recordOperationFailure(error, message, details);
    this.store.error = message;
    this.bumpRevision();
  }

  private recordOperationFailure(
    error: unknown,
    toastMessage: string,
    details: WorkspaceAppCenterOperationDetails
  ): void {
    recordWorkspaceAppCenterOperationFailure({
      details,
      error,
      runtimeApi: this.dependencies.runtimeApi,
      toastMessage
    });
  }

  private recordRefreshDiscard(input: {
    currentSequence: number;
    itemCount?: number;
    operation: "app_center.refresh" | "app_center.refresh_catalog";
    sequence: number;
    snapshotKind: "apps" | "catalog_apps" | "factory_jobs";
    workspaceId: string;
  }): void {
    this.recordRendererDiagnostic({
      details: {
        currentSequence: input.currentSequence,
        itemCount: input.itemCount ?? null,
        operation: input.operation,
        sequence: input.sequence,
        snapshotKind: input.snapshotKind
      },
      event: "workspace_app_center_refresh_snapshot_discarded",
      level: "debug",
      workspaceId: input.workspaceId
    });
  }

  private recordFactorySnapshotApplied(
    workspaceId: string,
    previousJobs: readonly WorkspaceAppFactoryJob[],
    nextJobs: readonly WorkspaceAppFactoryJob[]
  ): void {
    this.recordRendererDiagnostic({
      details: {
        afterCount: nextJobs.length,
        beforeCount: previousJobs.length,
        jobs: summarizeFactoryJobsForDiagnostic(nextJobs),
        truncated: nextJobs.length > factoryJobDiagnosticLimit
      },
      event: "workspace_app_center_factory_snapshot_applied",
      level: "debug",
      workspaceId
    });
  }

  private recordRendererDiagnostic(input: {
    details: Record<string, unknown>;
    event: string;
    level: "debug" | "info" | "warn" | "error";
    workspaceId: string;
  }): void {
    void this.dependencies.runtimeApi
      ?.logRendererDiagnostic({
        details: input.details,
        event: input.event,
        level: input.level,
        source: "workspace-app-center",
        workspaceId: input.workspaceId
      })
      .catch(() => undefined);
  }

  private bumpRevision(): void {
    this.store.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private closeWorkspaceAppViews(
    workspaceId: string,
    appIds: readonly string[]
  ): void {
    if (!this.workspaceAppViewCloser || appIds.length === 0) {
      return;
    }
    for (const appId of appIds) {
      this.workspaceAppViewCloser({ appId, workspaceId });
    }
  }

  private settlePendingInstallReport(input: {
    app: WorkspaceAppCenterApp;
    failureReason: string | null;
    workspaceId: string;
  }): void {
    const installKey = appRuntimeKey(input.workspaceId, input.app.appId);
    if (!this.pendingInstallKeys.has(installKey)) {
      return;
    }
    if (!this.isPendingInstallSettled(installKey, input.app)) {
      return;
    }

    this.pendingInstallKeys.delete(installKey);
    this.clearInstallRefreshTimer(input.workspaceId, input.app.appId);
    if (!this.pendingInstallReportKeys.delete(installKey)) {
      return;
    }
    if (input.app.installed) {
      this.reportAppInstalled(input.app);
      return;
    }
    this.reportAppInstallFailed({
      app: input.app,
      appId: input.app.appId,
      failureReason:
        input.failureReason ??
        input.app.failureReason ??
        input.app.lastError ??
        null
    });
  }

  private isPendingInstallSettled(
    installKey: string,
    app: WorkspaceAppCenterApp
  ): boolean {
    if (app.runtimeStatus === "failed") {
      return true;
    }
    if (this.pendingInstallReportKeys.has(installKey)) {
      return app.installed;
    }
    return app.installed && !app.updateAvailable && !app.availableVersion;
  }

  private reportAppInstalled(app: WorkspaceAppCenterApp | null): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies || !app) {
      return;
    }

    void new AppCenterAppInstalledReporter(
      {
        appId: app.appId,
        appSource: app.source
      },
      dependencies
    ).report();
  }

  private reportAppInstallFailed(input: {
    app: WorkspaceAppCenterApp | null;
    appId: string;
    failureReason: string | null;
  }): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies) {
      return;
    }

    void new AppCenterAppInstallFailedReporter(
      {
        appId: input.app?.appId ?? input.appId,
        appSource: input.app?.source ?? null,
        failureReason: input.failureReason
      },
      dependencies
    ).report();
  }

  private reportAppDeleted(app: WorkspaceAppCenterApp | null): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies || !app) {
      return;
    }

    void new AppCenterAppDeletedReporter(
      {
        appId: app.appId,
        appSource: app.source
      },
      dependencies
    ).report();
  }

  private reportAppUninstalled(app: WorkspaceAppCenterApp | null): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies || !app) {
      return;
    }

    void new AppCenterAppUninstalledReporter(
      {
        appId: app.appId,
        appSource: app.source
      },
      dependencies
    ).report();
  }

  private reportAppStopped(input: {
    app: WorkspaceAppCenterApp;
    runDurationMs: number | null;
  }): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies) {
      return;
    }

    void new AppCenterAppStoppedReporter(
      {
        appId: input.app.appId,
        appSource: input.app.source,
        runDurationMs: input.runDurationMs
      },
      dependencies
    ).report();
  }

  private reportAppUpdated(input: {
    app: WorkspaceAppCenterApp | undefined;
    trigger: "badge_button" | "primary_action";
  }): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies || !input.app?.availableVersion) {
      return;
    }

    void new AppCenterAppUpdatedReporter(
      {
        appId: input.app.appId,
        appSource: input.app.source,
        availableVersion: input.app.availableVersion,
        trigger: input.trigger
      },
      dependencies
    ).report();
  }

  private reportCatalogRefreshed(input: {
    appCount: number | null;
    errorReason: string | null;
    success: boolean;
  }): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies) {
      return;
    }

    void new AppCenterCatalogRefreshedReporter(input, dependencies).report();
  }

  private reportFactoryJobCreated(job: WorkspaceAppFactoryJob | null): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies || !job) {
      return;
    }

    void new AppCenterFactoryJobCreatedReporter(
      {
        jobId: job.jobId,
        model: job.model ?? null,
        provider: job.provider ?? null,
        reasoningEffort: job.reasoningEffort ?? null,
        status: job.status,
        workspaceId: job.workspaceId
      },
      dependencies
    ).report();
  }

  private reporterDependencies(): {
    now?: () => number;
    reporterService: Pick<IReporterService, "trackEvents">;
  } | null {
    if (!this.dependencies.reporterService) {
      return null;
    }

    return {
      now: this.dependencies.reporterNow,
      reporterService: this.dependencies.reporterService
    };
  }

  private reportAppRuntimeFailed(input: {
    app: WorkspaceAppCenterApp;
    failureReason: string | null;
  }): void {
    const dependencies = this.reporterDependencies();
    if (!dependencies) {
      return;
    }

    void new ErrorAppRuntimeFailedReporter(
      {
        appId: input.app.appId,
        appSource: input.app.source,
        failureReason: input.failureReason
      },
      dependencies
    ).report();
  }
}

interface WorkspaceAppCenterUpdateState {
  dispose: () => void;
  workspaceId: string;
}

function getAnalyticsErrorReason(error: unknown): string {
  return getDesktopErrorCode(error) ?? "unknown";
}

function resolveAppRunDurationMs(
  startedAtUnixMs: number | null | undefined,
  now: number
) {
  if (
    typeof startedAtUnixMs !== "number" ||
    !Number.isFinite(startedAtUnixMs) ||
    startedAtUnixMs <= 0
  ) {
    return null;
  }

  return Math.max(0, now - startedAtUnixMs);
}

function sortWorkspaceAppCenterApps(
  apps: readonly WorkspaceAppCenterApp[]
): WorkspaceAppCenterApp[] {
  return [...apps].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

function mergeWorkspaceAppCatalogFields(
  currentApp: WorkspaceAppCenterApp,
  snapshotApp: WorkspaceAppCenterApp
): WorkspaceAppCenterApp {
  return {
    ...currentApp,
    availableIconUrl: snapshotApp.availableIconUrl,
    availableVersion: snapshotApp.availableVersion,
    description: snapshotApp.description,
    iconUrl: snapshotApp.iconUrl,
    localizations: snapshotApp.localizations,
    minimizeBehavior: snapshotApp.minimizeBehavior,
    name: snapshotApp.name,
    source: snapshotApp.source,
    tags: snapshotApp.tags,
    updateAvailable: snapshotApp.updateAvailable
  };
}

function areWorkspaceAppCenterAppsEqual(
  left: readonly WorkspaceAppCenterApp[],
  right: readonly WorkspaceAppCenterApp[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((leftApp, index) => {
    const rightApp = right[index];
    return (
      rightApp !== undefined &&
      leftApp.appId === rightApp.appId &&
      leftApp.availableIconUrl === rightApp.availableIconUrl &&
      leftApp.availableVersion === rightApp.availableVersion &&
      leftApp.createdAtUnixMs === rightApp.createdAtUnixMs &&
      leftApp.description === rightApp.description &&
      leftApp.enabled === rightApp.enabled &&
      leftApp.exportable === rightApp.exportable &&
      leftApp.iconUrl === rightApp.iconUrl &&
      leftApp.installed === rightApp.installed &&
      areWorkspaceAppCenterLocalizationsEqual(
        leftApp.localizations ?? [],
        rightApp.localizations ?? []
      ) &&
      leftApp.minimizeBehavior === rightApp.minimizeBehavior &&
      leftApp.name === rightApp.name &&
      leftApp.runtimeStatus === rightApp.runtimeStatus &&
      leftApp.source === rightApp.source &&
      leftApp.stateRevision === rightApp.stateRevision &&
      areStringArraysEqual(leftApp.tags ?? [], rightApp.tags ?? []) &&
      (leftApp.updateAvailable ?? false) ===
        (rightApp.updateAvailable ?? false) &&
      leftApp.url === rightApp.url &&
      leftApp.version === rightApp.version
    );
  });
}

function normalizeWorkspaceAppCenterViewState(
  value: Partial<WorkspaceAppCenterViewState> | null | undefined
): WorkspaceAppCenterViewState {
  return {
    activeAppTab: value?.activeAppTab === "my" ? "my" : "recommended"
  };
}

function areWorkspaceAppCenterViewStatesEqual(
  left: WorkspaceAppCenterViewState,
  right: WorkspaceAppCenterViewState
): boolean {
  return left.activeAppTab === right.activeAppTab;
}

function areWorkspaceAppCenterLocalizationsEqual(
  left: NonNullable<WorkspaceAppCenterApp["localizations"]>,
  right: NonNullable<WorkspaceAppCenterApp["localizations"]>
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((leftLocalization, index) => {
    const rightLocalization = right[index];
    return (
      rightLocalization !== undefined &&
      leftLocalization.locale === rightLocalization.locale &&
      leftLocalization.name === rightLocalization.name &&
      leftLocalization.description === rightLocalization.description &&
      areStringArraysEqual(leftLocalization.tags, rightLocalization.tags)
    );
  });
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function appRuntimeKey(workspaceId: string, appId: string): string {
  return `${workspaceId}\u0000${appId}`;
}

function factoryJobKey(workspaceId: string, jobId: string): string {
  return `${workspaceId}\u0000${jobId}`;
}

function removedOrUninstalledAppIds(
  previousApps: readonly WorkspaceAppCenterApp[],
  nextApps: readonly WorkspaceAppCenterApp[]
): string[] {
  const nextAppsById = new Map(nextApps.map((app) => [app.appId, app]));
  const appIds: string[] = [];
  for (const previousApp of previousApps) {
    if (!previousApp.installed) {
      continue;
    }
    const nextApp = nextAppsById.get(previousApp.appId);
    if (!nextApp?.installed) {
      appIds.push(previousApp.appId);
    }
  }
  return appIds;
}

function sortWorkspaceAppFactoryJobs(
  jobs: readonly WorkspaceAppFactoryJob[]
): WorkspaceAppFactoryJob[] {
  return [...jobs].sort(
    (left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs
  );
}

function areWorkspaceAppFactoryJobsEqual(
  left: readonly WorkspaceAppFactoryJob[],
  right: readonly WorkspaceAppFactoryJob[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((leftJob, index) => {
    const rightJob = right[index];
    return (
      rightJob !== undefined &&
      leftJob.agentSessionId === rightJob.agentSessionId &&
      leftJob.appId === rightJob.appId &&
      leftJob.createdAtUnixMs === rightJob.createdAtUnixMs &&
      leftJob.description === rightJob.description &&
      leftJob.displayName === rightJob.displayName &&
      leftJob.failureReason === rightJob.failureReason &&
      leftJob.jobId === rightJob.jobId &&
      leftJob.model === rightJob.model &&
      leftJob.prompt === rightJob.prompt &&
      leftJob.provider === rightJob.provider &&
      leftJob.publishedVersion === rightJob.publishedVersion &&
      leftJob.status === rightJob.status &&
      leftJob.updatedAtUnixMs === rightJob.updatedAtUnixMs &&
      leftJob.workspaceId === rightJob.workspaceId
    );
  });
}

function defaultWorkspaceAppArchiveName(app: WorkspaceAppCenterApp): string {
  const name = sanitizeArchiveSegment(app.name || app.appId, "app");
  const version = sanitizeArchiveSegment(app.version || "current", "current");
  return `${name}_${version}.zip`;
}

function sanitizeArchiveSegment(value: string, fallback: string): string {
  const withoutControlCharacters = Array.from(value.trim(), (character) =>
    isControlCharacter(character) ? "-" : character
  ).join("");
  const sanitized = withoutControlCharacters
    .replace(/[\\/:"*?<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!sanitized || /^\.+$/.test(sanitized)) {
    return fallback;
  }
  return sanitized;
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 0 && code <= 31;
}

type FactoryConfigOptionRecord = {
  currentValue?: unknown;
  current_value?: unknown;
  id?: unknown;
  options?: unknown;
};

type FactoryPermissionConfigRecord = {
  configurable?: unknown;
  defaultValue?: unknown;
  modes?: unknown;
};

type FactoryPermissionModeRecord = {
  id?: unknown;
  label?: unknown;
  semantic?: unknown;
};

type FactoryComposerConfigRecord = {
  configurable?: unknown;
  currentValue?: unknown;
  defaultValue?: unknown;
  options?: unknown;
};

function isFactoryConfigOptionRecord(
  value: unknown
): value is FactoryConfigOptionRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFactoryPermissionConfigRecord(
  value: unknown
): value is FactoryPermissionConfigRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFactoryPermissionModeRecord(
  value: unknown
): value is FactoryPermissionModeRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFactoryComposerConfigRecord(
  value: unknown
): value is FactoryComposerConfigRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeFactoryProviderConfiguration(
  response: AgentProviderComposerOptionsResponse
): WorkspaceAppFactoryProviderConfiguration {
  const modelOptions = normalizeFactoryComposerConfigOptions(
    response.modelConfig
  );
  const reasoningEffortOptions = normalizeFactoryComposerConfigOptions(
    response.reasoningConfig
  );
  const permissionModeOptions = normalizeFactoryPermissionOptions(
    response.permissionConfig
  );
  const defaultModel =
    response.effectiveSettings?.model?.trim() ||
    readFactoryComposerConfigValue(response.modelConfig) ||
    null;
  const defaultReasoningEffort =
    response.effectiveSettings?.reasoningEffort?.trim() ||
    readFactoryComposerConfigValue(response.reasoningConfig) ||
    null;
  const defaultPermissionModeId =
    response.effectiveSettings?.permissionModeId?.trim() ||
    readFactoryPermissionDefault(response.permissionConfig) ||
    null;
  if (
    defaultModel &&
    !modelOptions.some((option) => option.value === defaultModel)
  ) {
    modelOptions.push({
      label: defaultModel,
      value: defaultModel
    });
  }
  if (
    defaultReasoningEffort &&
    !reasoningEffortOptions.some(
      (option) => option.value === defaultReasoningEffort
    )
  ) {
    reasoningEffortOptions.push({
      label: defaultReasoningEffort,
      value: defaultReasoningEffort
    });
  }
  if (
    defaultPermissionModeId &&
    !permissionModeOptions.some(
      (option) => option.value === defaultPermissionModeId
    )
  ) {
    permissionModeOptions.push({
      label: defaultPermissionModeId,
      value: defaultPermissionModeId
    });
  }
  return {
    defaultModel,
    defaultPermissionModeId,
    defaultReasoningEffort,
    modelOptions,
    permissionModeOptions,
    reasoningEffortOptions
  };
}

function normalizeFactoryConfigOptions(
  rawConfigOption: unknown
): Array<{ label: string; value: string }> {
  const rawOptions =
    isFactoryConfigOptionRecord(rawConfigOption) &&
    Array.isArray(rawConfigOption.options)
      ? rawConfigOption.options
      : [];
  return rawOptions
    .map((option) => {
      if (!isFactoryConfigOptionRecord(option)) {
        return null;
      }
      const value =
        typeof (option as { value?: unknown }).value === "string"
          ? (option as { value: string }).value.trim()
          : "";
      if (!value) {
        return null;
      }
      const label =
        typeof (option as { label?: unknown }).label === "string"
          ? (option as { label: string }).label.trim() || value
          : typeof (option as { name?: unknown }).name === "string"
            ? (option as { name: string }).name.trim() || value
            : value;
      return { label, value };
    })
    .filter((option) => option != null);
}

function normalizeFactoryComposerConfigOptions(
  rawComposerConfig: unknown
): Array<{ label: string; value: string }> {
  if (
    isFactoryComposerConfigRecord(rawComposerConfig) &&
    Array.isArray(rawComposerConfig.options)
  ) {
    return normalizeFactoryConfigOptions({
      options: rawComposerConfig.options
    });
  }
  return [];
}

function normalizeFactoryPermissionOptions(
  rawPermissionConfig: unknown
): Array<{ label: string; semantic?: string | null; value: string }> {
  if (
    !isFactoryPermissionConfigRecord(rawPermissionConfig) ||
    rawPermissionConfig.configurable !== true ||
    !Array.isArray(rawPermissionConfig.modes)
  ) {
    return [];
  }
  return rawPermissionConfig.modes
    .map((mode) => {
      if (!isFactoryPermissionModeRecord(mode)) {
        return null;
      }
      const value = typeof mode.id === "string" ? mode.id.trim() : "";
      if (!value) {
        return null;
      }
      const semantic =
        typeof mode.semantic === "string" && mode.semantic.trim()
          ? mode.semantic.trim()
          : null;
      const label =
        typeof mode.label === "string" && mode.label.trim()
          ? mode.label.trim()
          : value;
      return {
        label,
        ...(semantic ? { semantic } : {}),
        value
      };
    })
    .filter((option) => option != null);
}

function readFactoryPermissionDefault(
  rawPermissionConfig: unknown
): string | null {
  if (!isFactoryPermissionConfigRecord(rawPermissionConfig)) {
    return null;
  }
  if (
    typeof rawPermissionConfig.defaultValue === "string" &&
    rawPermissionConfig.defaultValue.trim()
  ) {
    return rawPermissionConfig.defaultValue.trim();
  }
  return null;
}

function readFactoryComposerConfigValue(
  rawComposerConfig: unknown
): string | null {
  if (!isFactoryComposerConfigRecord(rawComposerConfig)) {
    return null;
  }
  if (
    typeof rawComposerConfig.currentValue === "string" &&
    rawComposerConfig.currentValue.trim()
  ) {
    return rawComposerConfig.currentValue.trim();
  }
  return typeof rawComposerConfig.defaultValue === "string" &&
    rawComposerConfig.defaultValue.trim()
    ? rawComposerConfig.defaultValue.trim()
    : null;
}

function emptyFactoryProviderConfiguration(): WorkspaceAppFactoryProviderConfiguration {
  return {
    defaultModel: null,
    defaultPermissionModeId: null,
    defaultReasoningEffort: null,
    modelOptions: [],
    permissionModeOptions: [],
    reasoningEffortOptions: []
  };
}

function formatAppCenterError(
  error: unknown,
  details?: WorkspaceAppCenterOperationDetails
): string {
  const locale = getActiveLocale();
  const overrides =
    details?.operation === "app_factory.publish"
      ? {
          workspace_operation_failed: createDesktopErrorI18nRuntime(locale).t(
            "errors.workspace_app_factory_publish_failed"
          )
        }
      : undefined;
  return resolveDesktopErrorMessage(error, locale, overrides);
}

function summarizeFactoryJobsForDiagnostic(
  jobs: readonly WorkspaceAppFactoryJob[]
): Array<{
  jobId: string;
  status: WorkspaceAppFactoryJob["status"];
  updatedAtUnixMs: number;
}> {
  return jobs.slice(0, factoryJobDiagnosticLimit).map((job) => ({
    jobId: job.jobId,
    status: job.status,
    updatedAtUnixMs: job.updatedAtUnixMs
  }));
}

function noop(): void {}
