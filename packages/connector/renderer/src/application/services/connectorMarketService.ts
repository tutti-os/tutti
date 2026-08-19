import { proxy } from "valtio/vanilla";
import {
  AUTHORIZATION_VIEW_PROTOCOL_V1,
  parseAuthorizationViewV1,
  type AuthorizationViewEnvelopeV1
} from "@tutti-os/connector-contracts/authorization/v1";

import type {
  ConnectorAuthorizationResult,
  ConnectorMarketChangedEvent,
  ConnectorMarketEventSource,
  ConnectorMutationResult,
  ConnectorOperation
} from "../contracts/index.ts";
import type {
  ConnectorMarketServiceDependencies,
  ConnectorInstallOutcome,
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

class ConnectorAuthorizationTerminalError extends Error {
  readonly code: string;
  readonly retryable = true;

  constructor(connectorKey: string, failureCode?: string) {
    super(`Connector authorization did not complete for ${connectorKey}`);
    this.name = "ConnectorAuthorizationTerminalError";
    this.code = failureCode || "connector_authorization_failed";
  }
}

export class ConnectorAuthorizationCanceledError extends Error {
  readonly code = "connector_authorization_canceled";
  readonly retryable = true;

  constructor(readonly connectorKey: string) {
    super(`Connector authorization was canceled for ${connectorKey}`);
    this.name = "ConnectorAuthorizationCanceledError";
  }
}

class ConnectorAuthorizationViewInvalidError extends Error {
  readonly code = "connector_authorization_view_invalid";
  readonly retryable = false;

  constructor() {
    super("Connector authorization returned an invalid presentation");
    this.name = "ConnectorAuthorizationViewInvalidError";
  }
}

class ConnectorOperationTerminalError extends Error {
  readonly code: string;
  readonly retryable = true;

  constructor(connectorKey: string, failureCode?: string) {
    super(`Connector operation failed for ${connectorKey}`);
    this.name = "ConnectorOperationTerminalError";
    this.code = failureCode || "connector_install_failed";
  }
}

const authorizationContinuationPollMs = 1_000;
const authorizationSessionTimeoutMs = 10 * 60 * 1_000;

interface AuthorizationAttemptControl {
  canceled: boolean;
  expiresAtMs: number;
  requestId: string;
}

function waitForAuthorizationContinuation(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, authorizationContinuationPollMs);
  });
}

function legacyAuthorizationStepHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function legacyAuthorizationViewId(operationId: string, url: string): string {
  const normalized = operationId.replace(/[^A-Za-z0-9._:-]/g, "-");
  const prefix = `authorization-${normalized || "legacy"}`.slice(0, 118);
  return `${prefix}-${legacyAuthorizationStepHash(`${operationId}\0${url}`)}`;
}

function resolveAuthorizationView(
  result: ConnectorAuthorizationResult
): AuthorizationViewEnvelopeV1 | null {
  if (result.connector.authorization.state !== "pending") {
    return null;
  }
  const candidate =
    result.authorizationView ??
    (result.authorizationUrl
      ? {
          protocol: AUTHORIZATION_VIEW_PROTOCOL_V1,
          viewId: legacyAuthorizationViewId(
            result.operation.operationId,
            result.authorizationUrl
          ),
          view: {
            type: "external_link",
            url: result.authorizationUrl,
            ...(result.authorizationExpiresAt
              ? { expiresAt: result.authorizationExpiresAt }
              : {})
          }
        }
      : null);
  if (candidate === null) {
    return null;
  }
  const parsed = parseAuthorizationViewV1(candidate);
  if (!parsed.ok) {
    throw new ConnectorAuthorizationViewInvalidError();
  }
  return parsed.value;
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
  private readonly authorizationInFlight = new Map<string, Promise<void>>();
  private readonly authorizationAttempts = new Map<
    string,
    AuthorizationAttemptControl
  >();
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
  private readonly automaticUpdateReleaseByConnectorKey = new Map<
    string,
    string
  >();
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

  async install(connectorKey: string): Promise<ConnectorInstallOutcome> {
    if (this.disposed) {
      return "not_admitted";
    }
    if (!this.canRequest()) {
      await this.dependencies.requestInstallAdmission?.();
    }
    if (this.disposed || !this.canRequest()) {
      return "not_admitted";
    }
    const installed = await this.installConnector(connectorKey);
    return installed ? "installed" : "not_admitted";
  }

  private installConnector(connectorKey: string): Promise<boolean> {
    const connector = this.dataStore.connectorsByKey[connectorKey];
    if (
      connector?.installation.state === "installed" &&
      connector.installation.installedReleaseDigest &&
      connector.installation.installedReleaseDigest !==
        connector.release.releaseDigest
    ) {
      this.automaticUpdateReleaseByConnectorKey.set(
        connectorKey,
        connector.release.releaseDigest
      );
    }
    return this.runConnectorMutation(
      connectorKey,
      () =>
        this.dependencies.backend.installConnector({
          connectorKey,
          clientRequestId: this.createRequestId(),
          expectedRevision: this.dataStore.revision,
          ...this.connectorRevisionFence(connectorKey)
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
        expectedRevision: this.dataStore.revision,
        ...this.connectorRevisionFence(connectorKey)
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

  async setRuntimeEnabled(
    connectorKey: string,
    enabled: boolean
  ): Promise<void> {
    if (this.disposed || !this.canRequest()) {
      throw new ConnectorMarketRequestUnavailableError();
    }
    const token = this.acquireConnectorMutation(connectorKey);
    const generation = this.dataGeneration;
    const update = () =>
      this.dependencies.backend.updateConnectorRuntime({
        connectorKey,
        enabled,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision,
        ...this.connectorRevisionFence(connectorKey)
      });
    try {
      let connector: Awaited<ReturnType<typeof update>>;
      try {
        connector = await update();
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
        connector = await update();
      }
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        applyConnector(this.dataStore, connector);
        this.dataStore.revision = Math.max(
          this.dataStore.revision,
          connector.revision
        );
        this.dataStore.lastError = null;
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

  dismissUninstallNotification(operationId: string): void {
    if (!this.disposed) {
      delete this.dataStore.pendingUninstallNotificationsByOperationId[
        operationId
      ];
    }
  }

  beginAuthorization(connectorKey: string, secret?: string): Promise<void> {
    if (this.disposed || !this.canRequest()) {
      return Promise.resolve();
    }
    const previousAttempt = this.authorizationAttempts.get(connectorKey);
    if (previousAttempt) {
      previousAttempt.canceled = true;
    }
    let authorization!: Promise<void>;
    authorization = this.runAuthorization(connectorKey, secret).finally(() => {
      if (this.authorizationInFlight.get(connectorKey) === authorization) {
        this.authorizationInFlight.delete(connectorKey);
      }
    });
    this.authorizationInFlight.set(connectorKey, authorization);
    return authorization;
  }

  async cancelAuthorization(connectorKey: string): Promise<void> {
    const attempt = this.authorizationAttempts.get(connectorKey);
    const mutationToken = this.connectorMutations.get(connectorKey);
    if (attempt) {
      attempt.canceled = true;
    }
    delete this.dataStore.pendingAuthorizationsByConnectorKey[connectorKey];
    delete this.dataStore.authorizationViewsByConnectorKey[connectorKey];
    try {
      await this.dependencies.backend.cancelAuthorization({ connectorKey });
    } finally {
      if (this.authorizationAttempts.get(connectorKey) === attempt) {
        this.authorizationAttempts.delete(connectorKey);
      }
      if (
        mutationToken &&
        this.connectorMutations.get(connectorKey) === mutationToken
      ) {
        this.connectorMutations.delete(connectorKey);
        delete this.dataStore.authorizingConnectorKeys[connectorKey];
      }
    }
  }

  async openAuthorizationUrl(url: string): Promise<void> {
    await this.dependencies.openAuthorizationUrl?.(url);
  }

  private async runAuthorization(
    connectorKey: string,
    secret?: string
  ): Promise<void> {
    const token = this.authorizationAttempts.has(connectorKey)
      ? this.replaceConnectorMutation(connectorKey)
      : this.acquireConnectorMutation(connectorKey);
    this.dataStore.authorizingConnectorKeys[connectorKey] = true;
    delete this.dataStore.pendingAuthorizationsByConnectorKey[connectorKey];
    delete this.dataStore.authorizationViewsByConnectorKey[connectorKey];
    const generation = this.dataGeneration;
    const attempt: AuthorizationAttemptControl = {
      canceled: false,
      expiresAtMs: Date.now() + authorizationSessionTimeoutMs,
      requestId: this.createRequestId()
    };
    this.authorizationAttempts.set(connectorKey, attempt);
    const request = {
      connectorKey,
      clientRequestId: attempt.requestId,
      replacementPolicy: "replace_active" as const,
      ...(secret ? { secret } : {})
    };
    let expectedRevision = this.dataStore.revision;
    const seenAuthorizationViewIds = new Set<string>();
    let recoveredRevisionConflict = false;
    try {
      while (this.isCurrentMutation(connectorKey, token, generation)) {
        if (
          seenAuthorizationViewIds.size > 0 &&
          this.authorizationState(connectorKey) === "connected"
        ) {
          await this.waitForAuthorizationOperation(connectorKey);
          return;
        }
        let result: ConnectorAuthorizationResult;
        try {
          result = await this.dependencies.backend.beginAuthorization({
            ...request,
            expectedRevision,
            ...this.connectorRevisionFence(connectorKey)
          });
        } catch (error) {
          const code = normalizeConnectorMarketError(error).code;
          const canRecoverRevision: boolean =
            !recoveredRevisionConflict &&
            code === "connector_market_revision_conflict";
          const canRecoverBusyContinuation: boolean =
            seenAuthorizationViewIds.size > 0 &&
            code === "connector_operation_in_progress";
          if (
            (!canRecoverRevision && !canRecoverBusyContinuation) ||
            !this.isCurrentMutation(connectorKey, token, generation)
          ) {
            throw error;
          }
          recoveredRevisionConflict =
            recoveredRevisionConflict || canRecoverRevision;
          const next = await this.dependencies.backend.getSnapshot();
          if (!this.isCurrentMutation(connectorKey, token, generation)) {
            if (attempt.canceled) {
              throw new ConnectorAuthorizationCanceledError(connectorKey);
            }
            return;
          }
          applyConnectorMarketSnapshot(this.dataStore, next);
          this.reconcileUninstallNotificationStates(next.operations);
          expectedRevision = this.dataStore.revision;
          if (this.authorizationState(connectorKey) === "connected") {
            await this.waitForAuthorizationOperation(connectorKey);
            return;
          }
          if (canRecoverBusyContinuation) {
            await this.waitForAuthorizationContinuation();
          }
          continue;
        }
        if (!this.isCurrentMutation(connectorKey, token, generation)) {
          if (attempt.canceled) {
            throw new ConnectorAuthorizationCanceledError(connectorKey);
          }
          return;
        }
        if (attempt.canceled) {
          await this.dependencies.backend.cancelAuthorization({ connectorKey });
          throw new ConnectorAuthorizationCanceledError(connectorKey);
        }
        applyConnectorMutationResult(this.dataStore, result);
        const expiresAtMs = Date.parse(result.authorizationExpiresAt ?? "");
        if (Number.isFinite(expiresAtMs)) {
          attempt.expiresAtMs = expiresAtMs;
        }
        if (result.connector.authorization.state === "pending") {
          this.dataStore.pendingAuthorizationsByConnectorKey[connectorKey] =
            true;
        } else {
          delete this.dataStore.pendingAuthorizationsByConnectorKey[
            connectorKey
          ];
        }
        const operationTrack = this.trackOperation(result.operation);
        const authorizationView = resolveAuthorizationView(result);
        const discoveredNextStep =
          authorizationView !== null &&
          !seenAuthorizationViewIds.has(authorizationView.viewId);
        if (discoveredNextStep && authorizationView) {
          seenAuthorizationViewIds.add(authorizationView.viewId);
          this.dataStore.authorizationViewsByConnectorKey[connectorKey] =
            authorizationView;
          const activationUrl =
            authorizationView.view.type === "external_link"
              ? authorizationView.view.url
              : authorizationView.view.type === "device_code"
                ? authorizationView.view.verificationUrl
                : null;
          if (activationUrl) {
            await this.openAuthorizationUrl(activationUrl);
          }
        }
        if (this.authorizationState(connectorKey) === "connected") {
          await operationTrack;
          return;
        }
        if (result.connector.authorization.state !== "pending") {
          throw new ConnectorAuthorizationTerminalError(
            connectorKey,
            result.connector.authorization.failureCode
          );
        }
        if (!discoveredNextStep) {
          await this.waitForAuthorizationTerminal(
            connectorKey,
            token,
            generation,
            attempt
          );
          return;
        }
      }
      if (attempt.canceled) {
        throw new ConnectorAuthorizationCanceledError(connectorKey);
      }
    } catch (error) {
      if (this.isCurrentMutation(connectorKey, token, generation)) {
        this.recordError(error);
      }
      throw error;
    } finally {
      if (this.connectorMutations.get(connectorKey) === token) {
        delete this.dataStore.authorizingConnectorKeys[connectorKey];
        delete this.dataStore.pendingAuthorizationsByConnectorKey[connectorKey];
        delete this.dataStore.authorizationViewsByConnectorKey[connectorKey];
      }
      if (this.authorizationAttempts.get(connectorKey) === attempt) {
        this.authorizationAttempts.delete(connectorKey);
      }
      this.releaseConnectorMutation(connectorKey, token);
    }
  }

  async disconnectAuthorization(connectorKey: string): Promise<void> {
    await this.runConnectorMutation(connectorKey, () =>
      this.dependencies.backend.disconnectAuthorization({
        connectorKey,
        clientRequestId: this.createRequestId(),
        expectedRevision: this.dataStore.revision,
        ...this.connectorRevisionFence(connectorKey)
      })
    );
  }

  private connectorRevisionFence(connectorKey: string): {
    expectedConnectorRevision?: number;
  } {
    const connector = this.dataStore.connectorsByKey[connectorKey];
    return connector ? { expectedConnectorRevision: connector.revision } : {};
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dataGeneration += 1;
    this.connectorMutations.clear();
    this.authorizationInFlight.clear();
    this.pendingConnectorEvents.clear();
    this.connectorEventLoads.clear();
    this.operationTrackerAbort.abort();
    this.operationTracks.clear();
    this.refreshInFlight = null;
    this.sectionLoads.clear();
    this.automaticUpdateReleaseByConnectorKey.clear();
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
            installation: "not_installed",
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
      this.requestAutomaticUpdates();
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
        installation: "not_installed",
        sectionId,
        pageSize: 20,
        pageToken
      });
      if (this.isCurrent(generation)) {
        applyConnectorMarketCatalogPage(this.dataStore, page);
        this.requestAutomaticUpdates();
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
          this.requestAuthoritativeLoad();
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
    if (!this.isCurrent(generation)) {
      return;
    }
    const current = this.dataStore.connectorsByKey[connectorKey];
    if (current && connector.revision < current.revision) {
      return;
    }
    applyConnector(this.dataStore, connector);
    if (operation?.connectorKey === connectorKey) {
      this.applyTrackedOperation(operation);
      this.trackOperation(operation);
    }
    this.dataStore.revision = Math.max(this.dataStore.revision, event.revision);
    this.dataStore.lastError = null;
    this.requestAutomaticUpdates();
  }

  private requestAutomaticUpdates(): void {
    if (
      !this.dependencies.autoUpdateInstalledConnectors ||
      !this.canRequest()
    ) {
      return;
    }
    for (const connector of Object.values(this.dataStore.connectorsByKey)) {
      const installedReleaseDigest =
        connector.installation.installedReleaseDigest;
      const targetReleaseDigest = connector.release.releaseDigest;
      if (
        connector.compatibility.state !== "supported" ||
        connector.release.status !== "available" ||
        connector.installation.state !== "installed" ||
        !installedReleaseDigest ||
        installedReleaseDigest === targetReleaseDigest ||
        this.connectorMutations.has(connector.key) ||
        this.automaticUpdateReleaseByConnectorKey.get(connector.key) ===
          targetReleaseDigest
      ) {
        continue;
      }
      this.automaticUpdateReleaseByConnectorKey.set(
        connector.key,
        targetReleaseDigest
      );
      void this.installConnector(connector.key).catch(() => undefined);
    }
  }

  private async runConnectorMutation(
    connectorKey: string,
    operation: () => Promise<ConnectorMutationResult>,
    projectPendingInstallation = false
  ): Promise<boolean> {
    const result = await this.runConnectorMutationResult(
      connectorKey,
      operation,
      projectPendingInstallation
    );
    if (!result) {
      return false;
    }
    const tracked = this.trackOperation(result.operation);
    if (tracked) {
      await tracked;
    }
    const terminal = this.dataStore.operationsByConnectorKey[connectorKey];
    if (
      terminal?.operationId === result.operation.operationId &&
      terminal.state === "failed"
    ) {
      throw new ConnectorOperationTerminalError(
        connectorKey,
        terminal.failureCode
      );
    }
    return true;
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

  private trackOperation(
    operation: ConnectorOperation
  ): Promise<void> | undefined {
    if (
      this.disposed ||
      operation.state === "completed" ||
      operation.state === "failed"
    ) {
      return;
    }
    const existing = this.operationTracks.get(operation.operationId);
    if (existing) {
      return existing;
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
    return promise;
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
          if (this.isCurrent(generation)) {
            // A continuation response for the same idempotent mutation may
            // arrive while terminal connector reconciliation is in flight.
            // Re-assert the authoritative terminal receipt after that await so
            // the older accepted response cannot leave the card permanently
            // busy until a later background refresh.
            this.applyTrackedOperation(operation);
          }
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
      this.requestAutomaticUpdates();
      return;
    }
    const snapshot = await this.dependencies.backend.getSnapshot();
    if (this.isCurrent(generation)) {
      // Refresh completion is a local daemon fact. Do not make its terminal UI
      // state depend on another remote categories/icons request.
      applyConnectorMarketSnapshot(this.dataStore, snapshot);
      this.reconcileUninstallNotificationStates(snapshot.operations);
      this.requestAutomaticUpdates();
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

  private authorizationState(connectorKey: string) {
    return this.dataStore.connectorsByKey[connectorKey]?.authorization.state;
  }

  private waitForAuthorizationOperation(connectorKey: string): Promise<void> {
    const operation = this.dataStore.operationsByConnectorKey[connectorKey];
    if (!operation || operation.kind !== "start_authorization") {
      return Promise.resolve();
    }
    return this.trackOperation(operation) ?? Promise.resolve();
  }

  private waitForAuthorizationContinuation(): Promise<void> {
    return (
      this.dependencies.waitForAuthorizationContinuation?.() ??
      waitForAuthorizationContinuation()
    );
  }

  private async waitForAuthorizationTerminal(
    connectorKey: string,
    token: symbol,
    generation: number,
    attempt: AuthorizationAttemptControl
  ): Promise<void> {
    while (this.isCurrentMutation(connectorKey, token, generation)) {
      if (attempt.canceled) {
        throw new ConnectorAuthorizationCanceledError(connectorKey);
      }
      if (this.authorizationState(connectorKey) === "connected") {
        await this.waitForAuthorizationOperation(connectorKey);
        return;
      }
      if (Date.now() >= attempt.expiresAtMs) {
        attempt.canceled = true;
        await this.dependencies.backend.cancelAuthorization({ connectorKey });
        throw new ConnectorAuthorizationTerminalError(
          connectorKey,
          "connector_authorization_timeout"
        );
      }
      await this.waitForAuthorizationContinuation();
    }
    if (attempt.canceled) {
      throw new ConnectorAuthorizationCanceledError(connectorKey);
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

  private replaceConnectorMutation(connectorKey: string): symbol {
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
        if (this.disposed) {
          return;
        }
        if (event.cursor !== undefined) {
          if (event.cursor <= this.dataStore.lastEventCursor) {
            return;
          }
          if (
            this.dataStore.lastEventCursor > 0 &&
            event.cursor !== this.dataStore.lastEventCursor + 1
          ) {
            this.requestAuthoritativeLoad();
            return;
          }
          this.dataStore.lastEventCursor = event.cursor;
        } else if (event.revision <= this.dataStore.snapshotRevision) {
          return;
        }
        if (event.connectorKey) {
          const connector = this.dataStore.connectorsByKey[event.connectorKey];
          if (connector && connector.revision >= event.revision) {
            return;
          }
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
