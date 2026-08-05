import { createDecorator } from "@tutti-os/infra/di";

export type ConnectorMarketSegment = "available" | "installed";

export interface ConnectorMarketScope {
  workspaceId: string;
  principalId?: string;
}

export interface ConnectorMarketDialogRequest {
  connectorKey: string;
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
  closeDialog(): void;
  dispose(): void;
}

export const IConnectorMarketUiStateService =
  createDecorator<IConnectorMarketUiStateService>(
    "connector-market-ui-state-service"
  );
