import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { IConnectorMarketRoot } from "../services/core/connectorMarketRoot.interface.ts";
import { ConnectorMarketRootProvider } from "./ConnectorMarketServicesContext.tsx";
import { ConnectorMarketDialogs } from "./dialogs/ConnectorMarketDialogs.tsx";

export interface ConnectorMarketDialogHostProps {
  i18n: ConnectorMarketI18nRuntime;
  onError?: (message: string) => void;
  onTryConnector?: (connectorKey: string) => void;
  root: IConnectorMarketRoot;
}

/**
 * Window-level host for the connector market's canonical installation,
 * authorization, management, and compatibility dialogs.
 */
export function ConnectorMarketDialogHost({
  i18n,
  onError,
  onTryConnector,
  root
}: ConnectorMarketDialogHostProps) {
  return (
    <ConnectorMarketRootProvider
      i18n={i18n}
      onError={onError}
      onTryConnector={onTryConnector}
      root={root}
    >
      <ConnectorMarketDialogs />
    </ConnectorMarketRootProvider>
  );
}
