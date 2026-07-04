import type {
  DesktopHostFilesApi,
  DesktopRuntimeApi,
  DesktopHostWorkspaceApi
} from "@preload/types";
import {
  normalizeTuttidError,
  type AgentProviderComposerOptionsResponse,
  type TuttidClient,
  type TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterGateway,
  WorkspaceAppCenterRuntimeStatus,
  WorkspaceAppCenterStoreState,
  WorkspaceAppCenterViewState,
  WorkspaceAppFactoryJob,
  WorkspaceAppFactoryProviderConfiguration,
  WorkspaceAppLocalRepairRequest
} from "@tutti-os/workspace-app-center";
import { createWorkspaceAppCenterController } from "@tutti-os/workspace-app-center/core";
import type {
  WorkspaceAppCenterController,
  WorkspaceAppCenterOperationDetails
} from "@tutti-os/workspace-app-center/core";
import { createDesktopErrorI18nRuntime } from "../../../../../../shared/i18n/index.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import {
  getDesktopErrorCode,
  resolveDesktopErrorMessage
} from "../../../../lib/desktopErrors.ts";
import { agentActivityComposerOptionsFromTuttidResult } from "../../../../lib/agentComposerOptionsProjection.ts";
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
import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface";
import {
  normalizeWorkspaceAppCenterApp,
  normalizeWorkspaceAppFactoryJob,
  type DesktopWorkspaceAppCenterLocalFileGateway
} from "./adapters/desktopWorkspaceAppCenterGateway.ts";
import { recordWorkspaceAppCenterOperationFailure } from "./workspaceAppCenterDiagnostics.ts";
import { createWorkspaceAppCenterStore } from "./workspaceAppCenterStore.ts";

const factoryJobDiagnosticLimit = 20;

type AgentProviderComposerOptionsClient = Pick<
  TuttidClient,
  "getWorkspaceAppFactoryProviderComposerOptions"
>;

export interface WorkspaceAppCenterServiceDependencies {
  eventStreamClient: TuttidEventStreamClient;
  appOpenLaunchWaitTimeoutMs?: number;
  gateway: WorkspaceAppCenterGateway &
    DesktopWorkspaceAppCenterLocalFileGateway;
  hostFilesApi: Pick<
    DesktopHostFilesApi,
    | "openExternal"
    | "revealInFolder"
    | "selectAppArchive"
    | "selectAppArchiveExportPath"
    | "selectDirectory"
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
  intent?: TuttiExternalWorkspaceOpenRouteIntent;
  prepared: boolean;
  prevStatus?: WorkspaceAppCenterRuntimeStatus;
  workspaceId: string;
}) => Promise<boolean>;

export class WorkspaceAppCenterService implements IWorkspaceAppCenterService {
  readonly _serviceBrand = undefined;
  readonly store: WorkspaceAppCenterStoreState;

  private readonly controller: WorkspaceAppCenterController;
  private readonly dependencies: WorkspaceAppCenterServiceDependencies;
  private workspaceAppLauncher: WorkspaceAppLauncher | null = null;
  private workspaceAppViewCloser:
    | ((input: { appId: string; workspaceId: string }) => void)
    | null = null;
  private workspaceAppViewOpenChecker:
    | ((input: { appId: string; workspaceId: string }) => boolean)
    | null = null;
  private updates: WorkspaceAppCenterUpdateState | null = null;

  constructor(dependencies: WorkspaceAppCenterServiceDependencies) {
    this.dependencies = dependencies;
    const store = createWorkspaceAppCenterStore();
    this.controller = createWorkspaceAppCenterController({
      appOpenLaunchWaitTimeoutMs: dependencies.appOpenLaunchWaitTimeoutMs,
      formatError: formatAppCenterError,
      gateway: dependencies.gateway,
      getErrorReason: getAnalyticsErrorReason,
      hooks: {
        onAppDeleted: (app) => this.reportAppDeleted(app),
        onAppInstallFailed: (input) => this.reportAppInstallFailed(input),
        onAppInstalled: (app) => this.reportAppInstalled(app),
        onAppRuntimeFailed: (input) => this.reportAppRuntimeFailed(input),
        onAppStopped: (input) => this.reportAppStopped(input),
        onAppUninstalled: (app) => this.reportAppUninstalled(app),
        onAppUpdated: (input) => this.reportAppUpdated(input),
        onCatalogRefreshed: (input) => this.reportCatalogRefreshed(input),
        onCloseWorkspaceAppViews: (input) =>
          this.closeWorkspaceAppViews(input.workspaceId, input.appIds),
        onFactoryJobCreated: (job) => this.reportFactoryJobCreated(job),
        onFactorySnapshotApplied: (input) =>
          this.recordFactorySnapshotApplied(
            input.workspaceId,
            input.previousJobs,
            input.nextJobs
          ),
        onOperationFailure: (input) =>
          this.recordOperationFailure(
            input.error,
            input.toastMessage,
            input.details
          ),
        onRefreshDiscard: (input) => this.recordRefreshDiscard(input)
      },
      now: () => dependencies.reporterNow?.() ?? Date.now(),
      store
    });
    this.store = store;
  }

  consumeError(): string | null {
    return this.controller.consumeError();
  }

  async installApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.controller.installApp(input);
  }

  async openApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<boolean> {
    const previousApp = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    const launchableApp = await this.controller.prepareAppLaunch(input);
    if (!launchableApp) {
      return false;
    }
    return (
      (await this.workspaceAppLauncher?.({
        appId: launchableApp.appId,
        prepared: true,
        prevStatus: previousApp?.runtimeStatus ?? launchableApp.runtimeStatus,
        workspaceId: input.workspaceId
      })) === true
    );
  }

  getViewState(
    workspaceId: string,
    restoredState?: WorkspaceAppCenterViewState | null
  ): WorkspaceAppCenterViewState {
    return this.controller.getViewState(workspaceId, restoredState);
  }

  async prepareAppLaunch(input: {
    appId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppCenterApp | null> {
    return await this.controller.prepareAppLaunch(input);
  }

  setViewState(input: {
    state: Partial<WorkspaceAppCenterViewState>;
    workspaceId: string;
  }): void {
    this.controller.setViewState(input);
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
    await this.controller.createFactoryJob(input);
  }

  async getFactoryProviderConfiguration(input: {
    provider: string;
    workspaceId: string;
  }): Promise<WorkspaceAppFactoryProviderConfiguration> {
    const normalizedProvider = input.provider.trim();
    const normalizedWorkspaceId = input.workspaceId.trim();
    if (
      !normalizedProvider ||
      !normalizedWorkspaceId ||
      !this.dependencies.tuttidClient
    ) {
      return emptyFactoryProviderConfiguration();
    }
    const response =
      await this.dependencies.tuttidClient.getWorkspaceAppFactoryProviderComposerOptions(
        normalizedWorkspaceId,
        normalizedProvider as Parameters<
          AgentProviderComposerOptionsClient["getWorkspaceAppFactoryProviderComposerOptions"]
        >[1]
      );
    return normalizeFactoryProviderConfiguration(normalizedProvider, response);
  }

  async cancelFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.controller.cancelFactoryJob(input);
  }

  async deleteFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.controller.deleteFactoryJob(input);
  }

  async deleteApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.controller.deleteApp(input);
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
      this.controller.applySnapshot(input.workspaceId, snapshot);
    } catch (error) {
      this.controller.setOperationError(error, {
        operation: "workspace_app.import",
        uiAction: "import_app",
        workspaceId: input.workspaceId
      });
    }
  }

  async loadLocalApp(input: {
    workspaceId: string;
  }): Promise<WorkspaceAppLocalRepairRequest | null> {
    const sourceDir = await this.dependencies.hostFilesApi.selectDirectory();
    if (!sourceDir) {
      return null;
    }
    try {
      const snapshot = await this.dependencies.gateway.loadLocalWorkspaceApp(
        input.workspaceId,
        { restartRunning: true, sourceDir }
      );
      this.controller.applySnapshot(input.workspaceId, snapshot);
      return null;
    } catch (error) {
      if (isInvalidLocalAppLoadError(error)) {
        return createLocalAppRepairRequest(sourceDir);
      }
      this.controller.setOperationError(error, {
        operation: "workspace_app.load_local",
        uiAction: "load_local_app",
        workspaceId: input.workspaceId
      });
      return null;
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
      this.controller.setOperationError(error, {
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
      this.controller.applyAppSnapshot(input.workspaceId, app);
    } catch (error) {
      this.controller.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.replace_icon",
        uiAction: "replace_app_icon",
        workspaceId: input.workspaceId
      });
    }
  }

  async reloadLocalApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    try {
      const snapshot = await this.dependencies.gateway.reloadLocalWorkspaceApp(
        input.workspaceId,
        input.appId,
        { restartRunning: true }
      );
      this.controller.applySnapshot(input.workspaceId, snapshot);
    } catch (error) {
      this.controller.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.reload_local",
        uiAction: "reload_local_app",
        workspaceId: input.workspaceId
      });
    }
  }

  async retryFactoryValidation(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.controller.retryFactoryValidation(input);
  }

  async fixFactoryJob(input: {
    jobId: string;
    prompt: string;
    workspaceId: string;
  }): Promise<void> {
    await this.controller.fixFactoryJob(input);
  }

  async prepareFactoryJobModification(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppFactoryJob | null> {
    return await this.controller.prepareFactoryJobModification(input);
  }

  async publishFactoryJob(input: {
    jobId: string;
    workspaceId: string;
  }): Promise<void> {
    const job = await this.controller.publishFactoryJob(input);
    if (job?.appId) {
      await this.openApp({ appId: job.appId, workspaceId: input.workspaceId });
    }
  }

  async refresh(workspaceId: string): Promise<void> {
    await this.controller.refresh(workspaceId);
  }

  async refreshCatalog(workspaceId: string): Promise<void> {
    await this.controller.refreshCatalog(workspaceId);
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
    this.controller.beginWorkspacePolling(normalizedWorkspaceId);
    let disposed = false;
    let hasConnected = false;
    let startupRefreshActive = true;

    const unsubscribeAppUpdated = this.dependencies.eventStreamClient.subscribe(
      "workspace.app.updated",
      (event) => {
        if (disposed) {
          return;
        }
        const currentApp = this.store.apps.find(
          (candidate) => candidate.appId === event.payload.app.appId
        );
        this.controller.applyAppUpdate({
          app: normalizeWorkspaceAppCenterApp({
            ...event.payload.app,
            createdAtUnixMs:
              readOptionalNumberProperty(
                event.payload.app,
                "createdAtUnixMs"
              ) ?? currentApp?.createdAtUnixMs
          }),
          failureReason:
            event.payload.app.failureReason ??
            event.payload.app.lastError ??
            null,
          startedAtUnixMs: event.payload.app.startedAtUnixMs ?? null,
          workspaceId: normalizedWorkspaceId
        });
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
            this.controller.applyFactoryJobUpdate(
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
          void this.controller.refresh(normalizedWorkspaceId);
          return;
        }
        if (!startupRefreshActive) {
          hasConnected = true;
          void this.controller.refresh(normalizedWorkspaceId);
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
      this.controller.endWorkspacePolling(normalizedWorkspaceId);
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
    return this.controller.subscribe(listener);
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
    if (app.source === "local-dev") {
      const localPackageDir = app.localPackageDir?.trim();
      if (!localPackageDir) {
        return;
      }
      this.store.openingFolderAppId = input.appId;
      try {
        await this.dependencies.hostFilesApi.revealInFolder(localPackageDir);
      } finally {
        if (this.store.openingFolderAppId === input.appId) {
          this.store.openingFolderAppId = null;
        }
      }
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

  async openExternalUrl(url: string): Promise<void> {
    const target = url.trim();
    if (!target) {
      return;
    }
    await this.dependencies.hostFilesApi.openExternal(target);
  }

  async uninstallApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.controller.uninstallApp(input);
  }

  async updateApp(input: {
    appId: string;
    trigger: "badge_button" | "primary_action";
    workspaceId: string;
  }): Promise<void> {
    const previousApp = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    const shouldRecordHandoff =
      previousApp?.installed === true &&
      previousApp.runtimeStatus === "running";
    const startedAt = shouldRecordHandoff ? Date.now() : 0;

    if (shouldRecordHandoff) {
      this.recordWorkspaceAppUpdateHandoff({
        app: previousApp,
        phase: "started",
        trigger: input.trigger,
        workspaceId: input.workspaceId
      });
    }

    try {
      await this.controller.updateApp(input);
    } catch (error) {
      if (shouldRecordHandoff) {
        this.recordWorkspaceAppUpdateHandoff({
          app:
            this.store.apps.find(
              (candidate) => candidate.appId === input.appId
            ) ?? null,
          durationMs: Date.now() - startedAt,
          error,
          phase: "failed",
          trigger: input.trigger,
          workspaceId: input.workspaceId
        });
      }
      throw error;
    }

    if (shouldRecordHandoff) {
      this.recordWorkspaceAppUpdateHandoff({
        app:
          this.store.apps.find(
            (candidate) => candidate.appId === input.appId
          ) ?? null,
        durationMs: Date.now() - startedAt,
        phase: "completed",
        trigger: input.trigger,
        workspaceId: input.workspaceId
      });
    }
  }

  async retryApp(input: { appId: string; workspaceId: string }): Promise<void> {
    await this.controller.retryApp(input);
  }

  async restartAndOpenApp(input: {
    appId: string;
    intent?: TuttiExternalWorkspaceOpenRouteIntent;
    workspaceId: string;
  }): Promise<boolean> {
    const previousApp = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    this.closeWorkspaceAppViews(input.workspaceId, [input.appId]);
    const launchableApp = await this.controller.restartAndOpenApp(input);
    if (!launchableApp) {
      return false;
    }
    return (
      (await this.workspaceAppLauncher?.({
        appId: launchableApp.appId,
        ...(input.intent ? { intent: input.intent } : {}),
        prepared: true,
        prevStatus: previousApp?.runtimeStatus ?? launchableApp.runtimeStatus,
        workspaceId: input.workspaceId
      })) === true
    );
  }

  setWorkspaceAppLauncher(launcher: WorkspaceAppLauncher | null): void {
    this.workspaceAppLauncher = launcher;
  }

  setWorkspaceAppViewCloser(
    closer: ((input: { appId: string; workspaceId: string }) => void) | null
  ): void {
    this.workspaceAppViewCloser = closer;
  }

  setWorkspaceAppViewOpenChecker(
    checker: ((input: { appId: string; workspaceId: string }) => boolean) | null
  ): void {
    this.workspaceAppViewOpenChecker = checker;
  }

  isWorkspaceAppViewOpen(input: {
    appId: string;
    workspaceId: string;
  }): boolean {
    return this.workspaceAppViewOpenChecker?.(input) === true;
  }

  private async startWorkspaceUpdates(
    workspaceId: string,
    isDisposed: () => boolean,
    markConnected: () => void,
    markStartupRefreshSettled: () => void
  ): Promise<void> {
    const startedAt = Date.now();
    this.logStartupDiagnostic("app_center.start_workspace_updates.started", {
      workspaceId
    });
    try {
      const connectStartedAt = Date.now();
      await this.dependencies.eventStreamClient.connect();
      this.logStartupDiagnostic(
        "app_center.start_workspace_updates.event_stream_connected",
        {
          durationMs: Date.now() - connectStartedAt,
          workspaceId
        }
      );
      if (isDisposed()) {
        return;
      }
      const refreshStartedAt = Date.now();
      await this.controller.refresh(workspaceId);
      this.logStartupDiagnostic(
        "app_center.start_workspace_updates.initial_refreshed",
        {
          durationMs: Date.now() - refreshStartedAt,
          workspaceId
        }
      );
      if (isDisposed()) {
        return;
      }
      markConnected();
      const startEnabledStartedAt = Date.now();
      await this.controller.startEnabledApps(workspaceId);
      this.logStartupDiagnostic(
        "app_center.start_workspace_updates.start_enabled_completed",
        {
          durationMs: Date.now() - startEnabledStartedAt,
          workspaceId
        }
      );
    } catch (error) {
      if (isDisposed()) {
        return;
      }
      this.controller.setUnavailableError(error, {
        operation: "app_center.start_workspace_updates",
        workspaceId
      });
    } finally {
      this.logStartupDiagnostic("app_center.start_workspace_updates.settled", {
        durationMs: Date.now() - startedAt,
        workspaceId
      });
      markStartupRefreshSettled();
    }
  }

  private logStartupDiagnostic(
    event: string,
    details: Record<string, unknown>
  ): void {
    void this.dependencies.runtimeApi
      ?.logRendererDiagnostic({
        details,
        event,
        level: "debug",
        source: "workspace-app-center",
        workspaceId:
          typeof details.workspaceId === "string"
            ? details.workspaceId
            : undefined
      })
      .catch(() => undefined);
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

  private recordWorkspaceAppUpdateHandoff(input: {
    app: WorkspaceAppCenterApp | null;
    durationMs?: number;
    error?: unknown;
    phase: "started" | "completed" | "failed";
    trigger: "badge_button" | "primary_action";
    workspaceId: string;
  }): void {
    this.recordRendererDiagnostic({
      details: {
        appId: input.app?.appId ?? null,
        durationMs: input.durationMs ?? null,
        errorCode: input.error ? getDesktopErrorCode(input.error) : null,
        errorMessage: input.error instanceof Error ? input.error.message : null,
        launchUrlOrigin: resolveUrlOriginForDiagnostic(input.app?.launchUrl),
        operation: "app_center.update.running_handoff",
        phase: input.phase,
        runtimeStatus: input.app?.runtimeStatus ?? null,
        trigger: input.trigger,
        version: input.app?.version ?? null
      },
      event: "workspace_app_center_update_handoff",
      level: input.phase === "failed" ? "warn" : "debug",
      workspaceId: input.workspaceId
    });
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

function isInvalidLocalAppLoadError(error: unknown): boolean {
  const protocolError = normalizeTuttidError(error);
  const code = protocolError?.code ?? getDesktopErrorCode(error);
  const reason =
    protocolError?.reason ?? readOptionalStringProperty(error, "reason");
  return code === "invalid_request" && reason === "malformed_request";
}

function createLocalAppRepairRequest(
  sourceDir: string
): WorkspaceAppLocalRepairRequest {
  const normalizedSourceDir = trimTrailingPathSeparators(sourceDir.trim());
  return {
    projectDir: resolveLocalAppRepairProjectDir(normalizedSourceDir),
    sourceDir: normalizedSourceDir
  };
}

function resolveLocalAppRepairProjectDir(sourceDir: string): string {
  const parts = sourceDir.split(/[\\/]+/u);
  if (
    parts.length >= 3 &&
    parts[parts.length - 2] === ".tutti" &&
    parts[parts.length - 1] === "dev-app"
  ) {
    const separator =
      sourceDir.includes("\\") && !sourceDir.includes("/") ? "\\" : "/";
    return parts.slice(0, -2).join(separator) || sourceDir;
  }
  return sourceDir;
}

function trimTrailingPathSeparators(value: string): string {
  const trimmed = value.replace(/[\\/]+$/u, "");
  return trimmed || value;
}

function readOptionalStringProperty(
  value: unknown,
  property: string
): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const rawValue = (value as Record<string, unknown>)[property];
  return typeof rawValue === "string" ? rawValue : null;
}

function readOptionalNumberProperty(
  value: object,
  property: string
): number | null {
  const rawValue = (value as Record<string, unknown>)[property];
  return typeof rawValue === "number" && Number.isFinite(rawValue)
    ? rawValue
    : null;
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
  currentValue?: unknown;
  defaultValue?: unknown;
};

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
  provider: string,
  response: AgentProviderComposerOptionsResponse
): WorkspaceAppFactoryProviderConfiguration {
  const composerOptions = agentActivityComposerOptionsFromTuttidResult(
    provider,
    response
  );
  const modelOptions = composerOptions.models.map((option) => ({
    label: option.label,
    value: option.value
  }));
  const reasoningEffortOptions = composerOptions.reasoningEfforts.map(
    (option) => ({
      label: option.label,
      value: option.value
    })
  );
  const permissionModeOptions = normalizeFactoryPermissionOptions(
    composerOptions.permissionConfig
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
  const desktopErrorCopy = createDesktopErrorI18nRuntime(locale);
  if (
    details?.operation === "workspace_app.prepare_launch" &&
    isFailedWorkspaceAppLaunchError(error)
  ) {
    return desktopErrorCopy.t("errors.workspace_app_launch_requires_retry");
  }
  const overrides =
    details?.operation === "app_factory.publish"
      ? {
          workspace_operation_failed: desktopErrorCopy.t(
            "errors.workspace_app_factory_publish_failed"
          )
        }
      : undefined;
  return resolveDesktopErrorMessage(error, locale, overrides);
}

function isFailedWorkspaceAppLaunchError(error: unknown): boolean {
  const protocolError = normalizeTuttidError(error);
  return (
    protocolError?.code === "invalid_request" &&
    protocolError.reason === "malformed_request" &&
    protocolError.developerMessage?.includes(
      "failed workspace apps must be retried before launch"
    ) === true
  );
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

function resolveUrlOriginForDiagnostic(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function noop(): void {}
