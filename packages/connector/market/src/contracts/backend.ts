import type {
  Connector,
  ConnectorAuthorizationInput,
  ConnectorAuthorizationResult,
  ConnectorMarketCatalogPage,
  ConnectorMarketCategory,
  ConnectorMarketSnapshot,
  ConnectorMutationInput,
  ConnectorMutationResult,
  ConnectorOperation
} from "./domain.ts";

export interface ConnectorMarketBackend {
  getSnapshot(): Promise<ConnectorMarketSnapshot>;
  listCategories(): Promise<ConnectorMarketCategory[]>;
  listCatalogPage(input: {
    sectionId: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<ConnectorMarketCatalogPage>;
  getConnector(input: { connectorKey: string }): Promise<Connector>;
  getOperation(input: { operationId: string }): Promise<ConnectorOperation>;
  refreshCatalog(): Promise<ConnectorMarketSnapshot>;
  installConnector(
    input: ConnectorMutationInput
  ): Promise<ConnectorMutationResult>;
  uninstallConnector(
    input: ConnectorMutationInput
  ): Promise<ConnectorMutationResult>;
  beginAuthorization(
    input: ConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationResult>;
  disconnectAuthorization(
    input: ConnectorMutationInput
  ): Promise<ConnectorMutationResult>;
}
