import type {
  Connector,
  ConnectorAuthorizationResult,
  ConnectorMarketMutationInput,
  ConnectorMarketSnapshot,
  ConnectorMutationInput,
  ConnectorMutationResult,
  ConnectorOperation,
  ConnectorWorkspaceBindingResult,
  SetConnectorWorkspaceEnabledInput
} from "./domain.ts";

export interface ConnectorMarketBackend {
  getSnapshot(input: {
    workspaceId?: string;
  }): Promise<ConnectorMarketSnapshot>;
  getConnector(input: {
    connectorKey: string;
    workspaceId?: string;
  }): Promise<Connector>;
  getOperation(input: { operationId: string }): Promise<ConnectorOperation>;
  refreshCatalog(
    input: ConnectorMarketMutationInput
  ): Promise<ConnectorMutationResult>;
  installConnector(
    input: ConnectorMutationInput
  ): Promise<ConnectorMutationResult>;
  uninstallConnector(
    input: ConnectorMutationInput
  ): Promise<ConnectorMutationResult>;
  beginAuthorization(
    input: ConnectorMutationInput
  ): Promise<ConnectorAuthorizationResult>;
  disconnectAuthorization(
    input: ConnectorMutationInput
  ): Promise<ConnectorMutationResult>;
  setWorkspaceEnabled(
    input: SetConnectorWorkspaceEnabledInput
  ): Promise<ConnectorWorkspaceBindingResult>;
}
