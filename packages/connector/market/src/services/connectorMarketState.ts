import type {
  Connector,
  ConnectorMarketErrorShape,
  ConnectorMarketSnapshot,
  ConnectorMutationResult,
  ConnectorOperation
} from "../contracts/index.ts";
import type { ConnectorMarketStoreState } from "./connectorMarketService.interface.ts";

export function createConnectorMarketStoreState(
  workspaceId?: string
): ConnectorMarketStoreState {
  return {
    loadState: "idle",
    catalogState: "stale",
    catalogOperation: null,
    connectorsByKey: {},
    connectorKeys: [],
    operationsByConnectorKey: {},
    lastError: null,
    revision: 0,
    workspaceId
  };
}

export function resetConnectorMarketWorkspaceState(
  state: ConnectorMarketStoreState,
  workspaceId?: string
): void {
  state.workspaceId = workspaceId;
  state.loadState = "loading";
  state.connectorsByKey = {};
  state.connectorKeys = [];
  state.operationsByConnectorKey = {};
  state.catalogOperation = null;
  state.lastError = null;
}

export function clearConnectorMarketStoreState(
  state: ConnectorMarketStoreState
): void {
  const initial = createConnectorMarketStoreState();
  state.loadState = initial.loadState;
  state.catalogState = initial.catalogState;
  state.catalogOperation = initial.catalogOperation;
  state.connectorsByKey = initial.connectorsByKey;
  state.connectorKeys = initial.connectorKeys;
  state.operationsByConnectorKey = initial.operationsByConnectorKey;
  state.lastError = initial.lastError;
  state.revision = initial.revision;
  state.workspaceId = initial.workspaceId;
}

export function applyConnectorMarketSnapshot(
  state: ConnectorMarketStoreState,
  next: ConnectorMarketSnapshot
): void {
  if (next.revision < state.revision) {
    return;
  }
  state.connectorsByKey = Object.fromEntries(
    next.connectors.map((connector) => [connector.key, connector])
  );
  state.connectorKeys = next.connectors.map((connector) => connector.key);
  state.operationsByConnectorKey = {};
  state.catalogOperation = null;
  for (const operation of next.operations) {
    if (operation.connectorKey) {
      const current = state.operationsByConnectorKey[operation.connectorKey];
      if (!current || isNewerConnectorOperation(operation, current)) {
        state.operationsByConnectorKey[operation.connectorKey] = operation;
      }
    } else if (
      operation.kind === "refresh_catalog" &&
      (!state.catalogOperation ||
        isNewerConnectorOperation(operation, state.catalogOperation))
    ) {
      state.catalogOperation = operation;
    }
  }
  state.catalogState = next.catalogState;
  state.revision = next.revision;
  state.loadState = "ready";
  state.lastError = null;
}

export function applyConnectorMutationResult(
  state: ConnectorMarketStoreState,
  result: ConnectorMutationResult
): void {
  if (result.revision < state.revision) {
    return;
  }
  if (result.connector) {
    applyConnector(state, result.connector);
  }
  if (result.operation.connectorKey) {
    state.operationsByConnectorKey[result.operation.connectorKey] =
      result.operation;
  } else if (result.operation.kind === "refresh_catalog") {
    state.catalogOperation = result.operation;
  }
  state.revision = result.revision;
  state.lastError = null;
}

export function applyConnector(
  state: ConnectorMarketStoreState,
  connector: Connector
): void {
  state.connectorsByKey[connector.key] = connector;
  if (!state.connectorKeys.includes(connector.key)) {
    state.connectorKeys.push(connector.key);
  }
}

export function normalizeConnectorMarketError(
  error: unknown
): ConnectorMarketErrorShape {
  if (isConnectorMarketError(error)) {
    return error;
  }
  return {
    code: "connector_market_unknown",
    message:
      error instanceof Error ? error.message : "Unknown connector market error",
    retryable: false
  };
}

function isNewerConnectorOperation(
  candidate: ConnectorOperation,
  current: ConnectorOperation
): boolean {
  return candidate.updatedAt.localeCompare(current.updatedAt) > 0;
}

function isConnectorMarketError(
  error: unknown
): error is ConnectorMarketErrorShape {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as Partial<ConnectorMarketErrorShape>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}
