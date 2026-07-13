import type { ServiceRegistry } from "@tutti-os/infra/di";
import {
  IFusionDockService,
  type FusionDockServiceRegistrationInput
} from "./fusionDockService.interface.ts";
import { FusionDockService } from "./internal/fusionDockService.ts";

export function registerFusionDockService(
  registry: ServiceRegistry,
  input: FusionDockServiceRegistrationInput
): FusionDockService {
  const service = new FusionDockService(input);
  registry.registerInstance(IFusionDockService, service);
  void service.start();
  return service;
}
