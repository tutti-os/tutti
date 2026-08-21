import {
  IConnectorMarketService,
  type IConnectorMarketService as ConnectorMarketService
} from "../connectorMarketService.interface.ts";
import {
  IConnectorMarketUiStateService,
  type IConnectorMarketUiStateService as ConnectorMarketUiStateService
} from "../ui-state/connectorMarketUiStateService.interface.ts";
import {
  IConnectorMarketViewService,
  type IConnectorMarketViewService as ConnectorMarketViewService
} from "../view/connectorMarketViewService.interface.ts";
import type { IConnectorMarketRoot } from "./connectorMarketRoot.interface.ts";

export class ConnectorMarketRoot implements IConnectorMarketRoot {
  declare readonly _serviceBrand: undefined;

  constructor(
    readonly market: ConnectorMarketService,
    readonly uiState: ConnectorMarketUiStateService,
    readonly view: ConnectorMarketViewService
  ) {}
}

IConnectorMarketService(ConnectorMarketRoot, undefined, 0);
IConnectorMarketUiStateService(ConnectorMarketRoot, undefined, 1);
IConnectorMarketViewService(ConnectorMarketRoot, undefined, 2);
