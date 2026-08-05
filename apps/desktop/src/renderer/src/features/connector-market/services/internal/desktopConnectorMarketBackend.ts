import type { ConnectorMarketBackend } from "@tutti-os/connector-market/contracts";
import type { ConnectorMarketClient } from "@tutti-os/client-tuttid-ts";

export function createDesktopConnectorMarketBackend(
  client: ConnectorMarketClient
): ConnectorMarketBackend {
  return {
    getSnapshot({ workspaceId }) {
      return client.getConnectorMarket(workspaceId);
    },
    async listCategories() {
      return (await client.listConnectorMarketCategories()).categories;
    },
    listCatalogPage(input) {
      return client.listConnectorMarketCatalog(input);
    },
    getConnector({ connectorKey, workspaceId }) {
      return client.getConnectorMarketConnector(connectorKey, workspaceId);
    },
    getOperation({ operationId }) {
      return client.getConnectorMarketOperation(operationId);
    },
    refreshCatalog(input) {
      return client.refreshConnectorMarket(input);
    },
    installConnector({ connectorKey, ...request }) {
      return client.installConnectorMarketConnector(connectorKey, request);
    },
    uninstallConnector({ connectorKey, ...request }) {
      return client.uninstallConnectorMarketConnector(connectorKey, request);
    },
    beginAuthorization({ connectorKey, ...request }) {
      return client.startConnectorMarketAuthorization(connectorKey, request);
    },
    disconnectAuthorization({ connectorKey, ...request }) {
      return client.disconnectConnectorMarketAuthorization(
        connectorKey,
        request
      );
    },
    setWorkspaceEnabled({ connectorKey, ...request }) {
      return client.setConnectorMarketWorkspaceBinding(connectorKey, request);
    }
  };
}
