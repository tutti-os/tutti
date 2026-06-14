import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostWorkspaceApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface";
import { IWorkspaceCatalogService } from "./workspaceCatalogService.interface";
import { createDesktopWorkspaceCatalogGateway } from "./internal/adapters/desktopWorkspaceCatalogGateway";
import { WorkspaceCatalogService } from "./internal/workspaceCatalogService";

export interface WorkspaceCatalogServiceRegistrationInput {
  hostApi: {
    platform: NodeJS.Platform;
    workspace: DesktopHostWorkspaceApi;
  };
  tuttidClient: TuttidClient;
  reporterService: Pick<IReporterService, "trackEvents">;
}

export function registerWorkspaceCatalogServices(
  registry: ServiceRegistry,
  input: WorkspaceCatalogServiceRegistrationInput
): void {
  registry.registerInstance(
    IWorkspaceCatalogService,
    new WorkspaceCatalogService({
      gateway: createDesktopWorkspaceCatalogGateway(
        input.hostApi.workspace,
        input.tuttidClient
      ),
      platform: input.hostApi.platform,
      reporterService: input.reporterService
    })
  );
}
