import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { ReporterService } from "./internal/reporterService";
import { IReporterService } from "./reporterService.interface";

export interface ReporterServiceRegistrationInput {
  tuttidClient: Pick<TuttidClient, "trackEvents">;
}

export function registerReporterServices(
  registry: ServiceRegistry,
  input: ReporterServiceRegistrationInput
): IReporterService {
  const reporterService = new ReporterService({
    tuttidClient: input.tuttidClient
  });
  registry.registerInstance(IReporterService, reporterService);
  return reporterService;
}
