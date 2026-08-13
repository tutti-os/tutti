import { proxy } from "valtio/vanilla";

import type {
  ConnectorAuthorizationResult,
  ConnectorMarketChangedEvent,
  ConnectorMarketEventSource,
  ConnectorMutationResult,
  ConnectorOperation
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
  applyConnector,
  clearConnectorMarketStoreState,
  createConnectorMarketStoreState,
  normalizeConnectorMarketError,
  markConnectorMarketSectionError,
  markConnectorMarketSectionLoading
} from "./connectorMarketState.ts";

export class ConnectorMarketBusyError extends Error {
  readonly code = "connector_operation_in_progress";

  constructor(readonly connectorKey: string) {
    super(`A connector operation is already in progress for ${connectorKey}`);
    this.name = "ConnectorMarketBusyError";
  }
}

export class ConnectorMarketRequestUnavailableError extends Error {
  readonly code = "connector_market_unavailable";
  readonly retryable = true;

  constructor() {
    super("Connector market requests are not currently available");
    this.name = "ConnectorMarketRequestUnavailableError";
  }
}

const authorizationContinuationPollMs = 1_000;

function waitForAuthorizationContinuation(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, authorizationContinuationPollMs);
  });
}

/**
 * Owns connector-market UI state and behavior. HTTP clients and desktop
 * capabilities are host adapters supplied through the constructor.
 */
export class ConnectorMarketService implements IConnectorMarketService {
  declare readonly _serviceBrand: undefined;
  readonly dataStore: ConnectorMarketStoreState;

  private readonly createRequestId: () => string;
  private readonly reportDiagnostic: (error: unknown) => void;
  private readonly connectorMutations = new Map<string, symbol>();
  private readonly pendingConnectorEvents = new Map<
    string,
    ConnectorMarketChangedEvent
  >();
  private readonly connectorEventLoads = new Map<string, Promise<void>>();
  private readonly operationTracks = new Map<string, Promise<void>>();
  private readonly operationTrackerAbort = new AbortController();
  private eventUnsubscribe: (() => void) | null = null;
  private eventConnectionUnsubscribe: (() => void) | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private readonly sectionLoads = new Map<string, Promise<void>>();
  private loadInFlight: {
    generation: number;
    promise: Promise<void>;
  } | null = null;
  private authoritativeLoadEpoch = 0;
  private dataGeneration = 0;
  private started = false;
  private disposed = false;

  constructor(
    private readonly dependencies: ConnectorMarketServiceDependencies
  ) {
    this.dataStore = proxy<ConnectorMarketStoreState>(
      createConnectorMarketStoreState()
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
    const generation = this.dataGeneration;
    this.dataStore.catalogState = "refreshing";
    const promise = this.dependencies.backend
      .refreshCatalog({
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      })
      .then((result) => {
        if (this.isCurrent(generation)) {
          applyConnectorMutationResult(this.dataStore, result);
          this.trackOperation(result.operation);
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
    if (
      !section ||
      section.loadState === "loading" ||
      (section.loadState !== "error" && !section.nextPageToken)
    ) {
      return Promise.resolve();
    }
    const generation = this.dataGeneration;
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
    return this.runConnectorMutation(
      connectorKey,
      () =>
        this.dependencies.backend.installConnector({
          connectorKey,
          clientRequestId: this.createRequestId(),
          expectedRevision: this.dataStore.revision
        }),
      true
    );
  }

  async uninstall(connectorKey: string): Promise<ConnectorOperation> {
    if (this.disposed || !this.canRequest()) {
      throw new ConnectorMarketRequestUnavailableError();
    }
    const result = await this.runConnectorMutationResult(connectorKey, () =>
      this.dependencies.backend.uninstallConnector({
        connectorKey,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision
      })
    );
    if (!result) {
      throw new ConnectorMarketRequestUnavailableError();
    }
    const connector = this.dataStore.connectorsByKey[connectorKey];
    const projectedOperation =
      this.dataStore.operationsByConnectorKey[connectorKey];
    this.dataStore.pendingUninstallNotificationsByOperationId[
      result.operation.operationId
    ] = {
      connectorKey,
      displayName:
        connector?.release.manifest.displayName ??
        result.operation.connectorKey ??
        connectorKey,
      operationId: result.operation.operationId,
      state:
        projectedOperation?.operationId === result.operation.operationId
          ? projectedOperation.state
          : result.operation.state
    };
    return result.operation;
  }

  dismissUninstallNotification(operationId: string): void {
    if (!this.disposed) {
      delete this.dataStore.pendingUninstallNotificationsByOperationId[
        operationId
      ];
    }
  }

  async beginAuthorization(
    connectorKey: string,
    secret?: string
  ): Promise<void> {
    if (this.disposed || !this.canRequest()) {
      return;
    }
    const token = this.acquireConnectorMutation(connectorKey);
    this.dataStore.authorizingConnectorKeys[connectorKey] = true;
    const generation = this.dataGeneration;
    const request = {
      connectorKey,
      clientRequestId: this.createRequestId(),
      ...(secret ? { secret } : {})
    };
    let expectedRevision = this.dataStore.revision;
    const openedAuthorizationUrls = new Set<string>();
    let recoveredRevisionConflict = false;
    try {
      while (this.isCurrentMutation(connectorKey, token, generation)) {
        let result: ConnectorAuthorizationResult;
        try {
          result = await this.dependencies.backend.beginAuthorization({
            ...request,
            expectedRevision
          });
        } catch (error) {
          if (
            recoveredRevisionConflict ||
            normalizeConnectorMarketError(error).code !==
              "connector_market_revision_conflict" ||
            !this.isCurrentMutation(connectorKey, token, generation)
          ) {
            throw error;
          }
          recoveredRevisionConflict = true;
          const next = await this.dependencies.backend.getSnapshot();
          if (!this.isCurrentMutation(connectorKey, token, generation)) {
            return;
          }
          applyConnectorMarketSnapshot(this.dataStore, next);
          this.reconcileUninstallNotificationStates(next.operations);
          expectedRevision = this.dataStore.revision;
          continue;
        }
        if (!this.isCurrentMutation(connectorKey, token, generation)) {
          return;
        }
        applyConnectorMutationResult(this.dataStore, result);
        this.trackOperation(result.operation);
        const authorizationUrl = result.authorizationUrl;
        const discoveredNextStep =
          authorizationUrl !== undefined &&
          !openedAuthorizationUrls.has(authorizationUrl);
        if (discoveredNextStep && authorizationUrl) {
          openedAuthorizationUrls.add(authorizationUrl);
          if (this.dependencies.openAuthorizationUrl) {
            await this.dependencies.openAuthorizationUrl(authorizationUrl);
          }
        }
        if (
          this.dataStore.connectorsByKey[connectorKey]?.authorization.state !==
          "pending"
        ) {
          return;
        }
        if (!discoveredNextStep) {
          await waitForAuthorizationContinuation();
        }
      }
    } catch (error) {
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        this.recordError(error);
      }
      throw error;
    } finally {
      if (this.connectorMutations.get(connectorKey) === token) {
        delete this.dataStore.authorizingConnectorKeys[connectorKey];
      }
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dataGeneration += 1;
    this.connectorMutations.clear();
    this.pendingConnectorEvents.clear();
    this.connectorEventLoads.clear();
    this.operationTrackerAbort.abort();
    this.operationTracks.clear();
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
    const generation = this.dataGeneration;
    if (this.loadInFlight?.generation === generation) {
      return this.loadInFlight.promise;
    }
    let promise!: Promise<void>;
    promise = this.runLoadLoop(generation, showLoading).finally(() => {
      if (this.loadInFlight?.promise === promise) {
        this.loadInFlight = null;
      }
    });
    this.loadInFlight = { generation, promise };
    return promise;
  }

  private async runLoadLoop(
    generation: number,
    showLoading: boolean
  ): Promise<void> {
    let firstRequest = true;
    while (this.isCurrent(generation)) {
      const authorityEpoch = this.authoritativeLoadEpoch;
      try {
        await this.loadSnapshot(generation, showLoading && firstRequest);
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
    showLoading: boolean
  ): Promise<void> {
    if (showLoading && this.dataStore.loadState === "idle") {
      this.dataStore.loadState = "loading";
    }
    try {
      const [next, categories] = await Promise.all([
        this.dependencies.backend.getSnapshot(),
        this.dependencies.backend.listCategories()
      ]);
      const requestedCategories = categories.filter(
        (category) => category.itemCount > 0
      );
      const pageResults = await Promise.allSettled(
        requestedCategories.map((category) =>
          this.dependencies.backend.listCatalogPage({
            sectionId: category.categoryId,
            pageSize: 20
          })
        )
      );
      if (!this.isCurrent(generation)) {
        return;
      }
      // Background reconciliation must not replace visible catalog data with
      // transient empty/loading sections. Fetch the complete first page set,
      // then publish one authoritative state transition.
      if (next.revision < this.dataStore.revision) {
        return;
      }
      const previousSections = new Map(
        this.dataStore.catalogSections.map((section) => [
          section.categoryId,
          {
            connectorKeys: [...section.connectorKeys],
            nextPageToken: section.nextPageToken
          }
        ])
      );
      const previousConnectors = { ...this.dataStore.connectorsByKey };
      const hadVisibleCatalog = [...previousSections.values()].some(
        (section) => section.connectorKeys.length > 0
      );

      applyConnectorMarketSnapshot(this.dataStore, next);
      this.reconcileUninstallNotificationStates(next.operations);
      applyConnectorMarketCategories(this.dataStore, categories);
      let failedPages = 0;
      let firstPageError: unknown;
      const pageErrors: unknown[] = [];
      for (const [index, result] of pageResults.entries()) {
        const category = requestedCategories[index];
        if (!category) {
          continue;
        }
        if (result.status === "fulfilled") {
          applyConnectorMarketCatalogPage(this.dataStore, result.value);
          continue;
        }
        failedPages += 1;
        firstPageError ??= result.reason;
        pageErrors.push(result.reason);
        const previous = previousSections.get(category.categoryId);
        if (previous) {
          for (const connectorKey of previous.connectorKeys) {
            const connector = previousConnectors[connectorKey];
            if (connector) {
              applyConnector(this.dataStore, connector);
            }
          }
          const section = this.dataStore.catalogSections.find(
            (candidate) => candidate.categoryId === category.categoryId
          );
          if (section) {
            section.connectorKeys = previous.connectorKeys;
            section.nextPageToken = previous.nextPageToken;
          }
        }
        markConnectorMarketSectionError(this.dataStore, category.categoryId);
      }
      if (
        requestedCategories.length > 0 &&
        failedPages === requestedCategories.length &&
        !hadVisibleCatalog
      ) {
        throw (
          firstPageError ?? new Error("all connector catalog sections failed")
        );
      }
      for (const pageError of pageErrors) {
        this.reportDiagnostic(pageError);
      }
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
      if (
        showLoading ||
        this.dataStore.loadState === "idle" ||
        this.dataStore.loadState === "loading"
      ) {
        this.dataStore.loadState = "error";
      }
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
        pageToken
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

  private requestConnectorEventLoad(event: ConnectorMarketChangedEvent): void {
    const connectorKey = event.connectorKey;
    if (!connectorKey || this.disposed) {
      return;
    }
    // If a full snapshot is already being assembled, make it take one more
    // pass after this connector-scoped revision instead of publishing an older
    // snapshot over the targeted result.
    this.authoritativeLoadEpoch += 1;
    const pending = this.pendingConnectorEvents.get(connectorKey);
    if (!pending || event.revision > pending.revision) {
      this.pendingConnectorEvents.set(connectorKey, event);
    }
    if (this.connectorEventLoads.has(connectorKey)) {
      return;
    }
    let promise!: Promise<void>;
    promise = this.runConnectorEventLoadLoop(connectorKey).finally(() => {
      if (this.connectorEventLoads.get(connectorKey) === promise) {
        this.connectorEventLoads.delete(connectorKey);
      }
    });
    this.connectorEventLoads.set(connectorKey, promise);
  }

  private async runConnectorEventLoadLoop(connectorKey: string): Promise<void> {
    while (!this.disposed) {
      const event = this.pendingConnectorEvents.get(connectorKey);
      if (!event) {
        return;
      }
      this.pendingConnectorEvents.delete(connectorKey);
      try {
        await this.loadConnectorEvent(event);
      } catch (error) {
        if (!this.disposed) {
          this.recordError(error);
        }
      }
    }
  }

  private async loadConnectorEvent(
    event: ConnectorMarketChangedEvent
  ): Promise<void> {
    const connectorKey = event.connectorKey;
    if (!connectorKey) {
      return;
    }
    const generation = this.dataGeneration;
    const [connector, operation] = await Promise.all([
      this.dependencies.backend.getConnector({ connectorKey }),
      event.operationId
        ? this.dependencies.backend.getOperation({
            operationId: event.operationId
          })
        : Promise.resolve(null)
    ]);
    if (
      !this.isCurrent(generation) ||
      event.revision <= this.dataStore.revision
    ) {
      return;
    }
    const current = this.dataStore.connectorsByKey[connectorKey];
    if (!current || connector.revision >= current.revision) {
      applyConnector(this.dataStore, connector);
    }
    if (operation?.connectorKey === connectorKey) {
      this.applyTrackedOperation(operation);
      this.trackOperation(operation);
    }
    this.dataStore.revision = event.revision;
    this.dataStore.lastError = null;
  }

  private async runConnectorMutation(
    connectorKey: string,
    operation: () => Promise<ConnectorMutationResult>,
    projectPendingInstallation = false
  ): Promise<void> {
    await this.runConnectorMutationResult(
      connectorKey,
      operation,
      projectPendingInstallation
    );
  }

  private async runConnectorMutationResult(
    connectorKey: string,
    operation: () => Promise<ConnectorMutationResult>,
    projectPendingInstallation = false
  ): Promise<ConnectorMutationResult | undefined> {
    if (this.disposed || !this.canRequest()) {
      return;
    }
    const token = this.acquireConnectorMutation(connectorKey);
    const generation = this.dataGeneration;
    if (projectPendingInstallation) {
      this.dataStore.pendingInstallationsByConnectorKey[connectorKey] = true;
    }
    try {
      let result: ConnectorMutationResult;
      try {
        result = await operation();
      } catch (error) {
        if (
          normalizeConnectorMarketError(error).code !==
            "connector_market_revision_conflict" ||
          !this.isCurrentMutation(connectorKey, token, generation)
        ) {
          throw error;
        }
        const next = await this.dependencies.backend.getSnapshot();
        if (!this.isCurrentMutation(connectorKey, token, generation)) {
          return;
        }
        applyConnectorMarketSnapshot(this.dataStore, next);
        this.reconcileUninstallNotificationStates(next.operations);
        result = await operation();
      }
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        applyConnectorMutationResult(this.dataStore, result);
        this.trackOperation(result.operation);
        return result;
      }
      return;
    } catch (error) {
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        this.recordError(error);
      }
      throw error;
    } finally {
      if (
        projectPendingInstallation &&
        this.connectorMutations.get(connectorKey) === token
      ) {
        delete this.dataStore.pendingInstallationsByConnectorKey[connectorKey];
      }
      this.releaseConnectorMutation(connectorKey, token);
    }
  }

  private trackOperation(operation: ConnectorOperation): void {
    if (
      this.disposed ||
      operation.state === "completed" ||
      operation.state === "failed" ||
      this.operationTracks.has(operation.operationId)
    ) {
      return;
    }
    const generation = this.dataGeneration;
    let promise!: Promise<void>;
    promise = this.runOperationTrack(operation, generation)
      .catch((error) => {
        if (
          this.isCurrent(generation) &&
          !this.operationTrackerAbort.signal.aborted
        ) {
          this.recordError(error);
        }
      })
      .finally(() => {
        if (this.operationTracks.get(operation.operationId) === promise) {
          this.operationTracks.delete(operation.operationId);
        }
      });
    this.operationTracks.set(operation.operationId, promise);
  }

  private async runOperationTrack(
    accepted: ConnectorOperation,
    generation: number
  ): Promise<void> {
    let attempt = 0;
    while (
      this.isCurrent(generation) &&
      !this.operationTrackerAbort.signal.aborted
    ) {
      let operation: ConnectorOperation;
      try {
        operation = await this.dependencies.backend.getOperation({
          operationId: accepted.operationId
        });
      } catch (error) {
        if (this.isRetryableOperationError(error)) {
          // Event delivery and operation reads are independent recovery paths.
          // A transient read failure must not abandon terminal convergence.
          this.reportDiagnostic(error);
          await this.waitForOperationPoll(attempt);
          attempt += 1;
          continue;
        }
        const permanentError = normalizeConnectorMarketError(error);
        this.recordError(permanentError);
        try {
          // The accepted mutation can still have completed even when operation
          // reads are permanently forbidden or missing. Reconcile once from
          // the daemon's authoritative local projection, then stop tracking.
          await this.reconcileTerminalOperation(accepted, generation);
          if (this.isCurrent(generation)) {
            this.dataStore.lastError = permanentError;
          }
        } catch (reconcileError) {
          this.reportDiagnostic(reconcileError);
        }
        return;
      }
      if (!this.isCurrent(generation)) {
        return;
      }
      this.applyTrackedOperation(operation);
      if (operation.state === "completed" || operation.state === "failed") {
        try {
          await this.reconcileTerminalOperation(operation, generation);
          return;
        } catch (error) {
          if (this.isRetryableOperationError(error)) {
            // Reading the terminal operation and reading its authoritative
            // local projection are separate calls. Keep the tracker alive only
            // while that projection is transiently unavailable.
            this.reportDiagnostic(error);
            await this.waitForOperationPoll(attempt);
            attempt += 1;
            continue;
          }
          this.recordError(error);
          return;
        }
      }
      await this.waitForOperationPoll(attempt);
      attempt += 1;
    }
  }

  private applyTrackedOperation(operation: ConnectorOperation): void {
    if (operation.connectorKey) {
      this.dataStore.operationsByConnectorKey[operation.connectorKey] =
        operation;
    } else if (operation.kind === "refresh_catalog") {
      this.dataStore.catalogOperation = operation;
    }
    const notification =
      this.dataStore.pendingUninstallNotificationsByOperationId[
        operation.operationId
      ];
    if (notification) {
      notification.state = operation.state;
    }
  }

  private reconcileUninstallNotificationStates(
    operations: ConnectorOperation[]
  ): void {
    for (const operation of operations) {
      const notification =
        this.dataStore.pendingUninstallNotificationsByOperationId[
          operation.operationId
        ];
      if (notification) {
        notification.state = operation.state;
      }
    }
  }

  private async reconcileTerminalOperation(
    operation: ConnectorOperation,
    generation: number
  ): Promise<void> {
    if (operation.connectorKey) {
      const connector = await this.dependencies.backend.getConnector({
        connectorKey: operation.connectorKey
      });
      if (!this.isCurrent(generation)) {
        return;
      }
      const current = this.dataStore.connectorsByKey[connector.key];
      if (!current || connector.revision >= current.revision) {
        applyConnector(this.dataStore, connector);
      }
      this.dataStore.revision = Math.max(
        this.dataStore.revision,
        connector.revision
      );
      return;
    }
    const snapshot = await this.dependencies.backend.getSnapshot();
    if (this.isCurrent(generation)) {
      // Refresh completion is a local daemon fact. Do not make its terminal UI
      // state depend on another remote categories/icons request.
      applyConnectorMarketSnapshot(this.dataStore, snapshot);
      this.reconcileUninstallNotificationStates(snapshot.operations);
    }
  }

  private waitForOperationPoll(attempt: number): Promise<void> {
    const delayMs = Math.min(250 * 2 ** Math.min(attempt, 3), 2_000);
    const signal = this.operationTrackerAbort.signal;
    if (this.dependencies.waitForOperationPoll) {
      return this.dependencies.waitForOperationPoll(delayMs, signal);
    }
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

  private isRetryableOperationError(error: unknown): boolean {
    return normalizeConnectorMarketError(error).retryable;
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
    return !this.disposed && generation === this.dataGeneration;
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
        if (event.connectorKey) {
          this.requestConnectorEventLoad(event);
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
