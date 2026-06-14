import type {
  WorkspaceAppCenterReadableStoreState,
  WorkspaceAppCenterStoreState,
  WorkspaceAppCenterViewState
} from "../contracts/host.ts";
import {
  areWorkspaceAppCenterViewStatesEqual,
  appRuntimeKey,
  normalizeWorkspaceAppCenterViewState
} from "./appCenterControllerHelpers.ts";
import {
  createWorkspaceAppCenterStoreState,
  type WorkspaceAppCenterControllerDependencies,
  type WorkspaceAppCenterOperationDetails
} from "./appCenterControllerTypes.ts";

export abstract class WorkspaceAppCenterControllerBase {
  readonly store: WorkspaceAppCenterStoreState;

  protected readonly dependencies: WorkspaceAppCenterControllerDependencies;
  protected readonly listeners = new Set<() => void>();
  protected catalogRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  protected installRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  protected pendingFactoryPublishKeys = new Set<string>();
  protected pendingInstallKeys = new Set<string>();
  protected pendingInstallReportKeys = new Set<string>();
  protected appLoadSequence = 0;
  protected factoryLoadSequence = 0;
  protected pollingWorkspaceId: string | null = null;

  constructor(dependencies: WorkspaceAppCenterControllerDependencies) {
    this.dependencies = dependencies;
    this.store = dependencies.store ?? createWorkspaceAppCenterStoreState();
  }

  get readableStore(): WorkspaceAppCenterReadableStoreState {
    return this.store;
  }

  consumeError(): string | null {
    const error = this.store.error;
    if (error === null) {
      return null;
    }
    this.store.error = null;
    this.bumpRevision();
    return error;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  beginWorkspacePolling(workspaceId: string): void {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return;
    }
    if (this.pollingWorkspaceId === normalizedWorkspaceId) {
      return;
    }
    this.clearCatalogRefreshTimer();
    this.clearInstallRefreshTimers();
    this.pollingWorkspaceId = normalizedWorkspaceId;
  }

  endWorkspacePolling(workspaceId: string): void {
    if (this.pollingWorkspaceId !== workspaceId.trim()) {
      return;
    }
    this.pollingWorkspaceId = null;
    this.clearCatalogRefreshTimer();
    this.clearInstallRefreshTimers();
  }

  getViewState(
    workspaceId: string,
    restoredState?: WorkspaceAppCenterViewState | null
  ): WorkspaceAppCenterViewState {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return normalizeWorkspaceAppCenterViewState(restoredState);
    }
    const existing = this.store.viewStateByWorkspaceId[normalizedWorkspaceId];
    if (existing) {
      return existing;
    }
    const nextState = normalizeWorkspaceAppCenterViewState(restoredState);
    this.store.viewStateByWorkspaceId = {
      ...this.store.viewStateByWorkspaceId,
      [normalizedWorkspaceId]: nextState
    };
    return nextState;
  }

  setViewState(input: {
    state: Partial<WorkspaceAppCenterViewState>;
    workspaceId: string;
  }): void {
    const normalizedWorkspaceId = input.workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return;
    }
    const previous = this.getViewState(normalizedWorkspaceId);
    const nextState = normalizeWorkspaceAppCenterViewState({
      ...previous,
      ...input.state
    });
    if (areWorkspaceAppCenterViewStatesEqual(previous, nextState)) {
      return;
    }
    this.store.viewStateByWorkspaceId = {
      ...this.store.viewStateByWorkspaceId,
      [normalizedWorkspaceId]: nextState
    };
    this.bumpRevision();
  }

  setOperationError(
    error: unknown,
    details: WorkspaceAppCenterOperationDetails
  ): void {
    const message = this.dependencies.formatError(error, details);
    this.recordOperationFailure(error, message, details);
    this.store.error = message;
    this.bumpRevision();
  }

  setUnavailableError(
    error: unknown,
    details: WorkspaceAppCenterOperationDetails
  ): void {
    const message = this.dependencies.formatError(error, details);
    this.recordOperationFailure(error, message, details);
    this.store.error = message;
    this.store.loadStatus = "unavailable";
    this.bumpRevision();
  }

  protected clearCatalogRefreshTimer(): void {
    if (!this.catalogRefreshTimer) {
      return;
    }
    clearTimeout(this.catalogRefreshTimer);
    this.catalogRefreshTimer = null;
  }

  protected clearInstallRefreshTimer(workspaceId: string, appId: string): void {
    const key = appRuntimeKey(workspaceId, appId);
    const timer = this.installRefreshTimers.get(key);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.installRefreshTimers.delete(key);
  }

  protected clearInstallRefreshTimers(): void {
    for (const timer of this.installRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.installRefreshTimers.clear();
    this.pendingInstallKeys.clear();
    this.pendingInstallReportKeys.clear();
  }

  protected recordOperationFailure(
    error: unknown,
    toastMessage: string,
    details: WorkspaceAppCenterOperationDetails
  ): void {
    this.dependencies.hooks?.onOperationFailure?.({
      details,
      error,
      toastMessage
    });
  }

  protected bumpRevision(): void {
    this.store.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  protected closeWorkspaceAppViews(
    workspaceId: string,
    appIds: readonly string[]
  ): void {
    if (appIds.length === 0) {
      return;
    }
    this.dependencies.hooks?.onCloseWorkspaceAppViews?.({
      appIds,
      workspaceId
    });
  }

  protected getErrorReason(error: unknown): string | null {
    return this.dependencies.getErrorReason?.(error) ?? null;
  }
}
