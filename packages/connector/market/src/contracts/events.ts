import type { ConnectorMarketChangedEvent } from "./domain.ts";

export interface ConnectorMarketEventSource {
  subscribe(listener: (event: ConnectorMarketChangedEvent) => void): () => void;
}
