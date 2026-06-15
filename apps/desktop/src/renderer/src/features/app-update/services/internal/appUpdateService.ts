import { getActiveLocale } from "../../../../i18n/runtime.ts";
import { AppUpdateActionClickedReporter } from "../../../analytics/reporters/app-update-action-clicked/appUpdateActionClickedReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import { resolveDesktopErrorMessage } from "../../../../lib/desktopErrors.ts";
import type { AppUpdateState } from "@shared/contracts/ipc";
import type { DesktopRuntimeApi } from "@preload/types";
import type { IAppUpdateService } from "../appUpdateService.interface";
import type { DesktopAppUpdateClient } from "./adapters/desktopAppUpdateClient";
import { createAppUpdateStore } from "./appUpdateStore.ts";
import { resolveAppUpdateViewState } from "./appUpdateViewModel.ts";

let nextAppUpdateServiceInstanceNumber = 0;

function formatError(error: unknown): string {
  return resolveDesktopErrorMessage(error, getActiveLocale());
}

export class AppUpdateService implements IAppUpdateService {
  readonly _serviceBrand: undefined;
  readonly store = createAppUpdateStore();

  private disposed = false;
  private readonly instanceId = `app-update-service-${++nextAppUpdateServiceInstanceNumber}`;
  private unsubscribe: (() => void) | null = null;
  private readonly reporterService: Pick<
    IReporterService,
    "trackEvents"
  > | null;
  private readonly reporterNow?: () => number;
  private readonly runtimeApi?: Pick<
    DesktopRuntimeApi,
    "logRendererDiagnostic"
  >;
  private readonly updateClient: DesktopAppUpdateClient;

  constructor(
    updateClient: DesktopAppUpdateClient,
    reporterService: Pick<IReporterService, "trackEvents"> | null = null,
    reporterNow?: () => number,
    runtimeApi?: Pick<DesktopRuntimeApi, "logRendererDiagnostic">
  ) {
    this.updateClient = updateClient;
    this.reporterService = reporterService;
    this.reporterNow = reporterNow;
    this.runtimeApi = runtimeApi;
  }

  async load(): Promise<void> {
    this.recordDiagnostic("app_update.load_started");
    this.ensureSubscription();

    try {
      const updateState = await this.updateClient.getState();
      if (this.applyUpdateState(updateState)) {
        this.recordDiagnostic("app_update.load_succeeded");
      }
    } catch (error) {
      if (!this.disposed) {
        this.store.error = formatError(error);
        this.recordDiagnostic(
          "app_update.load_failed",
          {
            error: this.store.error
          },
          "warn"
        );
      }
    }
  }

  async checkForUpdates(): Promise<void> {
    if (this.store.isActing) {
      this.recordDiagnostic("app_update.check_skipped", {
        reason: "already_acting"
      });
      return;
    }

    this.reportActionClicked({
      action: "check",
      updateStatus: this.store.updateState?.status ?? "idle"
    });
    this.store.error = null;
    this.store.isActing = true;
    this.updateView();
    this.recordDiagnostic("app_update.check_started");

    try {
      if (this.applyUpdateState(await this.updateClient.checkForUpdates())) {
        this.recordDiagnostic("app_update.check_succeeded");
      }
    } catch (error) {
      if (!this.disposed) {
        this.store.error = formatError(error);
        this.recordDiagnostic(
          "app_update.check_failed",
          {
            error: this.store.error
          },
          "warn"
        );
      }
    } finally {
      if (!this.disposed) {
        this.store.isActing = false;
        this.updateView();
        this.recordDiagnostic("app_update.check_finished");
      }
    }
  }

  async runPrimaryAction(): Promise<void> {
    const view = resolveAppUpdateViewState(
      this.store.updateState,
      this.store.isActing
    );
    if (view.busy || !view.action) {
      this.recordDiagnostic("app_update.primary_action_skipped", {
        action: view.action,
        busy: view.busy
      });
      return;
    }

    this.reportActionClicked({
      action: view.action,
      updateStatus: this.store.updateState?.status ?? "idle"
    });
    this.store.error = null;
    this.store.isActing = true;
    this.updateView();
    this.recordDiagnostic("app_update.primary_action_started", {
      action: view.action
    });

    let keepActing = false;
    try {
      if (view.action === "download") {
        if (!this.applyUpdateState(await this.updateClient.downloadUpdate())) {
          return;
        }
      } else if (view.action === "install") {
        await this.updateClient.installUpdate();
        keepActing = true;
      } else {
        if (!this.applyUpdateState(await this.updateClient.checkForUpdates())) {
          return;
        }
      }
      this.recordDiagnostic("app_update.primary_action_succeeded", {
        action: view.action
      });
    } catch (error) {
      if (!this.disposed) {
        this.store.error = formatError(error);
        this.recordDiagnostic(
          "app_update.primary_action_failed",
          {
            action: view.action,
            error: this.store.error
          },
          "warn"
        );
      }
    } finally {
      if (!this.disposed) {
        if (!keepActing) {
          this.store.isActing = false;
          this.updateView();
        }
        this.recordDiagnostic("app_update.primary_action_finished", {
          action: view.action
        });
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.recordDiagnostic("app_update.service_disposed");
  }

  private ensureSubscription(): void {
    if (this.unsubscribe) {
      return;
    }

    this.recordDiagnostic("app_update.subscription_started");
    this.unsubscribe = this.updateClient.onState((updateState) => {
      if (this.applyUpdateState(updateState)) {
        this.recordDiagnostic("app_update.subscription_state_received");
      }
    });
  }

  private applyUpdateState(updateState: AppUpdateState): boolean {
    if (this.disposed) {
      this.recordDiagnostic(
        "app_update.state_apply_skipped",
        {
          incomingCurrentVersion: updateState.currentVersion,
          incomingLatestVersion: updateState.latestVersion,
          incomingStatus: updateState.status,
          reason: "disposed"
        },
        "warn"
      );
      return false;
    }

    this.store.error = null;
    this.store.updateState = updateState;
    this.updateView();
    this.recordDiagnostic("app_update.state_applied", {
      appliedCurrentVersion: this.store.updateState.currentVersion,
      appliedLatestVersion: this.store.updateState.latestVersion,
      appliedStatus: this.store.updateState.status,
      viewAction: this.store.view.action,
      viewActionKey: this.store.view.actionKey,
      viewVisible: this.store.view.visible
    });
    return true;
  }

  private updateView(): void {
    this.store.view = resolveAppUpdateViewState(
      this.store.updateState,
      this.store.isActing
    );
  }

  private recordDiagnostic(
    event: string,
    details: Record<string, unknown> = {},
    level: "info" | "warn" | "error" = "info"
  ): void {
    if (!this.runtimeApi) {
      return;
    }

    const updateState = this.store.updateState;
    void this.runtimeApi
      .logRendererDiagnostic({
        details: {
          ...details,
          currentVersion: updateState?.currentVersion ?? null,
          disposed: this.disposed,
          error: this.store.error,
          hasSubscription: Boolean(this.unsubscribe),
          instanceId: this.instanceId,
          isActing: this.store.isActing,
          latestVersion: updateState?.latestVersion ?? null,
          status: updateState?.status ?? null
        },
        event,
        level,
        source: "app-update"
      })
      .catch(() => undefined);
  }

  private reportActionClicked(input: {
    action: string;
    updateStatus: string;
  }): void {
    if (!this.reporterService) {
      return;
    }

    void new AppUpdateActionClickedReporter(input, {
      reporterService: this.reporterService,
      now: this.reporterNow
    }).report();
  }
}
