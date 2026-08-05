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
  applyConnectorMarketSnapshot,
  applyConnectorMarketCatalogPage,
  applyConnectorMarketCategories,
  applyConnectorMutationResult,
  clearConnectorMarketStoreState,
  createConnectorMarketStoreState,
  normalizeConnectorMarketError,
  markConnectorMarketSectionError,
  markConnectorMarketSectionLoading,
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
  private eventConnectionUnsubscribe: (() => void) | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private readonly sectionLoads = new Map<string, Promise<void>>();
  private loadInFlight: {
    generation: number;
    promise: Promise<void>;
  } | null = null;
  private authoritativeLoadEpoch = 0;
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
    this.eventConnectionUnsubscribe = this.subscribeToEventConnection(
      this.dependencies.events
    );
    if (this.dependencies.events) {
      this.requestAuthoritativeLoad();
    }
  }

  ensureLoaded(): Promise<void> {
    if (
      this.disposed ||
      !this.canRequest() ||
      this.dataStore.loadState !== "idle"
    ) {
      return Promise.resolve();
    }
    return this.load(true);
  }

  reload(): Promise<void> {
    if (this.disposed || !this.canRequest()) {
      return Promise.resolve();
    }
    return this.load(this.dataStore.loadState === "idle");
  }

  refreshCatalog(): Promise<void> {
    if (this.disposed || !this.canRequest()) {
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

  loadMore(sectionId: string): Promise<void> {
    if (this.disposed || !this.canRequest()) {
      return Promise.resolve();
    }
    const existing = this.sectionLoads.get(sectionId);
    if (existing) {
      return existing;
    }
    const section = this.dataStore.catalogSections.find(
      (candidate) => candidate.categoryId === sectionId
    );
    if (!section || section.loadState === "loading" || !section.nextPageToken) {
      return Promise.resolve();
    }
    const generation = this.workspaceGeneration;
    const promise = this.loadCatalogPage(
      generation,
      sectionId,
      section.nextPageToken
    ).finally(() => {
      if (this.sectionLoads.get(sectionId) === promise) {
        this.sectionLoads.delete(sectionId);
      }
    });
    this.sectionLoads.set(sectionId, promise);
    return promise;
  }

  install(connectorKey: string): Promise<void> {
    const workspaceId = this.dataStore.workspaceId;
    if (!workspaceId) {
      return Promise.reject(
        new Error("A workspace is required to install a connector")
      );
    }
    return this.runConnectorMutation(connectorKey, () =>
      this.dependencies.backend.installConnector({
        connectorKey,
        workspaceId,
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
    if (this.disposed || !this.canRequest()) {
      return;
    }
    const workspaceId = this.dataStore.workspaceId;
    if (!workspaceId) {
      throw new Error("A workspace is required to authorize a connector");
    }
    const token = this.acquireConnectorMutation(connectorKey);
    const generation = this.workspaceGeneration;
    try {
      const result = await this.dependencies.backend.beginAuthorization({
        connectorKey,
        workspaceId,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      });
      if (!this.isCurrentMutation(connectorKey, token, generation)) {
        return;
      }
      applyConnectorMutationResult(this.dataStore, result);
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
    if (this.disposed || !this.canRequest()) {
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
      applyConnectorMutationResult(this.dataStore, result);
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
    this.connectorMutations.clear();
    this.refreshInFlight = null;
    this.sectionLoads.clear();
    resetConnectorMarketWorkspaceState(this.dataStore, workspaceId);
    await this.load(false);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.workspaceGeneration += 1;
    this.connectorMutations.clear();
    this.refreshInFlight = null;
    this.sectionLoads.clear();
    this.eventUnsubscribe?.();
    this.eventUnsubscribe = null;
    this.eventConnectionUnsubscribe?.();
    this.eventConnectionUnsubscribe = null;
    clearConnectorMarketStoreState(this.dataStore);
  }

  private async load(showLoading: boolean): Promise<void> {
    if (!this.canRequest()) {
      return;
    }
    const generation = this.workspaceGeneration;
    const workspaceId = this.dataStore.workspaceId;
    if (this.loadInFlight?.generation === generation) {
      return this.loadInFlight.promise;
    }
    let promise!: Promise<void>;
    promise = this.runLoadLoop(generation, workspaceId, showLoading).finally(
      () => {
        if (this.loadInFlight?.promise === promise) {
          this.loadInFlight = null;
        }
      }
    );
    this.loadInFlight = { generation, promise };
    return promise;
  }

  private async runLoadLoop(
    generation: number,
    workspaceId: string | undefined,
    showLoading: boolean
  ): Promise<void> {
    let firstRequest = true;
    while (this.isCurrent(generation)) {
      const authorityEpoch = this.authoritativeLoadEpoch;
      try {
        await this.loadSnapshot(
          generation,
          workspaceId,
          showLoading && firstRequest
        );
      } catch (error) {
        if (
          !this.isCurrent(generation) ||
          authorityEpoch === this.authoritativeLoadEpoch
        ) {
          throw error;
        }
      }
      firstRequest = false;
      if (
        !this.isCurrent(generation) ||
        authorityEpoch === this.authoritativeLoadEpoch
      ) {
        return;
      }
    }
  }

  private async loadSnapshot(
    generation: number,
    workspaceId: string | undefined,
    showLoading: boolean
  ): Promise<void> {
    if (showLoading && this.dataStore.loadState === "idle") {
      this.dataStore.loadState = "loading";
    }
    try {
      const [next, categories] = await Promise.all([
        this.dependencies.backend.getSnapshot({ workspaceId }),
        this.dependencies.backend.listCategories()
      ]);
      if (!this.isCurrent(generation)) {
        return;
      }
      applyConnectorMarketSnapshot(this.dataStore, next);
      applyConnectorMarketCategories(this.dataStore, categories);
      await Promise.all(
        categories
          .filter((category) => category.itemCount > 0)
          .map((category) =>
            this.loadCatalogPage(generation, category.categoryId)
          )
      );
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.dataStore.loadState = "error";
      this.recordError(error);
      throw error;
    }
  }

  private async loadCatalogPage(
    generation: number,
    sectionId: string,
    pageToken?: string
  ): Promise<void> {
    if (!this.isCurrent(generation)) {
      return;
    }
    markConnectorMarketSectionLoading(this.dataStore, sectionId);
    try {
      const page = await this.dependencies.backend.listCatalogPage({
        sectionId,
        pageSize: 20,
        pageToken,
        workspaceId: this.dataStore.workspaceId
      });
      if (this.isCurrent(generation)) {
        applyConnectorMarketCatalogPage(this.dataStore, page);
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        markConnectorMarketSectionError(this.dataStore, sectionId);
        this.recordError(error);
      }
      throw error;
    }
  }

  private requestAuthoritativeLoad(): void {
    if (this.disposed) {
      return;
    }
    this.authoritativeLoadEpoch += 1;
    void this.load(false).catch(() => undefined);
  }

  private async runConnectorMutation(
    connectorKey: string,
    operation: () => Promise<ConnectorMutationResult>
  ): Promise<void> {
    if (this.disposed || !this.canRequest()) {
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

  private canRequest(): boolean {
    return this.dependencies.canRequest?.() ?? true;
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
        this.requestAuthoritativeLoad();
      }) ?? null
    );
  }

  private subscribeToEventConnection(
    events: ConnectorMarketEventSource | undefined
  ): (() => void) | null {
    return (
      events?.subscribeConnectionState?.((state) => {
        if (this.disposed || state !== "connected") {
          return;
        }
        this.requestAuthoritativeLoad();
      }) ?? null
    );
  }
}
