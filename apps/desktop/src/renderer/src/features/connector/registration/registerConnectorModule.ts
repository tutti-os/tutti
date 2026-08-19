import { ServiceOwnership, type ServiceRegistry } from "@tutti-os/infra/di";
import {
  ConnectorMarketModule,
  IConnectorMarketModule,
  type ConnectorMarketModuleService
} from "@tutti-os/connector-renderer/application";
import type {
  ConnectorMarketClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";

import { createDesktopConnectorMarketBackend } from "../adapters/desktopConnectorBackend.ts";
import { createDesktopConnectorMarketEvents } from "../adapters/desktopConnectorEvents.ts";

export interface ConnectorMarketModuleRegistrationInput {
  autoUpdateInstalledConnectors?: boolean;
  canRequest?: () => boolean;
  client: ConnectorMarketClient;
  eventStreamClient: TuttidEventStreamClient;
  openAuthorizationUrl?: (url: string) => Promise<void>;
  reportDiagnostic?: (error: unknown) => void;
  requestInstallAdmission?: () => void | Promise<void>;
}

export function registerConnectorMarketModule(
  registry: ServiceRegistry,
  input: ConnectorMarketModuleRegistrationInput
): ConnectorMarketModuleService {
  const module = new ConnectorMarketModule({
    market: {
      autoUpdateInstalledConnectors:
        input.autoUpdateInstalledConnectors ?? true,
      backend: createDesktopConnectorMarketBackend(input.client),
      canRequest: input.canRequest,
      events: createDesktopConnectorMarketEvents(input.eventStreamClient),
      openAuthorizationUrl: input.openAuthorizationUrl,
      reportDiagnostic: input.reportDiagnostic,
      requestInstallAdmission: input.requestInstallAdmission
    },
    scope: {}
  });
  registry.registerInstance(IConnectorMarketModule, module, {
    ownership: ServiceOwnership.Owned
  });
  return module;
}
