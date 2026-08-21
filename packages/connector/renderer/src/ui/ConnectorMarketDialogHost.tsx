import type { ConnectorMarketI18nRuntime } from "./i18n/connectorMarketI18n.ts";
import type { AuthorizationViewRenderer } from "./authorization/AuthorizationViewRenderer.tsx";
import type { IConnectorMarketRoot } from "../application/services/core/connectorMarketRoot.interface.ts";
import { ConnectorMarketRootProvider } from "./ConnectorMarketServicesContext.tsx";
import { ConnectorMarketDialogs } from "./dialogs/ConnectorMarketDialogs.tsx";

export interface ConnectorMarketDialogHostProps {
  authorizationRenderer?: AuthorizationViewRenderer;
  i18n: ConnectorMarketI18nRuntime;
  locale?: string;
  onError?: (message: string) => void;
  onTryConnector?: (connectorKey: string) => void;
  root: IConnectorMarketRoot;
}

/**
 * Window-level host for the connector market's canonical installation,
 * authorization, management, and compatibility dialogs.
 */
export function ConnectorMarketDialogHost({
  authorizationRenderer,
  i18n,
  locale,
  onError,
  onTryConnector,
  root
}: ConnectorMarketDialogHostProps) {
  return (
    <ConnectorMarketRootProvider
      authorizationRenderer={authorizationRenderer}
      i18n={i18n}
      locale={locale}
      onError={onError}
      onTryConnector={onTryConnector}
      root={root}
    >
      <ConnectorMarketDialogs />
    </ConnectorMarketRootProvider>
  );
}
