import { proxy } from "valtio/vanilla";

import type {
  ConnectorMarketEventSource,
  ConnectorMutationResult
} from "../contracts/index.ts";
import type {
  ConnectorMarketServiceDependencies,
  ConnectorMarketStoreState,
  IConnectorMarketService
} from "./connectorMarketService.interface.ts";
import {
  applyConnector,
  applyConnectorMarketSnapshot,
  applyConnectorMutationResult,
  clearConnectorMarketStoreState,
  createConnectorMarketStoreState,
  normalizeConnectorMarketError,
  resetConnectorMarketWorkspaceState
} from "./connectorMarketState.ts";

export class ConnectorMarketBusyError extends Error {
  readonly code = "connector_operation_in_progress";

  constructor(readonly connectorKey: string) {
    super(`A connector operation is already in progress for ${connectorKey}`);
    this.name = "ConnectorMarketBusyError";
  }
}

/**
 * Owns connector-market renderer state and behavior. HTTP clients and desktop
 * capabilities are host adapters supplied through the constructor.
 */
export class ConnectorMarketService implements IConnectorMarketService {
  declare readonly _serviceBrand: undefined;
  readonly dataStore: ConnectorMarketStoreState;

  private readonly createRequestId: () => string;
  private readonly reportDiagnostic: (error: unknown) => void;
  private readonly connectorMutations = new Map<string, symbol>();
  private eventUnsubscribe: (() => void) | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private loadSequence = 0;
  private workspaceGeneration = 0;
  private started = false;
  private disposed = false;

  constructor(
    private readonly dependencies: ConnectorMarketServiceDependencies
  ) {
    this.dataStore = proxy<ConnectorMarketStoreState>(
      createConnectorMarketStoreState(dependencies.workspaceId)
    );
    this.createRequestId =
      dependencies.createRequestId ?? (() => crypto.randomUUID());
    this.reportDiagnostic = dependencies.reportDiagnostic ?? (() => undefined);
  }

  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.eventUnsubscribe = this.subscribeToEvents(this.dependencies.events);
  }

  ensureLoaded(): Promise<void> {
    if (this.disposed || this.dataStore.loadState !== "idle") {
      return Promise.resolve();
    }
    return this.load(true);
  }

  reload(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    return this.load(this.dataStore.loadState === "idle");
  }

  refreshCatalog(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    const generation = this.workspaceGeneration;
    this.dataStore.catalogState = "refreshing";
    const promise = this.dependencies.backend
      .refreshCatalog({
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      })
      .then((result) => {
        if (this.isCurrent(generation)) {
          applyConnectorMutationResult(this.dataStore, result);
        }
      })
      .catch((error) => {
        if (this.isCurrent(generation)) {
          this.dataStore.catalogState = "failed";
          this.recordError(error);
        }
        throw error;
      })
      .finally(() => {
        if (this.refreshInFlight === promise) {
          this.refreshInFlight = null;
        }
      });
    this.refreshInFlight = promise;
    return promise;
  }

  install(connectorKey: string): Promise<void> {
    return this.runConnectorMutation(connectorKey, () =>
      this.dependencies.backend.installConnector({
        connectorKey,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      })
    );
  }

  uninstall(connectorKey: string): Promise<void> {
    return this.runConnectorMutation(connectorKey, () =>
      this.dependencies.backend.uninstallConnector({
        connectorKey,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      })
    );
  }

  async beginAuthorization(connectorKey: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const token = this.acquireConnectorMutation(connectorKey);
    const generation = this.workspaceGeneration;
    try {
      const result = await this.dependencies.backend.beginAuthorization({
        connectorKey,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      });
      if (!this.isCurrentMutation(connectorKey, token, generation)) {
        return;
      }
      applyConnector(this.dataStore, result.connector);
      this.dataStore.operationsByConnectorKey[connectorKey] = result.operation;
      this.dataStore.revision = Math.max(
        this.dataStore.revision,
        result.revision
      );
      this.dataStore.lastError = null;
      if (result.authorizationUrl && this.dependencies.openAuthorizationUrl) {
        await this.dependencies.openAuthorizationUrl(result.authorizationUrl);
      }
    } catch (error) {
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        this.recordError(error);
      }
      throw error;
    } finally {
      this.releaseConnectorMutation(connectorKey, token);
    }
  }

  disconnectAuthorization(connectorKey: string): Promise<void> {
    return this.runConnectorMutation(connectorKey, () =>
      this.dependencies.backend.disconnectAuthorization({
        connectorKey,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      })
    );
  }

  async setWorkspaceEnabled(
    connectorKey: string,
    enabled: boolean
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    const workspaceId = this.dataStore.workspaceId;
    if (!workspaceId) {
      throw new Error("A workspace is required to change connector enablement");
    }
    const token = this.acquireConnectorMutation(connectorKey);
    const generation = this.workspaceGeneration;
    const connector = this.dataStore.connectorsByKey[connectorKey];
    const previous = connector?.workspaceBinding;
    if (connector) {
      connector.workspaceBinding = { workspaceId, enabled };
    }
    try {
      const result = await this.dependencies.backend.setWorkspaceEnabled({
        connectorKey,
        workspaceId,
        enabled,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      });
      if (!this.isCurrentMutation(connectorKey, token, generation)) {
        return;
      }
      applyConnector(this.dataStore, result.connector);
      this.dataStore.operationsByConnectorKey[connectorKey] = result.operation;
      this.dataStore.revision = Math.max(
        this.dataStore.revision,
        result.revision
      );
      this.dataStore.lastError = null;
    } catch (error) {
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        if (connector) {
          connector.workspaceBinding = previous;
        }
        this.recordError(error);
      }
      throw error;
    } finally {
      this.releaseConnectorMutation(connectorKey, token);
    }
  }

  async setWorkspace(workspaceId?: string): Promise<void> {
    if (this.disposed || this.dataStore.workspaceId === workspaceId) {
      return;
    }
    this.workspaceGeneration += 1;
    this.loadSequence += 1;
    this.connectorMutations.clear();
    this.refreshInFlight = null;
    resetConnectorMarketWorkspaceState(this.dataStore, workspaceId);
    await this.load(false);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.workspaceGeneration += 1;
    this.loadSequence += 1;
    this.connectorMutations.clear();
    this.refreshInFlight = null;
    this.eventUnsubscribe?.();
    this.eventUnsubscribe = null;
    clearConnectorMarketStoreState(this.dataStore);
  }

  private async load(showLoading: boolean): Promise<void> {
    const sequence = ++this.loadSequence;
    const generation = this.workspaceGeneration;
    const workspaceId = this.dataStore.workspaceId;
    if (showLoading && this.dataStore.loadState === "idle") {
      this.dataStore.loadState = "loading";
    }
    try {
      const next = await this.dependencies.backend.getSnapshot({ workspaceId });
      if (!this.isCurrent(generation) || sequence !== this.loadSequence) {
        return;
      }
      applyConnectorMarketSnapshot(this.dataStore, next);
    } catch (error) {
      if (!this.isCurrent(generation) || sequence !== this.loadSequence) {
        return;
      }
      this.dataStore.loadState = "error";
      this.recordError(error);
      throw error;
    }
  }

  private async runConnectorMutation(
    connectorKey: string,
    operation: () => Promise<ConnectorMutationResult>
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    const token = this.acquireConnectorMutation(connectorKey);
    const generation = this.workspaceGeneration;
    try {
      const result = await operation();
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        applyConnectorMutationResult(this.dataStore, result);
      }
    } catch (error) {
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        this.recordError(error);
      }
      throw error;
    } finally {
      this.releaseConnectorMutation(connectorKey, token);
    }
  }

  private acquireConnectorMutation(connectorKey: string): symbol {
    if (this.connectorMutations.has(connectorKey)) {
      throw new ConnectorMarketBusyError(connectorKey);
    }
    const token = Symbol(connectorKey);
    this.connectorMutations.set(connectorKey, token);
    return token;
  }

  private releaseConnectorMutation(connectorKey: string, token: symbol): void {
    if (this.connectorMutations.get(connectorKey) === token) {
      this.connectorMutations.delete(connectorKey);
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.workspaceGeneration;
  }

  private isCurrentMutation(
    connectorKey: string,
    token: symbol,
    generation: number
  ): boolean {
    return (
      this.isCurrent(generation) &&
      this.connectorMutations.get(connectorKey) === token
    );
  }

  private recordError(error: unknown): void {
    this.dataStore.lastError = normalizeConnectorMarketError(error);
    this.reportDiagnostic(error);
  }

  private subscribeToEvents(
    events: ConnectorMarketEventSource | undefined
  ): (() => void) | null {
    return (
      events?.subscribe((event) => {
        if (this.disposed || event.revision <= this.dataStore.revision) {
          return;
        }
        void this.load(false).catch(() => undefined);
      }) ?? null
    );
  }
}
