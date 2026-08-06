import type {
  AgentGUIProviderUpdateNotice,
  AgentGUIProviderUpdateNoticeAction,
  AgentGUIProviderUpdateNoticePhase
} from "@tutti-os/agent-gui";
import type {
  AgentProviderStatus,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import { subscribe as subscribeValtio } from "valtio";
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
  projectDesktopAgentCLIUpdateNoticesForTarget,
  projectDesktopAgentCLIUpdateItems,
  type DesktopAgentCLIUpdateItem
} from "./desktopAgentCLIUpdateNoticeModel.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";

const DEFAULT_COMPLETED_NOTICE_DURATION_MS = 6_000;
const DEFAULT_DISCOVERY_REQUEST_MIN_INTERVAL_MS = 30_000;
const EMPTY_UPDATE_NOTICE_SNAPSHOT: AgentCLIUpdateNoticeSnapshot = {
  notices: []
};

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
  tuttidClient: Pick<
    TuttidClient,
    "getAgentTargetRuntimeUpdate" | "updateAgentTargetRuntime"
  >;
  workspaceId: string;
  completedNoticeDurationMs?: number;
  discoveryRequestMinIntervalMs?: number;
  now?: () => number;
}

export class DesktopAgentCLIUpdateNoticeService implements IAgentCLIUpdateNoticeService {
  readonly _serviceBrand = undefined;

  private snapshot: AgentCLIUpdateNoticeSnapshot = { notices: [] };
  private readonly targetSnapshots = new Map<
    string,
    AgentCLIUpdateNoticeSnapshot
  >();
  private readonly listeners = new Set<() => void>();
  private readonly eligibleSurfaceIds = new Set<string>();
  private readonly eligibleSurfaceTargets = new Map<string, string>();
  private readonly extensionItems = new Map<
    string,
    DesktopAgentCLIUpdateItem
  >();
  private readonly extensionCheckedTargets = new Set<string>();
  private readonly dismissedItemKeys = new Set<string>();
  private readonly actionStates = new Map<
    string,
    DesktopAgentCLIUpdateActionState
  >();
  private readonly inflightItemKeys = new Set<string>();
  private readonly completionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly disposers: Array<() => void>;
  private presentations: readonly DesktopAgentCLIUpdatePresentation[] = [];
  private discoveryRequest: Promise<boolean> | null = null;
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
          void this.requestDiscovery();
        }
        this.reconcile();
      })
    ];
  }

  readonly getSnapshot = (): AgentCLIUpdateNoticeSnapshot => this.snapshot;

  readonly getSnapshotForTarget = (
    agentTargetId: string | null | undefined
  ): AgentCLIUpdateNoticeSnapshot => {
    const normalizedAgentTargetId = agentTargetId?.trim() ?? "";
    if (!normalizedAgentTargetId) {
      return EMPTY_UPDATE_NOTICE_SNAPSHOT;
    }
    const notices = projectDesktopAgentCLIUpdateNoticesForTarget(
      this.snapshot.notices,
      normalizedAgentTargetId
    );
    if (notices.length === 0) {
      this.targetSnapshots.delete(normalizedAgentTargetId);
      return EMPTY_UPDATE_NOTICE_SNAPSHOT;
    }
    const nextSnapshot = { notices };
    const previousSnapshot = this.targetSnapshots.get(normalizedAgentTargetId);
    if (
      previousSnapshot &&
      updateNoticeSnapshotsEqual(previousSnapshot, nextSnapshot)
    ) {
      return previousSnapshot;
    }
    this.targetSnapshots.set(normalizedAgentTargetId, nextSnapshot);
    return nextSnapshot;
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  refreshForWindowActivation(): Promise<boolean> {
    return this.requestDiscovery();
  }

  setSurfaceEligible(
    surfaceId: string,
    eligible: boolean,
    agentTargetId?: string | null
  ): void {
    const normalizedSurfaceId = surfaceId.trim();
    const normalizedAgentTargetId = agentTargetId?.trim() ?? "";
    if (this.disposed || !normalizedSurfaceId) {
      return;
    }
    const previousTarget = this.eligibleSurfaceTargets.get(normalizedSurfaceId);
    const changed = eligible
      ? !this.eligibleSurfaceIds.has(normalizedSurfaceId) ||
        previousTarget !== normalizedAgentTargetId
      : this.eligibleSurfaceIds.has(normalizedSurfaceId);
    if (!changed) {
      return;
    }
    if (eligible) {
      this.eligibleSurfaceIds.add(normalizedSurfaceId);
      if (normalizedAgentTargetId) {
        this.eligibleSurfaceTargets.set(
          normalizedSurfaceId,
          normalizedAgentTargetId
        );
      } else {
        this.eligibleSurfaceTargets.delete(normalizedSurfaceId);
      }
      void this.requestDiscovery();
    } else {
      this.eligibleSurfaceIds.delete(normalizedSurfaceId);
      this.eligibleSurfaceTargets.delete(normalizedSurfaceId);
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
    this.eligibleSurfaceTargets.delete(normalizedSurfaceId);
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
      if (item.source === "agent_extension") {
        return;
      }
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
    this.eligibleSurfaceTargets.clear();
    this.extensionItems.clear();
    this.extensionCheckedTargets.clear();
    this.inflightItemKeys.clear();
    this.targetSnapshots.clear();
  }

  private requestDiscovery(): Promise<boolean> {
    const now = this.dependencies.now?.() ?? Date.now();
    if (
      this.disposed ||
      this.eligibleSurfaceIds.size === 0 ||
      !this.autoCheckEnabled
    ) {
      return Promise.resolve(false);
    }
    if (this.discoveryRequest) {
      return this.discoveryRequest;
    }
    const hasUncheckedExtensionTarget = [
      ...this.eligibleSurfaceTargets.values()
    ].some((agentTargetId) => !this.extensionCheckedTargets.has(agentTargetId));
    if (
      !hasUncheckedExtensionTarget &&
      now - this.lastDiscoveryRequestedAt <
        (this.dependencies.discoveryRequestMinIntervalMs ??
          DEFAULT_DISCOVERY_REQUEST_MIN_INTERVAL_MS)
    ) {
      return Promise.resolve(false);
    }
    this.lastDiscoveryRequestedAt = now;
    const request = Promise.all([
      this.dependencies.providerStatusService
        .ensureLoaded({
          includeUpdates: true,
          providers: [...desktopManagedAgentProviders]
        })
        .then((response) => response !== null)
        .catch(() => false),
      this.discoverExtensionUpdates()
    ]).then((results) => results.some(Boolean));
    this.discoveryRequest = request;
    void request.finally(() => {
      if (this.discoveryRequest === request) {
        this.discoveryRequest = null;
        if (
          [...this.eligibleSurfaceTargets.values()].some(
            (agentTargetId) => !this.extensionCheckedTargets.has(agentTargetId)
          )
        ) {
          void this.requestDiscovery();
        }
      }
    });
    return request;
  }

  private reconcile(): void {
    if (this.disposed) {
      return;
    }
    const providerSnapshot =
      this.dependencies.providerStatusService.getSnapshot();
    const availableItems = this.autoCheckEnabled
      ? [
          ...projectDesktopAgentCLIUpdateItems(
            providerSnapshot.statuses,
            this.dependencies.agentsService.getSnapshot().agents
          ),
          ...this.extensionItems.values()
        ]
      : [];
    this.reconcileActionStates(availableItems, providerSnapshot.statuses);

    const presentationsByItemKey = new Map<
      string,
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
          presentationsByItemKey.set(desktopAgentCLIUpdateItemKey(item), {
            item,
            phase:
              item.source !== "agent_extension" &&
              pendingProviders.has(item.provider)
                ? "updating"
                : "available"
          });
        }
      }
      for (const state of this.actionStates.values()) {
        presentationsByItemKey.set(
          desktopAgentCLIUpdateItemKey(state.item),
          state
        );
      }
    }
    this.presentations = [...presentationsByItemKey.values()];
    this.syncCompletionTimers();
    this.setSnapshot({
      notices: this.presentations.map(({ item, phase }) => ({
        agentTargetId: item.agentTargetId,
        currentVersion: item.currentVersion,
        latestVersion: item.latestVersion,
        phase,
        ...(item.source === "agent_extension"
          ? ({ detailsTarget: "target-runtime" } as const)
          : {})
      }))
    });
  }

  private reconcileActionStates(
    availableItems: readonly DesktopAgentCLIUpdateItem[],
    statuses: readonly AgentProviderStatus[]
  ): void {
    const availableByItemKey = new Map(
      availableItems.map((item) => [desktopAgentCLIUpdateItemKey(item), item])
    );
    const statusByProvider = new Map(
      statuses.map((status) => [status.provider, status])
    );
    for (const [itemKey, state] of this.actionStates) {
      if (this.dismissedItemKeys.has(itemKey)) {
        this.actionStates.delete(itemKey);
        continue;
      }
      if (
        state.item.source !== "agent_extension" &&
        state.phase !== "completed" &&
        hasDesktopAgentCLIUpdateConverged(
          state.item,
          statusByProvider.get(state.item.provider)?.update
        )
      ) {
        this.actionStates.set(itemKey, {
          item: state.item,
          phase: "completed"
        });
        continue;
      }
      const availableItem = availableByItemKey.get(itemKey);
      if (
        state.phase !== "updating" &&
        availableItem &&
        !desktopAgentCLIUpdateItemsEqual(state.item, availableItem)
      ) {
        this.clearCompletionTimer(itemKey);
        this.actionStates.delete(itemKey);
      } else if (state.phase === "failed" && !availableItem) {
        this.clearCompletionTimer(itemKey);
        this.actionStates.delete(itemKey);
      }
    }
  }

  private async updateItem(item: DesktopAgentCLIUpdateItem): Promise<void> {
    const itemKey = desktopAgentCLIUpdateItemKey(item);
    if (this.inflightItemKeys.has(itemKey)) {
      return;
    }
    this.inflightItemKeys.add(itemKey);
    this.clearCompletionTimer(itemKey);
    this.actionStates.set(itemKey, { item, phase: "updating" });
    this.reconcile();
    try {
      if (item.source === "agent_extension") {
        const result =
          await this.dependencies.tuttidClient.updateAgentTargetRuntime(
            this.dependencies.workspaceId,
            item.agentTargetId,
            {
              currentVersion: item.currentVersion,
              latestVersion: item.latestVersion
            }
          );
        const currentVersion = result.currentVersion?.trim() ?? "";
        if (result.available || !currentVersion) {
          const unresolvedItem = {
            ...item,
            currentVersion: currentVersion || item.currentVersion,
            latestVersion: result.latestVersion ?? item.latestVersion
          };
          this.extensionItems.set(item.agentTargetId, unresolvedItem);
          if (!this.disposed) {
            this.markFailed(unresolvedItem);
          }
        } else {
          this.extensionItems.delete(item.agentTargetId);
          if (!this.disposed) {
            this.markCompleted(item);
          }
        }
        return;
      } else {
        await this.dependencies.providerStatusService.runAction(
          item.provider,
          "update",
          {
            context: { workspaceId: this.dependencies.workspaceId },
            origin: "user"
          }
        );
      }
      if (!this.disposed) {
        if (this.hasConverged(item)) {
          this.markCompleted(item);
        } else {
          this.markFailed(item);
        }
      }
    } catch {
      const extensionConverged =
        item.source === "agent_extension"
          ? await this.hasExtensionConverged(item)
          : false;
      if (!this.disposed) {
        if (
          extensionConverged ||
          (item.source !== "agent_extension" && this.hasConverged(item))
        ) {
          this.markCompleted(item);
        } else {
          this.markFailed(
            item.source === "agent_extension"
              ? (this.extensionItems.get(item.agentTargetId) ?? item)
              : item
          );
        }
      }
    } finally {
      this.inflightItemKeys.delete(itemKey);
    }
  }

  private hasConverged(item: DesktopAgentCLIUpdateItem): boolean {
    return hasDesktopAgentCLIUpdateConverged(
      item,
      this.dependencies.providerStatusService.getStatus(item.provider)?.update
    );
  }

  private async hasExtensionConverged(
    item: DesktopAgentCLIUpdateItem
  ): Promise<boolean> {
    try {
      const update =
        await this.dependencies.tuttidClient.getAgentTargetRuntimeUpdate(
          this.dependencies.workspaceId,
          item.agentTargetId
        );
      const currentVersion = update.currentVersion?.trim() ?? "";
      const latestVersion = update.latestVersion?.trim() ?? "";
      if (!update.available && currentVersion) {
        this.extensionItems.delete(item.agentTargetId);
        return true;
      }
      if (update.available && currentVersion && latestVersion) {
        this.extensionItems.set(item.agentTargetId, {
          ...item,
          currentVersion,
          latestVersion
        });
      }
    } catch {
      // The failed action remains retryable when convergence cannot be proven.
    }
    return false;
  }

  private markCompleted(item: DesktopAgentCLIUpdateItem): void {
    if (this.dismissedItemKeys.has(desktopAgentCLIUpdateItemKey(item))) {
      return;
    }
    this.actionStates.set(desktopAgentCLIUpdateItemKey(item), {
      item,
      phase: "completed"
    });
    this.reconcile();
  }

  private markFailed(item: DesktopAgentCLIUpdateItem): void {
    if (this.dismissedItemKeys.has(desktopAgentCLIUpdateItemKey(item))) {
      return;
    }
    this.actionStates.set(desktopAgentCLIUpdateItemKey(item), {
      item,
      phase: "failed"
    });
    this.reconcile();
  }

  private dismissItem(item: DesktopAgentCLIUpdateItem): void {
    const itemKey = desktopAgentCLIUpdateItemKey(item);
    this.dismissedItemKeys.add(itemKey);
    this.clearCompletionTimer(itemKey);
    this.actionStates.delete(itemKey);
    this.reconcile();
  }

  private syncCompletionTimers(): void {
    for (const itemKey of this.actionStates.keys()) {
      const state = this.actionStates.get(itemKey);
      if (state?.phase !== "completed") {
        this.clearCompletionTimer(itemKey);
        continue;
      }
      if (this.completionTimers.has(itemKey)) {
        continue;
      }
      const timer = setTimeout(() => {
        this.completionTimers.delete(itemKey);
        this.dismissItem(state.item);
      }, this.dependencies.completedNoticeDurationMs ?? DEFAULT_COMPLETED_NOTICE_DURATION_MS);
      this.completionTimers.set(itemKey, timer);
    }
  }

  private clearCompletionTimer(itemKey: string): void {
    const timer = this.completionTimers.get(itemKey);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.completionTimers.delete(itemKey);
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

  private async discoverExtensionUpdates(): Promise<boolean> {
    const targetIds = new Set(this.eligibleSurfaceTargets.values());
    if (targetIds.size === 0) {
      return false;
    }
    const agentsByTarget = new Map(
      this.dependencies.agentsService
        .getSnapshot()
        .agents.map((agent) => [agent.agentTargetId.trim(), agent])
    );
    let handled = false;
    await Promise.all(
      [...targetIds].map(async (agentTargetId) => {
        this.extensionCheckedTargets.add(agentTargetId);
        const agent = agentsByTarget.get(agentTargetId);
        if (!agent || agent.setupKind !== "target_runtime") {
          this.extensionItems.delete(agentTargetId);
          return;
        }
        handled = true;
        try {
          const update =
            await this.dependencies.tuttidClient.getAgentTargetRuntimeUpdate(
              this.dependencies.workspaceId,
              agentTargetId
            );
          const currentVersion = update.currentVersion?.trim() ?? "";
          const latestVersion = update.latestVersion?.trim() ?? "";
          if (!update.available || !currentVersion || !latestVersion) {
            this.extensionItems.delete(agentTargetId);
            return;
          }
          this.extensionItems.set(agentTargetId, {
            agentTargetId,
            currentVersion,
            latestVersion,
            provider: agent.provider,
            source: "agent_extension"
          });
        } catch {
          // Keep the last verified candidate during a transient refresh failure.
        }
      })
    );
    this.reconcile();
    return handled;
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
        notice.detailsTarget === candidate.detailsTarget &&
        notice.latestVersion === candidate.latestVersion &&
        notice.phase === candidate.phase
      );
    })
  );
}
