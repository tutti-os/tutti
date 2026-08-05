import type {
  Connector,
  ConnectorAuthorizationResult,
  ConnectorMarketCatalogPage,
  ConnectorMarketCategory,
  ConnectorMarketMutationInput,
  ConnectorMarketSnapshot,
  ConnectorMutationInput,
  ConnectorWorkspaceMutationInput,
  ConnectorMutationResult,
  ConnectorOperation,
  ConnectorWorkspaceBindingResult,
  SetConnectorWorkspaceEnabledInput
} from "./domain.ts";

export interface ConnectorMarketBackend {
  getSnapshot(input: {
    workspaceId?: string;
  }): Promise<ConnectorMarketSnapshot>;
  listCategories(): Promise<ConnectorMarketCategory[]>;
  listCatalogPage(input: {
    sectionId: string;
    pageSize: number;
    pageToken?: string;
    workspaceId?: string;
  }): Promise<ConnectorMarketCatalogPage>;
  getConnector(input: {
    connectorKey: string;
    workspaceId?: string;
  }): Promise<Connector>;
  getOperation(input: { operationId: string }): Promise<ConnectorOperation>;
  refreshCatalog(
    input: ConnectorMarketMutationInput
  ): Promise<ConnectorMutationResult>;
  installConnector(
    input: ConnectorWorkspaceMutationInput
  ): Promise<ConnectorMutationResult>;
  uninstallConnector(
    input: ConnectorMutationInput
  ): Promise<ConnectorMutationResult>;
  beginAuthorization(
    input: ConnectorWorkspaceMutationInput
  ): Promise<ConnectorAuthorizationResult>;
  disconnectAuthorization(
    input: ConnectorMutationInput
  ): Promise<ConnectorMutationResult>;
  setWorkspaceEnabled(
    input: SetConnectorWorkspaceEnabledInput
  ): Promise<ConnectorWorkspaceBindingResult>;
}
