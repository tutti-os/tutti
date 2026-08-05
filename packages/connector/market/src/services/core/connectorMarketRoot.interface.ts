import { createDecorator } from "@tutti-os/infra/di";

import type { IConnectorMarketService } from "../connectorMarketService.interface.ts";
import type { IConnectorMarketUiStateService } from "../ui-state/connectorMarketUiStateService.interface.ts";
import type { IConnectorMarketViewService } from "../view/connectorMarketViewService.interface.ts";

export interface IConnectorMarketRoot {
  readonly _serviceBrand: undefined;
  readonly market: IConnectorMarketService;
  readonly uiState: IConnectorMarketUiStateService;
  readonly view: IConnectorMarketViewService;
}

export const IConnectorMarketRoot = createDecorator<IConnectorMarketRoot>(
  "connector-market-root"
);
