import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopWorkspaceUiMode } from "@shared/preferences";
import { ReporterService } from "./internal/reporterService";
import { IReporterService } from "./reporterService.interface";

export interface ReporterServiceRegistrationInput {
  tuttidClient: Pick<TuttidClient, "trackEvents">;
  mode: DesktopWorkspaceUiMode;
}

export function registerReporterServices(
  registry: ServiceRegistry,
  input: ReporterServiceRegistrationInput
): IReporterService {
  const reporterService = new ReporterService({
    tuttidClient: input.tuttidClient,
    mode: input.mode
  });
  registry.registerInstance(IReporterService, reporterService);
  return reporterService;
}
