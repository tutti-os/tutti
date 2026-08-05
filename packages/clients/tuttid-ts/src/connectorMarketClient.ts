import {
  disconnectConnectorMarketAuthorization,
  getConnectorMarket,
  getConnectorMarketConnector,
  getConnectorMarketOperation,
  installConnectorMarketConnector,
  listConnectorMarketCatalog,
  listConnectorMarketCategories,
  refreshConnectorMarket,
  setConnectorMarketWorkspaceBinding,
  startConnectorMarketAuthorization,
  uninstallConnectorMarketConnector
} from "./generated/index.ts";
import type {
  ConnectorMarketAuthorizationResponse,
  ConnectorMarketCatalogPage,
  ConnectorMarketCategoriesResponse,
  ConnectorMarketConnector,
  ConnectorMarketConnectorResponse,
  ConnectorMarketError,
  ConnectorMarketMutationRequest,
  ConnectorMarketMutationResponse,
  ConnectorMarketWorkspaceMutationRequest,
  ConnectorMarketOperation,
  ConnectorMarketSnapshot,
  SetConnectorMarketWorkspaceBindingRequest
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";

interface ConnectorMarketClientResponse<TResult> {
  data?: TResult;
  error?: unknown;
  response?: Response;
}

export class ConnectorMarketClientError extends Error {
  readonly code: ConnectorMarketError["code"];
  readonly retryable: boolean;
  readonly revision?: number;
  readonly statusCode: number;
  readonly details: Readonly<ConnectorMarketError>;

  constructor(details: ConnectorMarketError, statusCode: number) {
    super(details.message);
    this.name = "ConnectorMarketClientError";
    this.code = details.code;
    this.retryable = details.retryable;
    this.revision = details.revision;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function isConnectorMarketClientError(
  error: unknown
): error is ConnectorMarketClientError {
  return error instanceof ConnectorMarketClientError;
}

export interface ConnectorMarketClient {
  getConnectorMarket(workspaceId?: string): Promise<ConnectorMarketSnapshot>;
  listConnectorMarketCategories(): Promise<ConnectorMarketCategoriesResponse>;
  listConnectorMarketCatalog(input: {
    sectionId: string;
    pageSize?: number;
    pageToken?: string;
    workspaceId?: string;
  }): Promise<ConnectorMarketCatalogPage>;
  getConnectorMarketConnector(
    connectorKey: string,
    workspaceId?: string
  ): Promise<ConnectorMarketConnector>;
  getConnectorMarketOperation(
    operationId: string
  ): Promise<ConnectorMarketOperation>;
  refreshConnectorMarket(
    request: ConnectorMarketMutationRequest
  ): Promise<ConnectorMarketMutationResponse>;
  installConnectorMarketConnector(
    connectorKey: string,
    request: ConnectorMarketWorkspaceMutationRequest
  ): Promise<ConnectorMarketMutationResponse>;
  uninstallConnectorMarketConnector(
    connectorKey: string,
    request: ConnectorMarketMutationRequest
  ): Promise<ConnectorMarketMutationResponse>;
  startConnectorMarketAuthorization(
    connectorKey: string,
    request: ConnectorMarketWorkspaceMutationRequest
  ): Promise<ConnectorMarketAuthorizationResponse>;
  disconnectConnectorMarketAuthorization(
    connectorKey: string,
    request: ConnectorMarketMutationRequest
  ): Promise<ConnectorMarketMutationResponse>;
  setConnectorMarketWorkspaceBinding(
    connectorKey: string,
    request: SetConnectorMarketWorkspaceBindingRequest
  ): Promise<ConnectorMarketConnectorResponse>;
}

export function createConnectorMarketClient(
  client: Client
): ConnectorMarketClient {
  return {
    async getConnectorMarket(workspaceId) {
      return unwrapConnectorMarketData(
        await getConnectorMarket({
          client,
          ...(workspaceId ? { query: { workspaceId } } : {})
        }),
        "Get connector market request failed."
      );
    },
    async listConnectorMarketCategories() {
      return unwrapConnectorMarketData(
        await listConnectorMarketCategories({ client }),
        "List connector market categories request failed."
      );
    },
    async listConnectorMarketCatalog(input) {
      return unwrapConnectorMarketData(
        await listConnectorMarketCatalog({ client, query: input }),
        "List connector market catalog request failed."
      );
    },
    async getConnectorMarketConnector(connectorKey, workspaceId) {
      return unwrapConnectorMarketData(
        await getConnectorMarketConnector({
          client,
          path: { connectorKey },
          ...(workspaceId ? { query: { workspaceId } } : {})
        }),
        "Get connector market connector request failed."
      );
    },
    async getConnectorMarketOperation(operationId) {
      return unwrapConnectorMarketData(
        await getConnectorMarketOperation({
          client,
          path: { operationID: operationId }
        }),
        "Get connector market operation request failed."
      );
    },
    async refreshConnectorMarket(request) {
      return unwrapConnectorMarketData(
        await refreshConnectorMarket({ client, body: request }),
        "Refresh connector market request failed."
      );
    },
    async installConnectorMarketConnector(connectorKey, request) {
      return unwrapConnectorMarketData(
        await installConnectorMarketConnector({
          client,
          body: request,
          path: { connectorKey }
        }),
        "Install connector request failed."
      );
    },
    async uninstallConnectorMarketConnector(connectorKey, request) {
      return unwrapConnectorMarketData(
        await uninstallConnectorMarketConnector({
          client,
          body: request,
          path: { connectorKey }
        }),
        "Uninstall connector request failed."
      );
    },
    async startConnectorMarketAuthorization(connectorKey, request) {
      return unwrapConnectorMarketData(
        await startConnectorMarketAuthorization({
          client,
          body: request,
          path: { connectorKey }
        }),
        "Start connector authorization request failed."
      );
    },
    async disconnectConnectorMarketAuthorization(connectorKey, request) {
      return unwrapConnectorMarketData(
        await disconnectConnectorMarketAuthorization({
          client,
          body: request,
          path: { connectorKey }
        }),
        "Disconnect connector authorization request failed."
      );
    },
    async setConnectorMarketWorkspaceBinding(connectorKey, request) {
      return unwrapConnectorMarketData(
        await setConnectorMarketWorkspaceBinding({
          client,
          body: request,
          path: { connectorKey }
        }),
        "Set connector workspace binding request failed."
      );
    }
  };
}

function unwrapConnectorMarketData<TResult>(
  response: ConnectorMarketClientResponse<TResult>,
  fallback: string
): TResult {
  const details = connectorMarketErrorDetails(response.error);
  if (details) {
    throw new ConnectorMarketClientError(
      details,
      response.response?.status ?? 0
    );
  }
  return unwrapData(response, fallback);
}

function connectorMarketErrorDetails(
  error: unknown
): ConnectorMarketError | null {
  if (isConnectorMarketErrorDetails(error)) {
    return error;
  }
  if (
    error &&
    typeof error === "object" &&
    "error" in error &&
    isConnectorMarketErrorDetails(error.error)
  ) {
    return error.error;
  }
  return null;
}

function isConnectorMarketErrorDetails(
  value: unknown
): value is ConnectorMarketError {
  return (
    value !== null &&
    typeof value === "object" &&
    "code" in value &&
    typeof value.code === "string" &&
    value.code.startsWith("connector_") &&
    "message" in value &&
    typeof value.message === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean" &&
    (!("revision" in value) ||
      value.revision === undefined ||
      (typeof value.revision === "number" &&
        Number.isSafeInteger(value.revision) &&
        value.revision >= 0))
  );
}
