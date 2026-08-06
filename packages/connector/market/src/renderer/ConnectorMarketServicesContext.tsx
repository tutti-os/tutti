import { createContext, useContext, type ReactNode } from "react";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { IConnectorMarketRoot } from "../services/core/connectorMarketRoot.interface.ts";

export interface ConnectorMarketServices extends Omit<
  IConnectorMarketRoot,
  "_serviceBrand"
> {
  i18n: ConnectorMarketI18nRuntime;
  onTryConnector?: (connectorKey: string) => void;
}

const ConnectorMarketServicesContext =
  createContext<ConnectorMarketServices | null>(null);

export function ConnectorMarketServicesProvider({
  children,
  services
}: {
  children: ReactNode;
  services: ConnectorMarketServices;
}) {
  return (
    <ConnectorMarketServicesContext.Provider value={services}>
      {children}
    </ConnectorMarketServicesContext.Provider>
  );
}

export function useConnectorMarketServices(): ConnectorMarketServices {
  const services = useContext(ConnectorMarketServicesContext);
  if (!services) {
    throw new Error(
      "useConnectorMarketServices must be used within ConnectorMarketServicesProvider"
    );
  }
  return services;
}
