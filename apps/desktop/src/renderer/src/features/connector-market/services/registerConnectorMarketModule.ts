import { ServiceOwnership, type ServiceRegistry } from "@tutti-os/infra/di";
import {
  ConnectorMarketModule,
  IConnectorMarketModule,
  type ConnectorMarketModuleService
} from "@tutti-os/connector-market/services";
import type {
  ConnectorMarketClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";

import { createDesktopConnectorMarketBackend } from "./internal/desktopConnectorMarketBackend.ts";
import { createDesktopConnectorMarketEvents } from "./internal/desktopConnectorMarketEvents.ts";

export interface ConnectorMarketModuleRegistrationInput {
  canRequest?: () => boolean;
  client: ConnectorMarketClient;
  eventStreamClient: TuttidEventStreamClient;
  openAuthorizationUrl?: (url: string) => Promise<void>;
  principalId?: string;
  reportDiagnostic?: (error: unknown) => void;
  workspaceId: string;
}

export function registerConnectorMarketModule(
  registry: ServiceRegistry,
  input: ConnectorMarketModuleRegistrationInput
): ConnectorMarketModuleService {
  const module = new ConnectorMarketModule({
    market: {
      backend: createDesktopConnectorMarketBackend(input.client),
      canRequest: input.canRequest,
      events: createDesktopConnectorMarketEvents(input.eventStreamClient),
      openAuthorizationUrl: input.openAuthorizationUrl,
      reportDiagnostic: input.reportDiagnostic
    },
    scope: {
      principalId: input.principalId,
      workspaceId: input.workspaceId
    }
  });
  registry.registerInstance(IConnectorMarketModule, module, {
    ownership: ServiceOwnership.Owned
  });
  return module;
}
