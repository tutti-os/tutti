import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { DesktopApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import { IAppUpdateService } from "./appUpdateService.interface";
import { createDesktopAppUpdateClient } from "./internal/adapters/desktopAppUpdateClient";
import { AppUpdateService } from "./internal/appUpdateService";

export function registerAppUpdateServices(
  registry: ServiceRegistry,
  desktopApi: DesktopApi,
  input: {
    reporterService?: Pick<IReporterService, "trackEvents">;
  } = {}
): void {
  registry.registerInstance(
    IAppUpdateService,
    new AppUpdateService(
      createDesktopAppUpdateClient(desktopApi.update),
      input.reporterService ?? null
    )
  );
}
