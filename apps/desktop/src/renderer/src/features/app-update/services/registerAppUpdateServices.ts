import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { DesktopApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import { IAppUpdateService } from "./appUpdateService.interface.ts";
import { createDesktopAppUpdateClient } from "./internal/adapters/desktopAppUpdateClient.ts";
import { AppUpdateService } from "./internal/appUpdateService.ts";

export function registerAppUpdateServices(
  registry: ServiceRegistry,
  desktopApi: DesktopApi,
  input: {
    reporterService?: Pick<IReporterService, "trackEvents">;
  } = {}
): void {
  void desktopApi.runtime
    ?.logRendererDiagnostic({
      details: {
        hasRuntimeApi: Boolean(desktopApi.runtime),
        hasUpdateApi: Boolean(desktopApi.update)
      },
      event: "app_update.service_registered",
      source: "app-update"
    })
    .catch(() => undefined);

  const service = new AppUpdateService(
    createDesktopAppUpdateClient(desktopApi.update),
    input.reporterService ?? null,
    undefined,
    desktopApi.runtime
  );
  registry.registerInstance(IAppUpdateService, service);
  void service.load();
}
