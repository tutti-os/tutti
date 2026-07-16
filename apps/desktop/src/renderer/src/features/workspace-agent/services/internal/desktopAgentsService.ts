import type { AgentTarget, TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { AgentGUIAgent, AgentGUIProvider } from "@tutti-os/agent-gui";
import type {
  AgentsSnapshot,
  AgentTargetPresentation,
  IAgentsService
} from "../agentsService.interface.ts";

export interface DesktopAgentsServiceDependencies {
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
  resolveAgentTargetIconUrl?: (identity: {
    iconKey: string | null;
    provider: string;
  }) => string;
  retryDelayMs?: number;
  setTimeout?: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  tuttidClient: Pick<TuttidClient, "listAgentTargets">;
}

const EMPTY_AGENTS_SNAPSHOT: AgentsSnapshot = Object.freeze({
  agents: Object.freeze([]),
  agentTargets: Object.freeze([]),
  capturedAtUnixMs: null,
  error: null,
  status: "idle"
});

export class DesktopAgentsService implements IAgentsService {
  readonly _serviceBrand = undefined;

  private readonly dependencies: DesktopAgentsServiceDependencies;
  private readonly listeners = new Set<() => void>();
  private loadPromise: Promise<AgentsSnapshot> | null = null;
  private disposed = false;
  private requestSequence = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: AgentsSnapshot = EMPTY_AGENTS_SNAPSHOT;

  constructor(dependencies: DesktopAgentsServiceDependencies) {
    this.dependencies = dependencies;
  }

  getSnapshot(): AgentsSnapshot {
    return this.snapshot;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.requestSequence += 1;
    this.clearScheduledRetry();
    this.listeners.clear();
  }

  getAgentTarget(input: {
    agentTargetId: string;
  }): AgentTargetPresentation | null {
    const agentTargetId = input.agentTargetId.trim();
    if (!agentTargetId) {
      return null;
    }
    return (
      this.snapshot.agentTargets.find(
        (target) => target.agentTargetId === agentTargetId
      ) ?? null
    );
  }

  hydrate(snapshot: AgentsSnapshot): void {
    if (this.snapshot.status !== "idle" || snapshot.status === "idle") {
      return;
    }
    this.setSnapshot(snapshot);
  }

  load(signal?: AbortSignal): Promise<AgentsSnapshot> {
    if (this.snapshot.status === "ready") {
      return Promise.resolve(this.snapshot);
    }
    return this.requestSnapshot(signal);
  }

  refresh(signal?: AbortSignal): Promise<AgentsSnapshot> {
    return this.requestSnapshot(signal);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private requestSnapshot(signal?: AbortSignal): Promise<AgentsSnapshot> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.clearScheduledRetry();
    const request = this.fetchSnapshot(signal).finally(() => {
      if (this.loadPromise === request) {
        this.loadPromise = null;
      }
    });
    this.loadPromise = request;
    return request;
  }

  private async fetchSnapshot(signal?: AbortSignal): Promise<AgentsSnapshot> {
    if (signal?.aborted) {
      return this.snapshot;
    }
    const previousSnapshot = this.snapshot;
    const requestSequence = ++this.requestSequence;
    this.setSnapshot({
      ...previousSnapshot,
      error: null,
      status: "loading"
    });
    try {
      const response = await this.dependencies.tuttidClient.listAgentTargets();
      if (signal?.aborted || requestSequence !== this.requestSequence) {
        if (requestSequence === this.requestSequence) {
          this.setSnapshot(previousSnapshot);
        }
        return this.snapshot;
      }
      const daemonAgentTargets = mapAgentTargetsToPresentations(
        response.targets,
        {
          resolveAgentTargetIconUrl: this.dependencies.resolveAgentTargetIconUrl
        }
      );
      const agentTargets = daemonAgentTargets;
      const agents = mapAgentTargetPresentationsToAgents(daemonAgentTargets);
      const nextSnapshot: AgentsSnapshot = {
        agents,
        agentTargets,
        capturedAtUnixMs: this.dependencies.now?.() ?? Date.now(),
        error: null,
        status: "ready"
      };
      this.setSnapshot(nextSnapshot);
      return nextSnapshot;
    } catch (error) {
      if (signal?.aborted || requestSequence !== this.requestSequence) {
        if (requestSequence === this.requestSequence) {
          this.setSnapshot(previousSnapshot);
        }
        return this.snapshot;
      }
      this.setSnapshot({
        ...previousSnapshot,
        error: error instanceof Error ? error.message : String(error),
        status: "error"
      });
      this.scheduleRetry();
      throw error;
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) {
      return;
    }
    const schedule = this.dependencies.setTimeout ?? setTimeout;
    this.retryTimer = schedule(() => {
      this.retryTimer = null;
      void this.requestSnapshot().catch(() => undefined);
    }, this.dependencies.retryDelayMs ?? 5_000);
    this.retryTimer.unref?.();
  }

  private clearScheduledRetry(): void {
    if (!this.retryTimer) {
      return;
    }
    const cancel = this.dependencies.clearTimeout ?? clearTimeout;
    cancel(this.retryTimer);
    this.retryTimer = null;
  }

  private setSnapshot(snapshot: AgentsSnapshot): void {
    this.snapshot = snapshot;
    this.emit();
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function mapAgentTargetsToPresentations(
  targets: readonly AgentTarget[],
  options: {
    resolveAgentTargetIconUrl?: (identity: {
      iconKey: string | null;
      provider: string;
    }) => string;
  } = {}
): readonly AgentTargetPresentation[] {
  return [...targets].sort(compareAgentTargetsForDisplay).map((target) => ({
    agentTargetId: target.id,
    createdAtUnixMs: target.createdAtUnixMs,
    enabled: target.enabled === true,
    iconKey: target.iconKey ?? null,
    iconUrl:
      target.iconUrl?.trim() ||
      (options.resolveAgentTargetIconUrl?.({
        iconKey: target.iconKey?.trim() || null,
        provider: target.provider
      }) ??
        ""),
    heroImageUrl: target.heroImageUrl?.trim() || null,
    availability: {
      status:
        target.availability?.status === "not_installed"
          ? "not_installed"
          : target.availability?.status === "auth_required"
            ? "auth_required"
            : target.availability?.status === "unsupported" ||
                target.availability?.status === "unknown"
              ? "unavailable"
              : "ready"
    },
    launchRefType: target.launchRef.type,
    name: target.name,
    provider: target.provider,
    sortOrder: target.sortOrder,
    source: target.source,
    updatedAtUnixMs: target.updatedAtUnixMs
  }));
}

export function mapAgentTargetPresentationsToAgents(
  targets: readonly AgentTargetPresentation[]
): readonly AgentGUIAgent[] {
  return targets
    .filter((target) => target.enabled)
    .map((target) => ({
      agentTargetId: target.agentTargetId,
      name: target.name,
      iconUrl: target.iconUrl,
      ...(target.heroImageUrl ? { heroImageUrl: target.heroImageUrl } : {}),
      availability: target.availability,
      provider: target.provider as AgentGUIProvider
    }));
}

function compareAgentTargetsForDisplay(
  left: AgentTarget,
  right: AgentTarget
): number {
  return (
    left.sortOrder - right.sortOrder ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}
