import type { ConnectorMarketChangedEvent } from "./domain.ts";

export interface ConnectorMarketEventSource {
  subscribe(listener: (event: ConnectorMarketChangedEvent) => void): () => void;
  subscribeConnectionState?(
    listener: (state: "connected" | "disconnected") => void
  ): () => void;
}
