import type {
  Connector,
  ConnectorMarketCatalogPage,
  ConnectorMarketCategory,
  ConnectorMarketErrorShape,
  ConnectorMarketSnapshot,
  ConnectorMutationResult,
  ConnectorOperation
} from "../contracts/index.ts";
import type { ConnectorMarketStoreState } from "./connectorMarketService.interface.ts";

export function createConnectorMarketStoreState(): ConnectorMarketStoreState {
  return {
    loadState: "idle",
    catalogState: "stale",
    catalogOperation: null,
    catalogSections: [],
    connectorsByKey: {},
    connectorKeys: [],
    pendingInstallationsByConnectorKey: {},
    pendingAuthorizationsByConnectorKey: {},
    pendingUninstallNotificationsByOperationId: {},
    operationsByConnectorKey: {},
    authorizingConnectorKeys: {},
    authorizationViewsByConnectorKey: {},
    lastError: null,
    revision: 0,
    snapshotRevision: 0,
    lastEventCursor: 0
  };
}

export function clearConnectorMarketStoreState(
  state: ConnectorMarketStoreState
): void {
  const initial = createConnectorMarketStoreState();
  state.loadState = initial.loadState;
  state.catalogState = initial.catalogState;
  state.catalogOperation = initial.catalogOperation;
  state.catalogSections = initial.catalogSections;
  state.connectorsByKey = initial.connectorsByKey;
  state.connectorKeys = initial.connectorKeys;
  state.pendingInstallationsByConnectorKey =
    initial.pendingInstallationsByConnectorKey;
  state.pendingAuthorizationsByConnectorKey =
    initial.pendingAuthorizationsByConnectorKey;
  state.pendingUninstallNotificationsByOperationId =
    initial.pendingUninstallNotificationsByOperationId;
  state.operationsByConnectorKey = initial.operationsByConnectorKey;
  state.authorizingConnectorKeys = initial.authorizingConnectorKeys;
  state.authorizationViewsByConnectorKey =
    initial.authorizationViewsByConnectorKey;
  state.lastError = initial.lastError;
  state.revision = initial.revision;
  state.snapshotRevision = initial.snapshotRevision;
  state.lastEventCursor = initial.lastEventCursor;
}

export function applyConnectorMarketCategories(
  state: ConnectorMarketStoreState,
  categories: ConnectorMarketCategory[]
): void {
  state.catalogSections = [...categories]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((category) => ({
      ...category,
      connectorKeys: [],
      loadState: category.itemCount === 0 ? "ready" : "idle"
    }));
}

export function markConnectorMarketSectionLoading(
  state: ConnectorMarketStoreState,
  sectionId: string
): void {
  const section = state.catalogSections.find(
    (candidate) => candidate.categoryId === sectionId
  );
  if (section) {
    section.loadState = "loading";
  }
}

export function markConnectorMarketSectionError(
  state: ConnectorMarketStoreState,
  sectionId: string
): void {
  const section = state.catalogSections.find(
    (candidate) => candidate.categoryId === sectionId
  );
  if (section) {
    section.loadState = "error";
  }
}

export function applyConnectorMarketCatalogPage(
  state: ConnectorMarketStoreState,
  page: ConnectorMarketCatalogPage
): void {
  const section = state.catalogSections.find(
    (candidate) => candidate.categoryId === page.sectionId
  );
  if (!section) {
    return;
  }
  for (const item of page.items) {
    const current = state.connectorsByKey[item.connector.key];
    if (!current || item.connector.revision >= current.revision) {
      applyConnector(state, item.connector);
    }
    if (!section.connectorKeys.includes(item.connector.key)) {
      section.connectorKeys.push(item.connector.key);
    }
  }
  section.nextPageToken = page.nextPageToken;
  section.loadState = "ready";
  state.revision = Math.max(state.revision, page.revision);
}

export function applyConnectorMarketSnapshot(
  state: ConnectorMarketStoreState,
  next: ConnectorMarketSnapshot
): void {
  if (next.revision < state.snapshotRevision) {
    return;
  }
  const nextConnectorKeys = new Set(
    next.connectors.map((connector) => connector.key)
  );
  for (const connector of next.connectors) {
    const current = state.connectorsByKey[connector.key];
    if (!current || connector.revision >= current.revision) {
      state.connectorsByKey[connector.key] = connector;
    }
  }
  for (const connectorKey of Object.keys(state.connectorsByKey)) {
    const current = state.connectorsByKey[connectorKey];
    if (
      !nextConnectorKeys.has(connectorKey) &&
      current &&
      current.revision <= next.revision
    ) {
      delete state.connectorsByKey[connectorKey];
    }
  }
  state.connectorKeys = [
    ...next.connectors.map((connector) => connector.key),
    ...Object.keys(state.connectorsByKey).filter(
      (connectorKey) => !nextConnectorKeys.has(connectorKey)
    )
  ];
  const snapshotOperationsByConnectorKey: Record<string, ConnectorOperation> =
    {};
  let snapshotCatalogOperation: ConnectorOperation | null = null;
  for (const operation of next.operations) {
    if (operation.connectorKey) {
      const current = snapshotOperationsByConnectorKey[operation.connectorKey];
      if (!current || isNewerConnectorOperation(operation, current)) {
        snapshotOperationsByConnectorKey[operation.connectorKey] = operation;
      }
    } else if (
      operation.kind === "refresh_catalog" &&
      (!snapshotCatalogOperation ||
        isNewerConnectorOperation(operation, snapshotCatalogOperation))
    ) {
      snapshotCatalogOperation = operation;
    }
  }
  for (const [connectorKey, current] of Object.entries(
    state.operationsByConnectorKey
  )) {
    const fromSnapshot = snapshotOperationsByConnectorKey[connectorKey];
    if (
      (!fromSnapshot || isNewerConnectorOperation(current, fromSnapshot)) &&
      (state.connectorsByKey[connectorKey]?.revision ?? 0) > next.revision
    ) {
      snapshotOperationsByConnectorKey[connectorKey] = current;
    }
  }
  state.operationsByConnectorKey = snapshotOperationsByConnectorKey;
  if (
    state.catalogOperation &&
    (!snapshotCatalogOperation ||
      isNewerConnectorOperation(
        state.catalogOperation,
        snapshotCatalogOperation
      )) &&
    state.revision > next.revision
  ) {
    snapshotCatalogOperation = state.catalogOperation;
  }
  state.catalogOperation = snapshotCatalogOperation;
  state.catalogState = next.catalogState;
  state.revision = Math.max(state.revision, next.revision);
  state.snapshotRevision = next.revision;
  state.lastEventCursor = Math.max(
    state.lastEventCursor,
    next.eventCursor ?? 0
  );
  state.loadState = "ready";
  state.lastError = null;
}

export function applyConnectorMutationResult(
  state: ConnectorMarketStoreState,
  result: ConnectorMutationResult
): void {
  if (result.connector) {
    const current = state.connectorsByKey[result.connector.key];
    if (!current || result.connector.revision >= current.revision) {
      applyConnector(state, result.connector);
    }
  }
  if (result.operation.connectorKey) {
    const current =
      state.operationsByConnectorKey[result.operation.connectorKey];
    if (!current || isNewerConnectorOperation(result.operation, current)) {
      state.operationsByConnectorKey[result.operation.connectorKey] =
        result.operation;
    }
  } else if (result.operation.kind === "refresh_catalog") {
    if (
      !state.catalogOperation ||
      isNewerConnectorOperation(result.operation, state.catalogOperation)
    ) {
      state.catalogOperation = result.operation;
    }
  }
  state.revision = Math.max(state.revision, result.revision);
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
    message: error instanceof Error ? error.message : String(error),
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
