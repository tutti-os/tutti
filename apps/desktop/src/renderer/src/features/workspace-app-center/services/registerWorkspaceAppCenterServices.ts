import type { ServiceRegistry } from "@tutti-os/infra/di";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type {
  DesktopHostFilesApi,
  DesktopRuntimeApi,
  DesktopHostWorkspaceApi
} from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import { createDesktopWorkspaceAppCenterGateway } from "./internal/adapters/desktopWorkspaceAppCenterGateway.ts";
import { WorkspaceAppCenterService } from "./internal/workspaceAppCenterService.ts";
import {
  IWorkspaceAppCenterService,
  type IWorkspaceAppCenterService as WorkspaceAppCenterServiceInterface
} from "./workspaceAppCenterService.interface";

export interface WorkspaceAppCenterServiceRegistrationInput {
  eventStreamClient: TuttidEventStreamClient;
  hostFilesApi: Pick<
    DesktopHostFilesApi,
    | "revealInFolder"
    | "selectAppArchive"
    | "selectAppArchiveExportPath"
    | "selectAppIconImage"
  >;
  hostWorkspaceApi: Pick<DesktopHostWorkspaceApi, "openWorkspaceAppFolder">;
  tuttidClient: TuttidClient;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
}

export function registerWorkspaceAppCenterServices(
  registry: ServiceRegistry,
  input: WorkspaceAppCenterServiceRegistrationInput
): WorkspaceAppCenterServiceInterface {
  const service = new WorkspaceAppCenterService({
    eventStreamClient: input.eventStreamClient,
    gateway: createDesktopWorkspaceAppCenterGateway(input.tuttidClient),
    hostFilesApi: input.hostFilesApi,
    hostWorkspaceApi: input.hostWorkspaceApi,
    tuttidClient: input.tuttidClient,
    reporterService: input.reporterService,
    runtimeApi: input.runtimeApi
  });
  registry.registerInstance(IWorkspaceAppCenterService, service);
  return service;
}
