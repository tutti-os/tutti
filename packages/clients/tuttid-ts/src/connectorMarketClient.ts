import {
  cancelConnectorMarketAuthorization,
  disconnectConnectorMarketAuthorization,
  getConnectorMarket,
  getConnectorMarketConnector,
  getConnectorMarketOperation,
  installConnectorMarketConnector,
  listConnectorMarketCatalog,
  listConnectorMarketCategories,
  refreshConnectorMarket,
  startConnectorMarketAuthorization,
  updateConnectorMarketConnectorRuntime,
  uninstallConnectorMarketConnector
} from "./generated/index.ts";
import type {
  ConnectorMarketAuthorizationResponse,
  ConnectorMarketAuthorizationRequestWritable,
  ConnectorMarketCatalogPage,
  ConnectorMarketCategoriesResponse,
  ConnectorMarketConnector,
  ConnectorMarketError,
  ConnectorMarketMutationRequest,
  ConnectorMarketMutationResponse,
  ConnectorMarketOperation,
  ConnectorMarketRuntimeMutationRequest,
  ConnectorMarketSnapshot
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
  getConnectorMarket(): Promise<ConnectorMarketSnapshot>;
  listConnectorMarketCategories(): Promise<ConnectorMarketCategoriesResponse>;
  listConnectorMarketCatalog(input: {
    installation?: "not_installed";
    sectionId: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ConnectorMarketCatalogPage>;
  getConnectorMarketConnector(
    connectorKey: string
  ): Promise<ConnectorMarketConnector>;
  getConnectorMarketOperation(
    operationId: string
  ): Promise<ConnectorMarketOperation>;
  refreshConnectorMarket(
    request: ConnectorMarketMutationRequest
  ): Promise<ConnectorMarketMutationResponse>;
  installConnectorMarketConnector(
    connectorKey: string,
    request: ConnectorMarketMutationRequest
  ): Promise<ConnectorMarketMutationResponse>;
  uninstallConnectorMarketConnector(
    connectorKey: string,
    request: ConnectorMarketMutationRequest
  ): Promise<ConnectorMarketMutationResponse>;
  updateConnectorMarketConnectorRuntime(
    connectorKey: string,
    request: ConnectorMarketRuntimeMutationRequest
  ): Promise<ConnectorMarketConnector>;
  startConnectorMarketAuthorization(
    connectorKey: string,
    request: ConnectorMarketAuthorizationRequestWritable
  ): Promise<ConnectorMarketAuthorizationResponse>;
  cancelConnectorMarketAuthorization(connectorKey: string): Promise<void>;
  disconnectConnectorMarketAuthorization(
    connectorKey: string,
    request: ConnectorMarketMutationRequest
  ): Promise<ConnectorMarketMutationResponse>;
}

export function createConnectorMarketClient(
  client: Client
): ConnectorMarketClient {
  return {
    async getConnectorMarket() {
      return unwrapConnectorMarketData(
        await getConnectorMarket({ client }),
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
    async getConnectorMarketConnector(connectorKey) {
      return unwrapConnectorMarketData(
        await getConnectorMarketConnector({
          client,
          path: { connectorKey }
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
    async updateConnectorMarketConnectorRuntime(connectorKey, request) {
      return unwrapConnectorMarketData(
        await updateConnectorMarketConnectorRuntime({
          client,
          body: request,
          path: { connectorKey }
        }),
        "Update connector runtime request failed."
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
    async cancelConnectorMarketAuthorization(connectorKey) {
      const response = await cancelConnectorMarketAuthorization({
        client,
        path: { connectorKey }
      });
      const details = connectorMarketErrorDetails(response.error);
      if (details) {
        throw new ConnectorMarketClientError(
          details,
          response.response?.status ?? 0
        );
      }
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
