import { useSnapshot } from "valtio";

import type { IConnectorMarketService } from "../services/index.ts";

export function useConnectorMarketSnapshot(
  service: Pick<IConnectorMarketService, "dataStore">
) {
  return useSnapshot(service.dataStore);
}
