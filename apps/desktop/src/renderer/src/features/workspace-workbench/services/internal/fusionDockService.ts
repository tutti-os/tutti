import type { DesktopFusionApi } from "@preload/types";
import type {
  DesktopFusionState,
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";
import {
  projectFusionBackgroundResources,
  type FusionBackgroundResource
} from "../fusionDockResourceModel.ts";
import type {
  FusionDockResourceClient,
  FusionDockLauncherOpenInput,
  FusionDockServiceRegistrationInput,
  IFusionDockService
} from "../fusionDockService.interface.ts";
import { resolveFusionDockLauncherActivationTarget } from "../fusionDockLauncherModel.ts";
import {
  createFusionResourceLaunchPayload,
  createFusionWindowDuplicateRequest,
  fusionDockResourcePollScope,
  loadFusionDockWorkspaceResourceSnapshots,
  refreshFusionDockKnownWorkspaceResourceSnapshots,
  requestFusionDockResourceStop,
  resolveMostRecentResourceWindow,
  selectFusionDockFastRefreshWorkspaceIds,
  type FusionDockWorkspaceResourceSnapshot
} from "./fusionDockServiceCore.ts";
import { createFusionDockStore } from "./fusionDockStore.ts";

const resourceRefreshIntervalMs = 5_000;
type FusionDockResourcePollScope = "all" | "known";

export interface FusionDockServiceScheduler {
  clearInterval(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
}

export interface FusionDockServiceDependencies extends FusionDockServiceRegistrationInput {
  scheduler?: FusionDockServiceScheduler;
}

export class FusionDockService implements IFusionDockService {
  readonly _serviceBrand: undefined;
  readonly store = createFusionDockStore();

  readonly #fusionApi: DesktopFusionApi;
  readonly #resourceClient: FusionDockResourceClient;
  readonly #scheduler: FusionDockServiceScheduler;
  readonly #workspaceId: string;
  #disposed = false;
  #elapsedPollingTicks = 0;
  #polling = false;
  #pollInterval: unknown | null = null;
  #queuedPollScope: FusionDockResourcePollScope | null = null;
  #refreshRequest = 0;
  #resourcePollPromise: Promise<void> | null = null;
  #resourceSnapshots: readonly FusionDockWorkspaceResourceSnapshot[] = [];
  #started = false;
  #unsubscribeFusionState: (() => void) | null = null;

  constructor(dependencies: FusionDockServiceDependencies) {
    this.#fusionApi = dependencies.fusionApi;
    this.#resourceClient = dependencies.resourceClient;
    this.#scheduler = dependencies.scheduler ?? defaultScheduler;
    this.#workspaceId = dependencies.workspaceId;
  }

  async start(): Promise<void> {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#unsubscribeFusionState = this.#fusionApi.onState((state) => {
      this.#acceptFusionState(state);
    });
    try {
      this.#acceptFusionState(await this.#fusionApi.getState());
    } catch {
      if (!this.#disposed) {
        this.store.actionError = true;
      }
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#refreshRequest += 1;
    this.#stopResourcePolling();
    this.#unsubscribeFusionState?.();
    this.#unsubscribeFusionState = null;
    this.store.refreshing = false;
  }

  async activateLauncher(input: FusionDockLauncherOpenInput): Promise<void> {
    let target = resolveFusionDockLauncherActivationTarget({
      launcher: input,
      resources: this.store.resources,
      windows: this.store.fusionState.windows
    });
    if (target.kind === "window") {
      const window = target.window;
      return this.#runAction(() =>
        this.#fusionApi.focusWindow({
          windowInstanceId: window.windowInstanceId
        })
      );
    }
    const pendingResourcePoll = this.#resourcePollPromise;
    if (pendingResourcePoll) {
      await pendingResourcePoll;
      if (this.#disposed) {
        return;
      }
      target = resolveFusionDockLauncherActivationTarget({
        launcher: input,
        resources: this.store.resources,
        windows: this.store.fusionState.windows
      });
      if (target.kind === "window") {
        const window = target.window;
        return this.#runAction(() =>
          this.#fusionApi.focusWindow({
            windowInstanceId: window.windowInstanceId
          })
        );
      }
    }
    if (target.kind === "resource") {
      const resource = target.resource;
      return this.#runAction(() =>
        this.#fusionApi.openWindow({
          forceNew: false,
          kind: resource.kind,
          launchPayload: createFusionResourceLaunchPayload(resource),
          resourceId: resource.id,
          title: resource.title,
          workspaceId: resource.workspaceId
        })
      );
    }
    return this.#runAction(() =>
      this.#fusionApi.openWindow({ ...input, forceNew: false })
    );
  }

  closeWindow(windowInstanceId: string): Promise<void> {
    return this.#runAction(() =>
      this.#fusionApi.closeWindow({ windowInstanceId })
    );
  }

  async confirmPendingTerminalStop(): Promise<void> {
    const pending = this.store.pendingTerminalStop;
    this.store.pendingTerminalStop = null;
    if (!pending) {
      return;
    }
    await this.#runAction(async () => {
      const result = await requestFusionDockResourceStop({
        client: this.#resourceClient,
        forceTerminalStop: true,
        resource: pending.resource
      });
      if (this.#disposed) {
        return;
      }
      if (result.status === "stopped") {
        await this.#refreshResources("known");
      }
    });
  }

  dismissPendingTerminalStop(): void {
    this.store.pendingTerminalStop = null;
  }

  focusOrReconnectResource(resource: FusionBackgroundResource): Promise<void> {
    const attached = resolveMostRecentResourceWindow(
      this.store.fusionState.windows,
      resource
    );
    return attached
      ? this.#runAction(() =>
          this.#fusionApi.focusWindow({
            windowInstanceId: attached.windowInstanceId
          })
        )
      : this.activateLauncher({
          kind: resource.kind,
          launchPayload: createFusionResourceLaunchPayload(resource),
          resourceId: resource.id,
          title: resource.title,
          workspaceId: resource.workspaceId
        });
  }

  focusWindow(windowInstanceId: string): Promise<void> {
    return this.#runAction(() =>
      this.#fusionApi.focusWindow({ windowInstanceId })
    );
  }

  hideDock(): Promise<void> {
    return this.#runAction(() => this.#fusionApi.hideDock());
  }

  openLauncherInNewWindow(input: FusionDockLauncherOpenInput): Promise<void> {
    return this.#runAction(() =>
      this.#fusionApi.openWindow({ ...input, forceNew: true })
    );
  }

  openNewWindow(
    kind: DesktopFusionWindowKind,
    workspaceId = this.#workspaceId
  ): Promise<void> {
    return this.#runAction(() =>
      this.#fusionApi.openWindow({ forceNew: true, kind, workspaceId })
    );
  }

  openResourceInNewWindow(resource: FusionBackgroundResource): Promise<void> {
    return this.#runAction(() =>
      this.#fusionApi.openWindow({
        forceNew: true,
        kind: resource.kind,
        launchPayload: createFusionResourceLaunchPayload(resource),
        resourceId: resource.id,
        title: resource.title,
        workspaceId: resource.workspaceId
      })
    );
  }

  openWindowInNewWindow(window: DesktopFusionWindowDescriptor): Promise<void> {
    const resource = this.store.resources.find(
      (candidate) =>
        candidate.workspaceId === window.workspaceId &&
        candidate.kind === window.kind &&
        candidate.id === window.resourceId
    );
    return this.#runAction(() =>
      this.#fusionApi.openWindow(
        createFusionWindowDuplicateRequest(window, resource)
      )
    );
  }

  stopResource(resource: FusionBackgroundResource): Promise<void> {
    return this.#runAction(async () => {
      const result = await requestFusionDockResourceStop({
        client: this.#resourceClient,
        resource
      });
      if (this.#disposed) {
        return;
      }
      if (result.status === "confirmation-required") {
        this.store.pendingTerminalStop = {
          details: result.details,
          resource
        };
      } else if (result.status === "stopped") {
        await this.#refreshResources("known");
      }
    });
  }

  #acceptFusionState(state: DesktopFusionState): void {
    if (this.#disposed || state.revision < this.store.fusionState.revision) {
      return;
    }
    this.store.fusionState = state;
    this.#updateDerivedState();
    this.#syncResourcePolling();
  }

  #queueResourcePoll(scope: FusionDockResourcePollScope): void {
    if (this.#disposed || !this.store.fusionState.dockVisible) {
      return;
    }
    this.#queuedPollScope = mergePollScopes(this.#queuedPollScope, scope);
    if (!this.#polling) {
      const pollPromise = this.#drainResourcePollQueue();
      this.#resourcePollPromise = pollPromise;
      const clearPollPromise = () => {
        if (this.#resourcePollPromise === pollPromise) {
          this.#resourcePollPromise = null;
        }
      };
      void pollPromise.then(clearPollPromise, clearPollPromise);
    }
  }

  async #drainResourcePollQueue(): Promise<void> {
    if (this.#polling || this.#disposed) {
      return;
    }
    this.#polling = true;
    try {
      while (
        !this.#disposed &&
        this.store.fusionState.dockVisible &&
        this.#queuedPollScope
      ) {
        const scope = this.#queuedPollScope;
        this.#queuedPollScope = null;
        try {
          await this.#refreshResources(scope);
        } catch {
          // Periodic refresh is best-effort; retain the last projected state.
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  async #refreshResources(scope: "all" | "known"): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const requestId = ++this.#refreshRequest;
    this.store.refreshing = true;
    const current = this.#resourceSnapshots;
    try {
      const next =
        scope === "all" || current.length === 0
          ? await loadFusionDockWorkspaceResourceSnapshots({
              client: this.#resourceClient,
              current,
              fallbackWorkspaceId: this.#workspaceId
            })
          : await refreshFusionDockKnownWorkspaceResourceSnapshots({
              client: this.#resourceClient,
              current,
              workspaceIds: selectFusionDockFastRefreshWorkspaceIds({
                current,
                fallbackWorkspaceId: this.#workspaceId,
                windows: this.store.fusionState.windows
              })
            });
      if (this.#disposed || requestId !== this.#refreshRequest) {
        return;
      }
      this.#resourceSnapshots = next;
      this.#updateDerivedState();
    } finally {
      if (!this.#disposed && requestId === this.#refreshRequest) {
        this.store.refreshing = false;
      }
    }
  }

  async #runAction(action: () => Promise<unknown>): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.store.actionError = false;
    try {
      await action();
    } catch {
      if (!this.#disposed) {
        this.store.actionError = true;
      }
    }
  }

  #syncResourcePolling(): void {
    if (this.#disposed || !this.store.fusionState.dockVisible) {
      this.#stopResourcePolling();
      this.store.refreshing = false;
      return;
    }
    if (this.#pollInterval !== null) {
      return;
    }
    this.#elapsedPollingTicks = 0;
    this.#queueResourcePoll("all");
    this.#pollInterval = this.#scheduler.setInterval(() => {
      this.#elapsedPollingTicks += 1;
      this.#queueResourcePoll(
        fusionDockResourcePollScope(this.#elapsedPollingTicks)
      );
    }, resourceRefreshIntervalMs);
  }

  #stopResourcePolling(): void {
    this.#queuedPollScope = null;
    if (this.#pollInterval === null) {
      return;
    }
    this.#scheduler.clearInterval(this.#pollInterval);
    this.#pollInterval = null;
    this.#elapsedPollingTicks = 0;
  }

  #updateDerivedState(): void {
    const windows = [...this.store.fusionState.windows].sort(
      (left, right) =>
        right.lastFocusedAtUnixMs - left.lastFocusedAtUnixMs ||
        right.createdAtUnixMs - left.createdAtUnixMs
    );
    this.store.windows = windows;
    this.store.resources = this.#resourceSnapshots.flatMap((snapshot) =>
      projectFusionBackgroundResources({
        agentSessions: snapshot.agentSessions,
        apps: snapshot.apps,
        terminals: snapshot.terminals,
        windows,
        workspaceId: snapshot.workspaceId,
        workspaceName: snapshot.workspaceName
      })
    );
    this.store.workspaceNameById = Object.fromEntries(
      this.#resourceSnapshots.map((snapshot) => [
        snapshot.workspaceId,
        snapshot.workspaceName
      ])
    );
  }
}

const defaultScheduler: FusionDockServiceScheduler = {
  clearInterval(handle) {
    globalThis.clearInterval(
      handle as ReturnType<typeof globalThis.setInterval>
    );
  },
  setInterval(callback, delayMs) {
    return globalThis.setInterval(callback, delayMs);
  }
};

function mergePollScopes(
  current: FusionDockResourcePollScope | null,
  requested: FusionDockResourcePollScope
): FusionDockResourcePollScope {
  return current === "all" || requested === "all" ? "all" : "known";
}
