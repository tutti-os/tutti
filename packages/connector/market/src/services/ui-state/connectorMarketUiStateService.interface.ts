import { createDecorator } from "@tutti-os/infra/di";

export type ConnectorMarketSegment = "available" | "installed";

export type ConnectorMarketScope = Readonly<Record<string, never>>;

export interface ConnectorMarketDialogRequest {
  connectorKey: string;
  kind: "connector" | "uninstall_confirmation";
}

export interface ConnectorMarketUiState {
  dialog: ConnectorMarketDialogRequest | null;
  query: string;
  scope: ConnectorMarketScope | null;
  segment: ConnectorMarketSegment;
  started: boolean;
}

export interface IConnectorMarketUiStateService {
  readonly _serviceBrand: undefined;
  readonly dataStore: ConnectorMarketUiState;

  start(scope: ConnectorMarketScope): void;
  setQuery(query: string): void;
  selectSegment(segment: ConnectorMarketSegment): void;
  openConnector(connectorKey: string): void;
  requestUninstall(connectorKey: string): void;
  closeDialog(): void;
  dispose(): void;
}

export const IConnectorMarketUiStateService =
  createDecorator<IConnectorMarketUiStateService>(
    "connector-market-ui-state-service"
  );
