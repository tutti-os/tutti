import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterSnapshot,
  WorkspaceAppFactoryJob,
  WorkspaceAppFactorySnapshot
} from "../contracts/host.ts";
import { WorkspaceAppCenterControllerBase } from "./appCenterControllerBase.ts";
import {
  areWorkspaceAppCenterAppsEqual,
  areWorkspaceAppFactoryJobsEqual,
  appRuntimeKey,
  mergeWorkspaceAppCatalogFields,
  removedOrUninstalledAppIds,
  resolveAppRunDurationMs,
  sortWorkspaceAppCenterApps,
  sortWorkspaceAppFactoryJobs
} from "./appCenterControllerHelpers.ts";
import {
  defaultCatalogLoadingRefreshDelayMs,
  defaultInstallRefreshDelayMs,
  defaultTransientRuntimeRefreshDelayMs,
  defaultTransientRuntimeRefreshMaxAttempts,
  type WorkspaceAppCenterOperationCursor
} from "./appCenterControllerTypes.ts";
import { acceptWorkspaceAppOperationCursor } from "./appOperationCursor.ts";
import { reconcilePendingInstallProgress } from "./installProgressMerge.ts";

export abstract class WorkspaceAppCenterControllerState extends WorkspaceAppCenterControllerBase {
  abstract refresh(workspaceId: string): Promise<void>;

  applySnapshot(
    workspaceId: string,
    snapshot: WorkspaceAppCenterSnapshot
  ): void {
    this.clearOperationCursorsOnWorkspaceChange(workspaceId);
    const nextApps = sortWorkspaceAppCenterApps(
      this.mergeSnapshotAppsByStateRevision(
        workspaceId,
        this.withPendingInstallState(workspaceId, snapshot.apps)
      )
    );
    const previousAppsById = new Map(
      this.store.apps.map((app) => [app.appId, app])
    );
    for (const app of nextApps) {
      this.settlePendingInstallReport({
        app,
        failureReason: app.failureReason ?? app.lastError ?? null,
        previousApp: previousAppsById.get(app.appId),
        workspaceId
      });
    }
    this.reconcileActiveInstallRefreshes(workspaceId, nextApps);
    const appIdsToClose =
      this.store.workspaceId === workspaceId
        ? removedOrUninstalledAppIds(this.store.apps, nextApps)
        : [];
    this.scheduleCatalogLoadingRefresh(workspaceId, snapshot);
    const hasTransientRuntimeApps = this.hasTransientRuntimeApps(
      workspaceId,
      nextApps
    );
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
      this.syncTransientRuntimeRefresh(workspaceId, hasTransientRuntimeApps);
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
    this.syncTransientRuntimeRefresh(workspaceId, hasTransientRuntimeApps);
  }

  applyFactorySnapshot(
    workspaceId: string,
    snapshot: WorkspaceAppFactorySnapshot
  ): void {
    // Any authoritative factory snapshot supersedes reads that started before
    // it, including the factory half of an in-flight full refresh.
    this.factoryLoadSequence += 1;
    this.clearOperationCursorsOnWorkspaceChange(workspaceId);
    if (this.store.workspaceId !== workspaceId) {
      this.store.workspaceId = workspaceId;
    }
    const nextJobs = sortWorkspaceAppFactoryJobs(snapshot.jobs);
    if (areWorkspaceAppFactoryJobsEqual(this.store.factoryJobs, nextJobs)) {
      return;
    }
    const previousJobs = this.store.factoryJobs;
    this.store.factoryJobs = nextJobs;
    this.dependencies.hooks?.onFactorySnapshotApplied?.({
      nextJobs,
      previousJobs,
      workspaceId
    });
    this.bumpRevision();
  }

  applyAppUpdate(input: {
    app: WorkspaceAppCenterApp;
    failureReason?: string | null;
    operationCursor?: WorkspaceAppCenterOperationCursor | null;
    startedAtUnixMs?: number | null;
    workspaceId: string;
  }): void {
    if (
      this.store.workspaceId !== input.workspaceId ||
      (!this.usesPollingRefresh &&
        (this.pollingWorkspaceId !== input.workspaceId ||
          input.operationCursor == null))
    ) {
      return;
    }
    const currentApp = this.store.apps.find(
      (candidate) => candidate.appId === input.app.appId
    );
    if (!currentApp) {
      return;
    }
    const operationAdvance = acceptWorkspaceAppOperationCursor(
      this.appOperationCursors,
      appRuntimeKey(input.workspaceId, input.app.appId),
      input.operationCursor
    );
    if (operationAdvance === false) {
      return;
    }
    const acceptedRuntimeTransition =
      operationAdvance === true ||
      input.app.stateRevision > currentApp.stateRevision;
    if (
      acceptedRuntimeTransition &&
      input.app.runtimeStatus === "failed" &&
      currentApp.runtimeStatus !== "failed"
    ) {
      this.dependencies.hooks?.onAppRuntimeFailed?.({
        app: input.app,
        failureReason: input.failureReason ?? null
      });
    }
    if (
      acceptedRuntimeTransition &&
      currentApp.runtimeStatus === "running" &&
      input.app.runtimeStatus !== "running"
    ) {
      this.dependencies.hooks?.onAppStopped?.({
        app: currentApp,
        runDurationMs: resolveAppRunDurationMs(
          input.startedAtUnixMs,
          this.dependencies.now?.() ?? Date.now()
        )
      });
    }
    this.applyAppSnapshot(input.workspaceId, input.app, {
      installFailureReason: input.failureReason ?? null,
      operationAdvance: operationAdvance === true
    });
  }

  applyAppSnapshot(
    workspaceId: string,
    nextApp: WorkspaceAppCenterApp,
    options: {
      installFailureReason?: string | null;
      operationAdvance?: boolean;
    } = {}
  ): void {
    if (this.store.workspaceId !== workspaceId) {
      return;
    }
    const currentApp = this.store.apps.find(
      (candidate) => candidate.appId === nextApp.appId
    );
    if (
      currentApp &&
      options.operationAdvance !== true &&
      nextApp.stateRevision <= currentApp.stateRevision &&
      !this.shouldAcceptRuntimeSnapshot(currentApp, nextApp)
    ) {
      this.settlePendingInstallReport({
        app: currentApp,
        failureReason:
          options.installFailureReason ??
          currentApp.failureReason ??
          currentApp.lastError ??
          null,
        previousApp: currentApp,
        workspaceId
      });
      this.reconcileActiveInstallRefreshes(workspaceId, [currentApp]);
      return;
    }
    const mergedApp = this.mergeActiveInstallAppState(
      workspaceId,
      nextApp,
      currentApp
    );
    const appIdsToClose =
      currentApp?.installed === true && !mergedApp.installed
        ? [nextApp.appId]
        : [];

    const nextApps = sortWorkspaceAppCenterApps([
      ...this.store.apps.filter(
        (candidate) => candidate.appId !== nextApp.appId
      ),
      mergedApp
    ]);
    this.reconcileActiveInstallRefreshes(workspaceId, [mergedApp]);
    if (areWorkspaceAppCenterAppsEqual(this.store.apps, nextApps)) {
      return;
    }
    this.store.apps = nextApps;
    this.store.error = null;
    this.store.loadStatus = "ready";
    this.bumpRevision();
    this.settlePendingInstallReport({
      app: mergedApp,
      failureReason:
        options.installFailureReason ??
        mergedApp.failureReason ??
        mergedApp.lastError ??
        null,
      previousApp: currentApp,
      workspaceId
    });
    this.closeWorkspaceAppViews(workspaceId, appIdsToClose);
  }

  applyFactoryJobUpdate(
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

  protected scheduleInstallRefresh(workspaceId: string, appId: string): void {
    if (!this.usesPollingRefresh) {
      return;
    }
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
    }, this.dependencies.installRefreshDelayMs ?? defaultInstallRefreshDelayMs);
    timer.unref?.();
    this.installRefreshTimers.set(key, timer);
  }

  protected markAppStarting(appId: string): void {
    this.transientRuntimeRefreshAttempts = 0;
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

  protected markLaunchWaitTimedOut(input: {
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
      this.transientRuntimeRefreshAttempts = 0;
      this.bumpRevision();
    }
  }

  protected resolveLaunchableApp(input: {
    appId: string;
    workspaceId: string;
  }): WorkspaceAppCenterApp | null {
    if (this.store.workspaceId !== input.workspaceId) {
      return null;
    }
    const app = this.store.apps.find(
      (candidate) => candidate.appId === input.appId
    );
    return app?.installed && app.runtimeStatus === "running" && app.launchUrl
      ? app
      : null;
  }

  protected markAppInstalling(
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

  protected markEnabledAppsStarting(): void {
    let changed = false;
    this.store.apps = this.store.apps.map((app) => {
      if (!app.enabled || !app.installed || app.runtimeStatus !== "idle") {
        return app;
      }
      changed = true;
      return {
        ...app,
        runtimeStatus: "preparing"
      };
    });
    if (changed) {
      this.transientRuntimeRefreshAttempts = 0;
      this.bumpRevision();
    }
  }

  protected isPendingInstallSettled(
    installKey: string,
    app: WorkspaceAppCenterApp,
    previousApp?: WorkspaceAppCenterApp
  ): boolean {
    if (this.isPendingInstallAbandoned(installKey, app, previousApp)) {
      return true;
    }
    if (app.runtimeStatus === "failed") {
      return true;
    }
    if (this.isRuntimeInstallBusy(app.runtimeStatus)) {
      return false;
    }
    if (this.pendingInstallReportKeys.has(installKey)) {
      return app.installed;
    }
    return app.installed && !app.updateAvailable && !app.availableVersion;
  }

  protected isRuntimeInstallBusy(
    runtimeStatus: WorkspaceAppCenterApp["runtimeStatus"]
  ): boolean {
    return (
      runtimeStatus === "installing" ||
      runtimeStatus === "preparing" ||
      runtimeStatus === "starting"
    );
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
      const installKey = appRuntimeKey(workspaceId, snapshotApp.appId);
      if (
        currentApp &&
        !this.usesPollingRefresh &&
        this.appOperationCursors.has(installKey)
      ) {
        const mergedApp = mergeWorkspaceAppCatalogFields(
          currentApp,
          snapshotApp
        );
        // Ordered operation events own lifecycle state, but launchUrl is a
        // route capability that only exists in the authoritative runtime
        // snapshot. Enrich the terminal event projection only when both
        // sources describe the exact same running runtime fence.
        if (
          currentApp.runtimeStatus === "running" &&
          snapshotApp.runtimeStatus === "running" &&
          currentApp.runtimeId != null &&
          currentApp.runtimeId === snapshotApp.runtimeId &&
          currentApp.installationId != null &&
          currentApp.installationId === snapshotApp.installationId &&
          snapshotApp.launchUrl != null
        ) {
          return { ...mergedApp, launchUrl: snapshotApp.launchUrl };
        }
        return mergedApp;
      }
      if (!currentApp || currentApp.stateRevision < snapshotApp.stateRevision) {
        return snapshotApp;
      }
      if (this.pendingInstallKeys.has(installKey)) {
        const pendingSettled = this.isPendingInstallSettled(
          installKey,
          snapshotApp,
          currentApp
        );
        if (
          pendingSettled &&
          currentApp.stateRevision < snapshotApp.stateRevision
        ) {
          return snapshotApp;
        }
      }
      if (this.shouldAcceptRuntimeSnapshot(currentApp, snapshotApp)) {
        return snapshotApp;
      }
      return mergeWorkspaceAppCatalogFields(currentApp, snapshotApp);
    });
  }

  private shouldAcceptRuntimeSnapshot(
    currentApp: WorkspaceAppCenterApp,
    snapshotApp: WorkspaceAppCenterApp
  ): boolean {
    if (snapshotApp.runtimeStatus === "running") {
      return (
        currentApp.runtimeStatus !== "running" ||
        currentApp.launchUrl !== snapshotApp.launchUrl ||
        currentApp.runtimeId !== snapshotApp.runtimeId ||
        currentApp.installationId !== snapshotApp.installationId ||
        currentApp.installProgress != null ||
        currentApp.failureReason != null ||
        currentApp.lastError != null
      );
    }
    if (snapshotApp.runtimeStatus === "failed") {
      return (
        currentApp.runtimeStatus !== "failed" &&
        (snapshotApp.failureReason != null || snapshotApp.lastError != null)
      );
    }
    if (
      snapshotApp.runtimeStatus === "stopping" ||
      snapshotApp.runtimeStatus === "unavailable"
    ) {
      return currentApp.runtimeStatus !== snapshotApp.runtimeStatus;
    }
    return false;
  }

  private scheduleCatalogLoadingRefresh(
    workspaceId: string,
    snapshot: WorkspaceAppCenterSnapshot
  ): void {
    if (snapshot.catalogStatus !== "loading") {
      this.clearCatalogRefreshTimer();
      return;
    }
    if (
      this.pollingWorkspaceId !== workspaceId ||
      this.catalogRefreshTimer !== null
    ) {
      return;
    }
    this.catalogRefreshTimer = setTimeout(() => {
      this.catalogRefreshTimer = null;
      if (this.pollingWorkspaceId !== workspaceId) {
        return;
      }
      void this.refresh(workspaceId);
    }, this.dependencies.catalogLoadingRefreshDelayMs ?? defaultCatalogLoadingRefreshDelayMs);
    this.catalogRefreshTimer.unref?.();
  }

  private syncTransientRuntimeRefresh(
    workspaceId: string,
    hasTransientRuntimeApps: boolean
  ): void {
    if (!this.usesPollingRefresh || this.pollingWorkspaceId !== workspaceId) {
      return;
    }
    if (!hasTransientRuntimeApps) {
      this.clearTransientRuntimeRefreshTimer();
      return;
    }
    if (this.transientRuntimeRefreshTimer) {
      return;
    }
    const maxAttempts =
      this.dependencies.transientRuntimeRefreshMaxAttempts ??
      defaultTransientRuntimeRefreshMaxAttempts;
    if (this.transientRuntimeRefreshAttempts >= maxAttempts) {
      return;
    }
    this.transientRuntimeRefreshTimer = setTimeout(() => {
      this.transientRuntimeRefreshTimer = null;
      if (
        this.pollingWorkspaceId !== workspaceId ||
        !this.hasTransientRuntimeApps(workspaceId, this.store.apps)
      ) {
        this.clearTransientRuntimeRefreshTimer();
        return;
      }
      this.transientRuntimeRefreshAttempts += 1;
      void this.refreshTransientRuntimeState(workspaceId);
    }, this.dependencies.transientRuntimeRefreshDelayMs ?? defaultTransientRuntimeRefreshDelayMs);
    this.transientRuntimeRefreshTimer.unref?.();
  }

  private hasTransientRuntimeApps(
    workspaceId: string,
    apps: readonly WorkspaceAppCenterApp[]
  ): boolean {
    return apps.some(
      (app) =>
        app.enabled &&
        app.installed &&
        (app.runtimeStatus === "preparing" ||
          app.runtimeStatus === "starting") &&
        !this.pendingInstallKeys.has(appRuntimeKey(workspaceId, app.appId))
    );
  }

  private async refreshTransientRuntimeState(
    workspaceId: string
  ): Promise<void> {
    try {
      const snapshot =
        await this.dependencies.gateway.listWorkspaceApps(workspaceId);
      this.applySnapshot(workspaceId, snapshot);
    } catch (error) {
      this.setOperationError(error, {
        operation: "app_center.refresh",
        workspaceId
      });
      this.syncTransientRuntimeRefresh(
        workspaceId,
        this.hasTransientRuntimeApps(workspaceId, this.store.apps)
      );
    }
  }

  protected mergeActiveInstallAppState(
    workspaceId: string,
    app: WorkspaceAppCenterApp,
    previousApp?: WorkspaceAppCenterApp
  ): WorkspaceAppCenterApp {
    const installKey = appRuntimeKey(workspaceId, app.appId);
    if (!this.pendingInstallKeys.has(installKey)) {
      return app;
    }
    if (this.isPendingInstallSettled(installKey, app, previousApp)) {
      return app;
    }
    const incomingRuntimeStatus = app.runtimeStatus;
    const runtimeStatus = this.isRuntimeInstallLifecycleStatus(
      incomingRuntimeStatus
    )
      ? incomingRuntimeStatus
      : "installing";
    return {
      ...app,
      enabled: true,
      installed: this.pendingInstallReportKeys.has(installKey)
        ? false
        : app.installed,
      installProgress: reconcilePendingInstallProgress({
        incoming: app.installProgress,
        previous: previousApp?.installProgress ?? null,
        runtimeStatus: incomingRuntimeStatus
      }),
      runtimeStatus
    };
  }

  private isRuntimeInstallLifecycleStatus(
    runtimeStatus: WorkspaceAppCenterApp["runtimeStatus"]
  ): boolean {
    return (
      runtimeStatus === "installing" ||
      runtimeStatus === "preparing" ||
      runtimeStatus === "starting"
    );
  }

  private isPendingInstallAbandoned(
    installKey: string,
    app: WorkspaceAppCenterApp,
    previousApp?: WorkspaceAppCenterApp
  ): boolean {
    return (
      this.pendingInstallReportKeys.has(installKey) &&
      !app.installed &&
      app.runtimeStatus === "idle" &&
      app.installProgress == null &&
      this.hasObservedInstallActivity(previousApp)
    );
  }

  private hasObservedInstallActivity(
    app: WorkspaceAppCenterApp | undefined
  ): boolean {
    return (
      app?.installProgress != null ||
      app?.runtimeStatus === "preparing" ||
      app?.runtimeStatus === "starting"
    );
  }

  private withPendingInstallState(
    workspaceId: string,
    apps: readonly WorkspaceAppCenterApp[]
  ): WorkspaceAppCenterApp[] {
    const previousAppsById = new Map(
      this.store.apps.map((app) => [app.appId, app])
    );
    return apps.map((app) =>
      this.mergeActiveInstallAppState(
        workspaceId,
        app,
        previousAppsById.get(app.appId)
      )
    );
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
      this.setOperationError(error, {
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

  private reconcileActiveInstallRefreshes(
    workspaceId: string,
    apps: readonly WorkspaceAppCenterApp[]
  ): void {
    if (!this.usesPollingRefresh || this.pollingWorkspaceId !== workspaceId) {
      return;
    }
    for (const app of apps) {
      const key = appRuntimeKey(workspaceId, app.appId);
      if (this.pendingInstallKeys.has(key)) {
        continue;
      }
      if (this.shouldRefreshActiveInstallApp(app)) {
        this.scheduleActiveInstallRefresh(workspaceId, app.appId);
      } else {
        this.clearActiveInstallRefreshTimer(workspaceId, app.appId);
      }
    }
  }

  private shouldRefreshActiveInstallApp(app: WorkspaceAppCenterApp): boolean {
    return (
      app.installProgress != null ||
      this.isRuntimeInstallBusy(app.runtimeStatus)
    );
  }

  private scheduleActiveInstallRefresh(
    workspaceId: string,
    appId: string
  ): void {
    if (!this.usesPollingRefresh) {
      return;
    }
    const key = appRuntimeKey(workspaceId, appId);
    if (this.activeInstallRefreshTimers.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      this.activeInstallRefreshTimers.delete(key);
      if (this.pollingWorkspaceId !== workspaceId) {
        return;
      }
      void this.refreshActiveInstallState(workspaceId, appId);
    }, this.dependencies.installRefreshDelayMs ?? defaultInstallRefreshDelayMs);
    timer.unref?.();
    this.activeInstallRefreshTimers.set(key, timer);
  }

  private async refreshActiveInstallState(
    workspaceId: string,
    appId: string
  ): Promise<void> {
    try {
      const snapshot =
        await this.dependencies.gateway.listWorkspaceApps(workspaceId);
      this.applyActiveInstallRefreshSnapshot(workspaceId, appId, snapshot);
    } catch (error) {
      this.setOperationError(error, {
        appId,
        operation: "workspace_app.refresh_install_state",
        uiAction: "refresh_install_state",
        workspaceId
      });
    }
  }

  private applyActiveInstallRefreshSnapshot(
    workspaceId: string,
    appId: string,
    snapshot: WorkspaceAppCenterSnapshot
  ): void {
    if (this.store.workspaceId !== workspaceId) {
      this.applySnapshot(workspaceId, snapshot);
      return;
    }
    const currentApp = this.store.apps.find(
      (candidate) => candidate.appId === appId
    );
    const refreshedApp = snapshot.apps.find(
      (candidate) => candidate.appId === appId
    );
    if (
      currentApp &&
      refreshedApp &&
      currentApp.stateRevision === refreshedApp.stateRevision &&
      this.shouldRefreshActiveInstallApp(currentApp) &&
      !this.shouldRefreshActiveInstallApp(refreshedApp)
    ) {
      this.applySnapshotWithForcedApp(workspaceId, snapshot, refreshedApp);
      return;
    }
    this.applySnapshot(workspaceId, snapshot);
  }

  private applySnapshotWithForcedApp(
    workspaceId: string,
    snapshot: WorkspaceAppCenterSnapshot,
    forcedApp: WorkspaceAppCenterApp
  ): void {
    const nextApps = sortWorkspaceAppCenterApps(
      this.mergeSnapshotAppsByStateRevision(
        workspaceId,
        this.withPendingInstallState(workspaceId, snapshot.apps)
      ).map((app) => (app.appId === forcedApp.appId ? forcedApp : app))
    );
    const appIdsToClose =
      this.store.workspaceId === workspaceId
        ? removedOrUninstalledAppIds(this.store.apps, nextApps)
        : [];
    this.reconcileActiveInstallRefreshes(workspaceId, nextApps);
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

  private settlePendingInstallReport(input: {
    app: WorkspaceAppCenterApp;
    failureReason: string | null;
    previousApp?: WorkspaceAppCenterApp;
    workspaceId: string;
  }): void {
    const installKey = appRuntimeKey(input.workspaceId, input.app.appId);
    if (!this.pendingInstallKeys.has(installKey)) {
      return;
    }
    if (
      !this.isPendingInstallSettled(installKey, input.app, input.previousApp)
    ) {
      return;
    }

    this.pendingInstallKeys.delete(installKey);
    this.clearInstallRefreshTimer(input.workspaceId, input.app.appId);
    if (!this.pendingInstallReportKeys.delete(installKey)) {
      return;
    }
    if (input.app.installed) {
      this.dependencies.hooks?.onAppInstalled?.(input.app);
      return;
    }
    if (
      input.app.runtimeStatus === "idle" &&
      input.app.installProgress == null &&
      input.failureReason == null &&
      input.app.failureReason == null &&
      input.app.lastError == null
    ) {
      return;
    }
    this.dependencies.hooks?.onAppInstallFailed?.({
      app: input.app,
      appId: input.app.appId,
      failureReason:
        input.failureReason ??
        input.app.failureReason ??
        input.app.lastError ??
        null
    });
  }
}
