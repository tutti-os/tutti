import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { IConnectorMarketRoot } from "../services/core/connectorMarketRoot.interface.ts";

export interface ConnectorMarketServices extends Omit<
  IConnectorMarketRoot,
  "_serviceBrand"
> {
  i18n: ConnectorMarketI18nRuntime;
  onError?: (message: string) => void;
  onTryConnector?: (connectorKey: string) => void;
}

export interface ConnectorMarketRootProviderProps {
  children: ReactNode;
  i18n: ConnectorMarketI18nRuntime;
  onError?: (message: string) => void;
  onTryConnector?: (connectorKey: string) => void;
  root: IConnectorMarketRoot;
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

export function ConnectorMarketRootProvider({
  children,
  i18n,
  onError,
  onTryConnector,
  root
}: ConnectorMarketRootProviderProps) {
  const services = useMemo(
    () => ({
      i18n,
      market: root.market,
      onError,
      onTryConnector,
      uiState: root.uiState,
      view: root.view
    }),
    [i18n, onError, onTryConnector, root]
  );

  return (
    <ConnectorMarketServicesProvider services={services}>
      {children}
    </ConnectorMarketServicesProvider>
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
