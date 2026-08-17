import type { ConnectorMarketEventSource } from "@tutti-os/connector-market/contracts";
import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";

export function createDesktopConnectorMarketEvents(
  client: Pick<
    TuttidEventStreamClient,
    "subscribe" | "subscribeConnectionState"
  >
): ConnectorMarketEventSource {
  return {
    subscribe(listener) {
      return client.subscribe(
        "connector.market.changed",
        (event) => {
          listener({
            type: "connector.market.changed",
            revision: event.payload.revision,
            ...(event.payload.cursor !== undefined
              ? { cursor: event.payload.cursor }
              : {}),
            ...(event.payload.connectorKey
              ? { connectorKey: event.payload.connectorKey }
              : {}),
            ...(event.payload.operationId
              ? { operationId: event.payload.operationId }
              : {})
          });
        },
        { scope: null }
      );
    },
    subscribeConnectionState(listener) {
      return client.subscribeConnectionState((state) => {
        if (state === "connected" || state === "disconnected") {
          listener(state);
        }
      });
    }
  };
}
