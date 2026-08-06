import { createDecorator } from "@tutti-os/infra/di";

import type { ConnectorMarketViewState } from "./connectorMarketViewTypes.ts";

export interface IConnectorMarketViewService {
  readonly _serviceBrand: undefined;
  readonly dataStore: ConnectorMarketViewState;

  start(): void;
  dispose(): void;
}

export const IConnectorMarketViewService =
  createDecorator<IConnectorMarketViewService>("connector-market-view-service");
