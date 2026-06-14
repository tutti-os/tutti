import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";
import { IAnalyticsDebugPreferenceService } from "./analyticsDebugPreferenceService.interface";
import { IAnalyticsDebugEventService } from "./analyticsDebugEventService.interface";
import { AnalyticsDebugEventService } from "./internal/analyticsDebugEventService";
import { AnalyticsDebugPreferenceService } from "./internal/analyticsDebugPreferenceService";

export interface AnalyticsDebugServicesRegistrationInput {
  available: boolean;
  eventStreamClient: Pick<TuttidEventStreamClient, "connect" | "subscribe">;
}

export function registerAnalyticsDebugServices(
  registry: ServiceRegistry,
  input: AnalyticsDebugServicesRegistrationInput
): AnalyticsDebugEventService {
  registry.registerInstance(
    IAnalyticsDebugPreferenceService,
    new AnalyticsDebugPreferenceService({
      available: input.available
    })
  );
  const service = new AnalyticsDebugEventService({
    eventStreamClient: input.available ? input.eventStreamClient : undefined
  });
  registry.registerInstance(IAnalyticsDebugEventService, service);
  return service;
}
