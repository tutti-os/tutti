import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { DesktopApi } from "@preload/types";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import { IAppUpdateService } from "./appUpdateService.interface.ts";
import { createDesktopAppUpdateClient } from "./internal/adapters/desktopAppUpdateClient.ts";
import { AppUpdateService } from "./internal/appUpdateService.ts";

export function registerAppUpdateServices(
  registry: ServiceRegistry,
  desktopApi: DesktopApi,
  input: {
    notifications?: Pick<NotificationService, "error" | "info" | "success">;
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
    desktopApi.runtime,
    {
      hostFilesApi: desktopApi.host?.files,
      notifications: input.notifications,
      supportsReleaseChannels: desktopApi.platform?.distribution !== "store"
    }
  );
  registry.registerInstance(IAppUpdateService, service);
  void service.load();
}
