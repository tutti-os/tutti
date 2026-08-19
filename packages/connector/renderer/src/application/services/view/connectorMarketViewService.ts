import { proxy, subscribe } from "valtio/vanilla";

import {
  IConnectorMarketService,
  type IConnectorMarketService as ConnectorMarketService
} from "../connectorMarketService.interface.ts";
import {
  IConnectorMarketUiStateService,
  type IConnectorMarketUiStateService as ConnectorMarketUiStateService
} from "../ui-state/connectorMarketUiStateService.interface.ts";
import { buildConnectorMarketView } from "./connectorMarketViewBuilder.ts";
import type { IConnectorMarketViewService } from "./connectorMarketViewService.interface.ts";
import type { ConnectorMarketViewState } from "./connectorMarketViewTypes.ts";

export class ConnectorMarketViewService implements IConnectorMarketViewService {
  declare readonly _serviceBrand: undefined;
  readonly dataStore = proxy<ConnectorMarketViewState>({
    availableCount: 0,
    cardsByKey: {},
    catalogError: null,
    dialog: null,
    installedCount: 0,
    refreshing: false,
    sections: [],
    status: "loading"
  });

  private subscriptions: (() => void)[] = [];
  private started = false;
  private disposed = false;

  constructor(
    private readonly market: ConnectorMarketService,
    private readonly uiState: ConnectorMarketUiStateService
  ) {}

  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    const rebuild = () => this.rebuild();
    this.subscriptions = [
      subscribe(this.market.dataStore, rebuild, true),
      subscribe(this.uiState.dataStore, rebuild, true)
    ];
    this.rebuild();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsubscribe of this.subscriptions.splice(0)) {
      unsubscribe();
    }
  }

  private rebuild(): void {
    const next = buildConnectorMarketView(
      this.market.dataStore,
      this.uiState.dataStore
    );
    this.dataStore.availableCount = next.availableCount;
    this.dataStore.cardsByKey = next.cardsByKey;
    this.dataStore.catalogError = next.catalogError;
    this.dataStore.dialog = next.dialog;
    this.dataStore.installedCount = next.installedCount;
    this.dataStore.refreshing = next.refreshing;
    this.dataStore.sections = next.sections;
    this.dataStore.status = next.status;
  }
}

IConnectorMarketService(ConnectorMarketViewService, undefined, 0);
IConnectorMarketUiStateService(ConnectorMarketViewService, undefined, 1);
