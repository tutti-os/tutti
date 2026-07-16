import type { DesktopLocale } from "../shared/i18n";
import {
  classifyDesktopErrorCode,
  formatErrorMessage
} from "../shared/errors/desktopErrors.ts";
import type { DesktopDaemonRuntime } from "./desktopDaemonRuntime.ts";
import type {
  CreateDesktopHostServicesOptions,
  DesktopHostServices
} from "./desktopHostServices.ts";
import type { DesktopLogger } from "./logging.ts";
import type { AppUpdateService } from "./update/appUpdateService.ts";
import type {
  DesktopCliShimState,
  EnsureDesktopCliShimOptions
} from "./cli/cliInstaller.ts";
import {
  flushStartupFailureEvents,
  recordStartupFailureEvent
} from "./startupFailureAnalytics.ts";

export interface DesktopAppServices
  extends DesktopDaemonRuntime, DesktopHostServices {
  updateService: AppUpdateService;
}

export interface CreateDesktopAppServicesOptions {
  appVersion?: string;
  enableDevelopmentReloadShortcut?: boolean;
  fallbackLocale: DesktopLocale;
  browserNodeGuestPreloadPath?: string;
  isPackaged?: boolean;
  logger: DesktopLogger;
  preloadPath: string;
  rendererUrl?: string;
  startupFailureQueuePath?: string;
  workspaceAppPreloadPath?: string;
}

interface DesktopAppServiceFactories {
  createDaemonRuntime(): Promise<DesktopDaemonRuntime> | DesktopDaemonRuntime;
  createHostServices(
    options: CreateDesktopHostServicesOptions
  ): Promise<DesktopHostServices>;
  createUpdateService(): Promise<AppUpdateService> | AppUpdateService;
  ensureCliShim(
    options: EnsureDesktopCliShimOptions
  ): Promise<DesktopCliShimState> | DesktopCliShimState;
}

export async function createDesktopAppServices(
  options: CreateDesktopAppServicesOptions,
  factories?: Partial<DesktopAppServiceFactories>
): Promise<DesktopAppServices> {
  const daemonRuntime = await resolveDaemonRuntime(factories);
  const updateService = await resolveUpdateService(factories);

  try {
    await daemonRuntime.tuttid.start();
  } catch (error) {
    await recordStartupFailureEvent({
      error,
      name: "daemon.startup_failed",
      queuePath: options.startupFailureQueuePath
    }).catch((recordError) => {
      options.logger.warn("failed to record daemon startup failure analytics", {
        error: formatErrorMessage(recordError)
      });
    });
    options.logger.error("failed to start managed tuttid", {
      error: formatErrorMessage(error),
      error_code: classifyDesktopErrorCode(error)
    });
    throw error;
  }

  await flushStartupFailureEvents({
    tuttidClient: daemonRuntime.tuttidClient,
    queuePath: options.startupFailureQueuePath
  }).catch((error) => {
    options.logger.warn("failed to flush startup failure analytics", {
      error: formatErrorMessage(error)
    });
  });

  void ensureCliShimInBackground(options, factories);

  const hostServices = await resolveHostServices(factories, {
    browserNodeGuestPreloadPath: options.browserNodeGuestPreloadPath,
    enableDevelopmentReloadShortcut: options.enableDevelopmentReloadShortcut,
    appVersion: options.appVersion,
    fallbackLocale: options.fallbackLocale,
    logger: options.logger,
    tuttidClient: daemonRuntime.tuttidClient,
    preloadPath: options.preloadPath,
    rendererUrl: options.rendererUrl,
    workspaceAppPreloadPath: options.workspaceAppPreloadPath
  });

  return {
    ...daemonRuntime,
    ...hostServices,
    updateService
  };
}

async function ensureCliShimInBackground(
  options: CreateDesktopAppServicesOptions,
  factories?: Partial<DesktopAppServiceFactories>
): Promise<void> {
  try {
    const cliShim = await resolveCliShim(factories, {
      isPackaged: Boolean(options.isPackaged)
    });
    if (cliShim.pathShimPath) {
      options.logger.info("tutti cli shim ready", {
        path_shim_path: cliShim.pathShimPath,
        shim_path: cliShim.shimPath
      });
    } else {
      options.logger.warn("tutti cli shim is not discoverable on user PATH", {
        shim_path: cliShim.shimPath
      });
    }
  } catch (error) {
    options.logger.warn("failed to install tutti cli shim", {
      error: formatErrorMessage(error),
      error_code: classifyDesktopErrorCode(error)
    });
  }
}

async function resolveDaemonRuntime(
  factories?: Partial<DesktopAppServiceFactories>
): Promise<DesktopDaemonRuntime> {
  if (factories?.createDaemonRuntime) {
    return factories.createDaemonRuntime();
  }

  const { createDesktopDaemonRuntime } =
    await import("./desktopDaemonRuntime.ts");
  return createDesktopDaemonRuntime();
}

async function resolveHostServices(
  factories: Partial<DesktopAppServiceFactories> | undefined,
  options: CreateDesktopHostServicesOptions
): Promise<DesktopHostServices> {
  if (factories?.createHostServices) {
    return factories.createHostServices(options);
  }

  const { createDesktopHostServices } =
    await import("./desktopHostServices.ts");
  return createDesktopHostServices(options);
}

async function resolveUpdateService(
  factories?: Partial<DesktopAppServiceFactories>
): Promise<AppUpdateService> {
  if (factories?.createUpdateService) {
    return factories.createUpdateService();
  }

  const { createAppUpdateService } =
    await import("./update/appUpdateService.ts");
  return createAppUpdateService();
}

async function resolveCliShim(
  factories: Partial<DesktopAppServiceFactories> | undefined,
  options: EnsureDesktopCliShimOptions
): Promise<DesktopCliShimState> {
  if (factories?.ensureCliShim) {
    return factories.ensureCliShim(options);
  }

  const { ensureDesktopCliShim } = await import("./cli/cliInstaller.ts");
  return ensureDesktopCliShim(options);
}
