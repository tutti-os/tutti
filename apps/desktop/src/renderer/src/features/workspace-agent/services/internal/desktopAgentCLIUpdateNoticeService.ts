import type {
  AgentGUIProviderUpdateNotice,
  AgentGUIProviderUpdateNoticeAction,
  AgentGUIProviderUpdateNoticePhase
} from "@tutti-os/agent-gui";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { subscribe as subscribeValtio } from "valtio";
import type { WorkspaceWindowLifecycle } from "../../../../lib/workspaceWindowLifecycle.ts";
import type { IDesktopPreferencesService } from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import type {
  AgentCLIUpdateNoticeSnapshot,
  IAgentCLIUpdateNoticeService
} from "../agentCLIUpdateNoticeService.interface.ts";
import type { IAgentEnvService } from "../agentEnvService.interface.ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import type { IAgentsService } from "../agentsService.interface.ts";
import {
  desktopAgentCLIUpdateItemKey,
  desktopAgentCLIUpdateItemsEqual,
  hasDesktopAgentCLIUpdateConverged,
  projectDesktopAgentCLIUpdateItems,
  type DesktopAgentCLIUpdateItem
} from "./desktopAgentCLIUpdateNoticeModel.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";

const DEFAULT_COMPLETED_NOTICE_DURATION_MS = 6_000;
const DEFAULT_DISCOVERY_REQUEST_MIN_INTERVAL_MS = 30_000;

type DesktopAgentCLIUpdateActionPhase = "updating" | "failed" | "completed";

interface DesktopAgentCLIUpdateActionState {
  item: DesktopAgentCLIUpdateItem;
  phase: DesktopAgentCLIUpdateActionPhase;
}

interface DesktopAgentCLIUpdatePresentation {
  item: DesktopAgentCLIUpdateItem;
  phase: AgentGUIProviderUpdateNoticePhase;
}

export interface DesktopAgentCLIUpdateNoticeServiceDependencies {
  agentEnvService: IAgentEnvService;
  agentsService: IAgentsService;
  desktopPreferencesService: IDesktopPreferencesService;
  providerStatusService: IAgentProviderStatusService;
  windowLifecycle: WorkspaceWindowLifecycle;
  workspaceId: string;
  completedNoticeDurationMs?: number;
  discoveryRequestMinIntervalMs?: number;
  now?: () => number;
}

export class DesktopAgentCLIUpdateNoticeService implements IAgentCLIUpdateNoticeService {
  readonly _serviceBrand = undefined;

  private snapshot: AgentCLIUpdateNoticeSnapshot = { notices: [] };
  private readonly listeners = new Set<() => void>();
  private readonly eligibleSurfaceIds = new Set<string>();
  private readonly dismissedItemKeys = new Set<string>();
  private readonly actionStates = new Map<
    WorkspaceAgentProvider,
    DesktopAgentCLIUpdateActionState
  >();
  private readonly inflightProviders = new Set<WorkspaceAgentProvider>();
  private readonly completionTimers = new Map<
    WorkspaceAgentProvider,
    ReturnType<typeof setTimeout>
  >();
  private readonly disposers: Array<() => void>;
  private presentations: readonly DesktopAgentCLIUpdatePresentation[] = [];
  private discoveryRequest: Promise<unknown> | null = null;
  private lastDiscoveryRequestedAt = Number.NEGATIVE_INFINITY;
  private autoCheckEnabled: boolean;
  private disposed = false;
  private readonly dependencies: DesktopAgentCLIUpdateNoticeServiceDependencies;

  constructor(dependencies: DesktopAgentCLIUpdateNoticeServiceDependencies) {
    this.dependencies = dependencies;
    this.autoCheckEnabled =
      dependencies.desktopPreferencesService.store.agentCliUpdateCheckEnabled;
    this.disposers = [
      dependencies.providerStatusService.subscribe(() => this.reconcile()),
      dependencies.agentsService.subscribe(() => this.reconcile()),
      subscribeValtio(dependencies.desktopPreferencesService.store, () => {
        const enabled =
          dependencies.desktopPreferencesService.store
            .agentCliUpdateCheckEnabled;
        const enabledChanged = enabled !== this.autoCheckEnabled;
        this.autoCheckEnabled = enabled;
        if (enabledChanged && enabled) {
          this.requestDiscovery();
        }
        this.reconcile();
      }),
      dependencies.windowLifecycle.subscribe((event) => {
        if (
          event.kind === "focused" ||
          (event.kind === "visibility_changed" &&
            event.visibility === "visible")
        ) {
          this.requestDiscovery();
        }
      })
    ];
  }

  readonly getSnapshot = (): AgentCLIUpdateNoticeSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setSurfaceEligible(surfaceId: string, eligible: boolean): void {
    const normalizedSurfaceId = surfaceId.trim();
    if (this.disposed || !normalizedSurfaceId) {
      return;
    }
    const changed = eligible
      ? !this.eligibleSurfaceIds.has(normalizedSurfaceId)
      : this.eligibleSurfaceIds.has(normalizedSurfaceId);
    if (!changed) {
      return;
    }
    if (eligible) {
      this.eligibleSurfaceIds.add(normalizedSurfaceId);
      this.requestDiscovery();
    } else {
      this.eligibleSurfaceIds.delete(normalizedSurfaceId);
    }
    this.reconcile();
  }

  releaseSurface(surfaceId: string): void {
    const normalizedSurfaceId = surfaceId.trim();
    if (
      !normalizedSurfaceId ||
      !this.eligibleSurfaceIds.delete(normalizedSurfaceId)
    ) {
      return;
    }
    this.reconcile();
  }

  async runAction(input: {
    action: AgentGUIProviderUpdateNoticeAction;
    notice: AgentGUIProviderUpdateNotice;
  }): Promise<void> {
    if (this.disposed) {
      return;
    }
    const presentation = this.presentations.find(({ item }) =>
      noticeMatchesItem(input.notice, item)
    );
    if (!presentation) {
      return;
    }
    const { item, phase } = presentation;
    if (input.action === "details") {
      this.dependencies.agentEnvService.open({
        provider: item.provider,
        focus: "upgrade"
      });
      return;
    }
    if (phase !== "available" && phase !== "failed") {
      return;
    }
    if (input.action === "later") {
      this.dismissItem(item);
      return;
    }
    await this.updateItem(item);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const dispose of this.disposers) {
      dispose();
    }
    for (const timer of this.completionTimers.values()) {
      clearTimeout(timer);
    }
    this.completionTimers.clear();
    this.listeners.clear();
    this.eligibleSurfaceIds.clear();
    this.inflightProviders.clear();
  }

  private requestDiscovery(): void {
    const now = this.dependencies.now?.() ?? Date.now();
    if (
      this.disposed ||
      this.discoveryRequest ||
      this.eligibleSurfaceIds.size === 0 ||
      !this.autoCheckEnabled ||
      now - this.lastDiscoveryRequestedAt <
        (this.dependencies.discoveryRequestMinIntervalMs ??
          DEFAULT_DISCOVERY_REQUEST_MIN_INTERVAL_MS)
    ) {
      return;
    }
    this.lastDiscoveryRequestedAt = now;
    const request = this.dependencies.providerStatusService
      .ensureLoaded({
        includeUpdates: true,
        providers: [...desktopManagedAgentProviders]
      })
      .catch(() => null);
    this.discoveryRequest = request;
    void request.finally(() => {
      if (this.discoveryRequest === request) {
        this.discoveryRequest = null;
      }
    });
  }

  private reconcile(): void {
    if (this.disposed) {
      return;
    }
    const providerSnapshot =
      this.dependencies.providerStatusService.getSnapshot();
    const availableItems = this.autoCheckEnabled
      ? projectDesktopAgentCLIUpdateItems(
          providerSnapshot.statuses,
          this.dependencies.agentsService.getSnapshot().agents
        )
      : [];
    this.reconcileActionStates(availableItems, providerSnapshot.statuses);

    const presentationsByProvider = new Map<
      WorkspaceAgentProvider,
      DesktopAgentCLIUpdatePresentation
    >();
    if (this.eligibleSurfaceIds.size > 0) {
      const pendingProviders = new Set(
        providerSnapshot.pendingActions
          .filter((action) => action.actionId === "update")
          .map((action) => action.provider)
      );
      for (const item of availableItems) {
        if (!this.dismissedItemKeys.has(desktopAgentCLIUpdateItemKey(item))) {
          presentationsByProvider.set(item.provider, {
            item,
            phase: pendingProviders.has(item.provider)
              ? "updating"
              : "available"
          });
        }
      }
      for (const state of this.actionStates.values()) {
        presentationsByProvider.set(state.item.provider, state);
      }
    }
    this.presentations = desktopManagedAgentProviders.flatMap((provider) => {
      const presentation = presentationsByProvider.get(provider);
      return presentation ? [presentation] : [];
    });
    this.syncCompletionTimers();
    this.setSnapshot({
      notices: this.presentations.map(({ item, phase }) => ({
        agentTargetId: item.agentTargetId,
        currentVersion: item.currentVersion,
        latestVersion: item.latestVersion,
        phase
      }))
    });
  }

  private reconcileActionStates(
    availableItems: readonly DesktopAgentCLIUpdateItem[],
    statuses: readonly AgentProviderStatus[]
  ): void {
    const availableByProvider = new Map(
      availableItems.map((item) => [item.provider, item])
    );
    const statusByProvider = new Map(
      statuses.map((status) => [status.provider, status])
    );
    for (const [provider, state] of this.actionStates) {
      const itemKey = desktopAgentCLIUpdateItemKey(state.item);
      if (this.dismissedItemKeys.has(itemKey)) {
        this.actionStates.delete(provider);
        continue;
      }
      if (
        state.phase !== "completed" &&
        hasDesktopAgentCLIUpdateConverged(
          state.item,
          statusByProvider.get(provider)?.update
        )
      ) {
        this.actionStates.set(provider, {
          item: state.item,
          phase: "completed"
        });
        continue;
      }
      const availableItem = availableByProvider.get(provider);
      if (
        state.phase !== "updating" &&
        availableItem &&
        !desktopAgentCLIUpdateItemsEqual(state.item, availableItem)
      ) {
        this.clearCompletionTimer(provider);
        this.actionStates.delete(provider);
      }
    }
  }

  private async updateItem(item: DesktopAgentCLIUpdateItem): Promise<void> {
    if (this.inflightProviders.has(item.provider)) {
      return;
    }
    this.inflightProviders.add(item.provider);
    this.clearCompletionTimer(item.provider);
    this.actionStates.set(item.provider, { item, phase: "updating" });
    this.reconcile();
    try {
      await this.dependencies.providerStatusService.runAction(
        item.provider,
        "update",
        {
          context: { workspaceId: this.dependencies.workspaceId },
          origin: "user"
        }
      );
      if (!this.disposed) {
        if (this.hasConverged(item)) {
          this.markCompleted(item);
        } else {
          this.markFailed(item);
        }
      }
    } catch {
      if (!this.disposed) {
        if (this.hasConverged(item)) {
          this.markCompleted(item);
        } else {
          this.markFailed(item);
        }
      }
    } finally {
      this.inflightProviders.delete(item.provider);
    }
  }

  private hasConverged(item: DesktopAgentCLIUpdateItem): boolean {
    return hasDesktopAgentCLIUpdateConverged(
      item,
      this.dependencies.providerStatusService.getStatus(item.provider)?.update
    );
  }

  private markCompleted(item: DesktopAgentCLIUpdateItem): void {
    if (this.dismissedItemKeys.has(desktopAgentCLIUpdateItemKey(item))) {
      return;
    }
    this.actionStates.set(item.provider, { item, phase: "completed" });
    this.reconcile();
  }

  private markFailed(item: DesktopAgentCLIUpdateItem): void {
    if (this.dismissedItemKeys.has(desktopAgentCLIUpdateItemKey(item))) {
      return;
    }
    this.actionStates.set(item.provider, { item, phase: "failed" });
    this.reconcile();
  }

  private dismissItem(item: DesktopAgentCLIUpdateItem): void {
    this.dismissedItemKeys.add(desktopAgentCLIUpdateItemKey(item));
    this.clearCompletionTimer(item.provider);
    this.actionStates.delete(item.provider);
    this.reconcile();
  }

  private syncCompletionTimers(): void {
    for (const provider of desktopManagedAgentProviders) {
      const state = this.actionStates.get(provider);
      if (state?.phase !== "completed") {
        this.clearCompletionTimer(provider);
        continue;
      }
      if (this.completionTimers.has(provider)) {
        continue;
      }
      const timer = setTimeout(() => {
        this.completionTimers.delete(provider);
        this.dismissItem(state.item);
      }, this.dependencies.completedNoticeDurationMs ?? DEFAULT_COMPLETED_NOTICE_DURATION_MS);
      this.completionTimers.set(provider, timer);
    }
  }

  private clearCompletionTimer(provider: WorkspaceAgentProvider): void {
    const timer = this.completionTimers.get(provider);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.completionTimers.delete(provider);
  }

  private setSnapshot(snapshot: AgentCLIUpdateNoticeSnapshot): void {
    if (updateNoticeSnapshotsEqual(this.snapshot, snapshot)) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function noticeMatchesItem(
  notice: AgentGUIProviderUpdateNotice,
  item: DesktopAgentCLIUpdateItem
): boolean {
  return (
    notice.agentTargetId === item.agentTargetId &&
    notice.currentVersion === item.currentVersion &&
    notice.latestVersion === item.latestVersion
  );
}

function updateNoticeSnapshotsEqual(
  left: AgentCLIUpdateNoticeSnapshot,
  right: AgentCLIUpdateNoticeSnapshot
): boolean {
  return (
    left.notices.length === right.notices.length &&
    left.notices.every((notice, index) => {
      const candidate = right.notices[index];
      return (
        candidate !== undefined &&
        notice.agentTargetId === candidate.agentTargetId &&
        notice.currentVersion === candidate.currentVersion &&
        notice.latestVersion === candidate.latestVersion &&
        notice.phase === candidate.phase
      );
    })
  );
}
