import { proxy } from "valtio/vanilla";

import type {
  ConnectorMarketScope,
  ConnectorMarketUiState,
  IConnectorMarketUiStateService
} from "./connectorMarketUiStateService.interface.ts";

export class ConnectorMarketUiStateService implements IConnectorMarketUiStateService {
  declare readonly _serviceBrand: undefined;
  readonly dataStore = proxy<ConnectorMarketUiState>({
    dialog: null,
    query: "",
    scope: null,
    started: false
  });

  private disposed = false;

  start(scope: ConnectorMarketScope): void {
    if (this.disposed) {
      return;
    }
    this.dataStore.scope = { ...scope };
    this.dataStore.query = "";
    this.dataStore.dialog = null;
    this.dataStore.started = true;
  }

  setQuery(query: string): void {
    if (!this.disposed) {
      this.dataStore.query = query;
    }
  }

  openConnector(connectorKey: string): void {
    if (!this.disposed) {
      this.dataStore.dialog = { connectorKey, kind: "connector" };
    }
  }

  requestUninstall(connectorKey: string): void {
    if (!this.disposed) {
      this.dataStore.dialog = {
        connectorKey,
        kind: "uninstall_confirmation"
      };
    }
  }

  closeDialog(): void {
    if (!this.disposed) {
      this.dataStore.dialog = null;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dataStore.dialog = null;
    this.dataStore.query = "";
    this.dataStore.scope = null;
    this.dataStore.started = false;
  }
}
