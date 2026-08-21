import type { ConnectorMarketBackend } from "@tutti-os/connector-renderer/application";
import type { ConnectorMarketClient } from "@tutti-os/client-tuttid-ts";

export function createDesktopConnectorMarketBackend(
  client: ConnectorMarketClient
): ConnectorMarketBackend {
  return {
    getSnapshot() {
      return client.getConnectorMarket();
    },
    async listCategories() {
      return (await client.listConnectorMarketCategories()).categories;
    },
    listCatalogPage(input) {
      return client.listConnectorMarketCatalog(input);
    },
    getConnector({ connectorKey }) {
      return client.getConnectorMarketConnector(connectorKey);
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
    updateConnectorRuntime({ connectorKey, ...request }) {
      return client.updateConnectorMarketConnectorRuntime(
        connectorKey,
        request
      );
    },
    beginAuthorization({ connectorKey, ...request }) {
      return client.startConnectorMarketAuthorization(connectorKey, request);
    },
    cancelAuthorization({ connectorKey }) {
      return client.cancelConnectorMarketAuthorization(connectorKey);
    },
    disconnectAuthorization({ connectorKey, ...request }) {
      return client.disconnectConnectorMarketAuthorization(
        connectorKey,
        request
      );
    }
  };
}
