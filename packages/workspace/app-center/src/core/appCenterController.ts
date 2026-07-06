import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterGateway,
  WorkspaceAppFactoryJob
} from "../contracts/host.ts";
import {
  appRuntimeKey,
  factoryJobKey,
  noop
} from "./appCenterControllerHelpers.ts";
import { WorkspaceAppCenterControllerState } from "./appCenterControllerState.ts";
import {
  defaultAppOpenLaunchWaitTimeoutMs,
  type WorkspaceAppCenterControllerDependencies
} from "./appCenterControllerTypes.ts";

export {
  createWorkspaceAppCenterStoreState,
  type WorkspaceAppCenterControllerDependencies,
  type WorkspaceAppCenterControllerHooks,
  type WorkspaceAppCenterOperation,
  type WorkspaceAppCenterOperationDetails,
  type WorkspaceAppCenterRefreshDiscard,
  type WorkspaceAppCenterUiAction
} from "./appCenterControllerTypes.ts";

export function createWorkspaceAppCenterController(
  dependencies: WorkspaceAppCenterControllerDependencies
): WorkspaceAppCenterController {
  return new WorkspaceAppCenterController(dependencies);
}

export class WorkspaceAppCenterController extends WorkspaceAppCenterControllerState {
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
      this.dependencies.hooks?.onAppInstallFailed?.({
        app: appBeforeInstall,
        appId: input.appId,
        failureReason: this.getErrorReason(error)
      });
      this.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.install",
        uiAction: "install_app",
        workspaceId: input.workspaceId
      });
    }
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
    const previousApps = this.store.apps;
    this.markAppStarting(input.appId);
    try {
      const snapshot = await this.dependencies.gateway.launchWorkspaceApp(
        input.workspaceId,
        input.appId
      );
      this.applySnapshot(input.workspaceId, snapshot);
    } catch (error) {
      if (this.store.workspaceId === input.workspaceId) {
        try {
          const snapshot = await this.dependencies.gateway.listWorkspaceApps(
            input.workspaceId
          );
          this.applySnapshot(input.workspaceId, snapshot);
        } catch {
          this.store.apps = previousApps;
        }
      }
      this.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.prepare_launch",
        uiAction: "open_app",
        workspaceId: input.workspaceId
      });
      return null;
    }

    return await this.waitForLaunchableApp(input);
  }

  async restartAndOpenApp(input: {
    appId: string;
    workspaceId: string;
  }): Promise<WorkspaceAppCenterApp | null> {
    const previousApps = this.store.apps;
    this.markAppStarting(input.appId);
    try {
      const snapshot = await this.dependencies.gateway.installWorkspaceApp(
        input.workspaceId,
        input.appId,
        { restartRunning: true }
      );
      this.applySnapshot(input.workspaceId, snapshot);
    } catch (error) {
      if (this.store.workspaceId === input.workspaceId) {
        this.store.apps = previousApps;
      }
      this.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.restart_and_open",
        uiAction: "restart_and_open_app",
        workspaceId: input.workspaceId
      });
      return null;
    }

    return await this.waitForLaunchableApp(input);
  }

  async createFactoryJob(input: {
    agentTargetId: string;
    displayName: string;
    model?: string;
    permissionModeId?: string;
    prompt: string;
    reasoningEffort?: string;
    workspaceId: string;
  }): Promise<void> {
    const previousJobIds = new Set(
      this.store.factoryJobs.map((job) => job.jobId)
    );
    try {
      const snapshot =
        await this.dependencies.gateway.createWorkspaceAppFactoryJob(
          input.workspaceId,
          {
            agentTargetId: input.agentTargetId,
            displayName: input.displayName,
            ...(input.model?.trim() ? { model: input.model.trim() } : {}),
            ...(input.permissionModeId?.trim()
              ? { permissionModeId: input.permissionModeId.trim() }
              : {}),
            prompt: input.prompt,
            ...(input.reasoningEffort?.trim()
              ? { reasoningEffort: input.reasoningEffort.trim() }
              : {})
          }
        );
      this.applyFactorySnapshot(input.workspaceId, snapshot);
      this.dependencies.hooks?.onFactoryJobCreated?.(
        snapshot.jobs.find((job) => !previousJobIds.has(job.jobId)) ?? null
      );
    } catch (error) {
      this.setOperationError(error, {
        operation: "app_factory.create",
        uiAction: "create_factory_job",
        workspaceId: input.workspaceId
      });
    }
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
      this.dependencies.hooks?.onAppDeleted?.(app ?? null);
    } catch (error) {
      this.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.delete",
        uiAction: "delete_app",
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
      this.setOperationError(error, {
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
  }): Promise<WorkspaceAppFactoryJob | null> {
    const publishKey = factoryJobKey(input.workspaceId, input.jobId);
    if (this.pendingFactoryPublishKeys.has(publishKey)) {
      return null;
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
        this.setOperationError(error, {
          jobId: input.jobId,
          operation: "app_factory.publish",
          uiAction: "publish_factory_job",
          workspaceId: input.workspaceId
        });
      }
      return null;
    }
    this.pendingFactoryPublishKeys.delete(publishKey);
    this.applyFactorySnapshot(input.workspaceId, result.factorySnapshot);
    this.applySnapshot(input.workspaceId, result.appSnapshot);
    return (
      result.factorySnapshot.jobs.find(
        (candidate) => candidate.jobId === input.jobId
      ) ?? null
    );
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
        this.dependencies.hooks?.onRefreshDiscard?.({
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
        this.dependencies.hooks?.onRefreshDiscard?.({
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
        this.setUnavailableError(error, {
          operation: "app_center.refresh",
          workspaceId: normalizedWorkspaceId
        });
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
      this.setUnavailableError(error, {
        operation: "app_center.refresh",
        workspaceId: normalizedWorkspaceId
      });
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
        this.dependencies.hooks?.onRefreshDiscard?.({
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
      this.dependencies.hooks?.onCatalogRefreshed?.({
        appCount: snapshot.apps.length,
        errorReason: null,
        success: true
      });
    } catch (error) {
      if (sequence !== this.appLoadSequence) {
        this.dependencies.hooks?.onRefreshDiscard?.({
          currentSequence: this.appLoadSequence,
          operation: "app_center.refresh_catalog",
          sequence,
          snapshotKind: "catalog_apps",
          workspaceId: normalizedWorkspaceId
        });
        return;
      }
      this.setUnavailableError(error, {
        operation: "app_center.refresh_catalog",
        workspaceId: normalizedWorkspaceId
      });
      this.dependencies.hooks?.onCatalogRefreshed?.({
        appCount: null,
        errorReason: this.getErrorReason(error),
        success: false
      });
    }
  }

  async startEnabledApps(workspaceId: string): Promise<void> {
    this.markEnabledAppsStarting();
    try {
      const snapshot =
        await this.dependencies.gateway.startEnabledWorkspaceApps(workspaceId);
      this.applySnapshot(workspaceId, snapshot);
    } catch (error) {
      this.setUnavailableError(error, {
        operation: "workspace_app.start_enabled",
        workspaceId
      });
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
    this.dependencies.hooks?.onAppUninstalled?.(app ?? null);
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
      const restartRunning =
        app?.installed === true && app.runtimeStatus === "running";
      const snapshot = await this.dependencies.gateway.installWorkspaceApp(
        input.workspaceId,
        input.appId,
        restartRunning ? { restartRunning: true } : undefined
      );
      this.applySnapshot(input.workspaceId, snapshot);
      this.dependencies.hooks?.onAppUpdated?.({
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
      this.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.update",
        uiAction: "update_app",
        workspaceId: input.workspaceId
      });
    }
  }

  async retryApp(input: { appId: string; workspaceId: string }): Promise<void> {
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    if (
      this.store.workspaceId !== input.workspaceId ||
      !app?.installed ||
      app.runtimeStatus !== "failed"
    ) {
      return;
    }
    const previousApps = this.store.apps;
    this.markAppStarting(input.appId);
    try {
      const snapshot = await this.dependencies.gateway.retryWorkspaceApp(
        input.workspaceId,
        input.appId
      );
      this.applySnapshot(input.workspaceId, snapshot);
    } catch (error) {
      if (this.store.workspaceId === input.workspaceId) {
        this.store.apps = previousApps;
      }
      this.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.retry",
        uiAction: "retry_app",
        workspaceId: input.workspaceId
      });
    }
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
      defaultAppOpenLaunchWaitTimeoutMs;
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
      this.setOperationError(error, {
        appId: input.appId,
        operation: "workspace_app.refresh_launch_wait_state",
        uiAction: "refresh_launch_wait_state",
        workspaceId: input.workspaceId
      });
      return null;
    }
    return this.resolveLaunchableApp(input);
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
}
