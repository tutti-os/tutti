import type {
  AgentTarget,
  TuttidClient,
  WorkspaceAgent
} from "@tutti-os/client-tuttid-ts";
import type { AgentGUIAgent, AgentGUIProvider } from "@tutti-os/agent-gui";
import {
  isAgentGuiWorkbenchProvider,
  isAgentGuiWorkbenchProviderVisibleWithEarlyAccess
} from "@tutti-os/agent-gui/workbench/providerCatalog";
import type {
  AgentsSnapshot,
  AgentTargetPresentation,
  IAgentsService
} from "../agentsService.interface.ts";

export interface DesktopAgentsServiceDependencies {
  earlyAccessEnabled?: boolean;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  isAgentTargetProviderGated?: (provider: string) => boolean;
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
  tuttidClient: Pick<TuttidClient, "listAgentTargets" | "listWorkspaceAgents">;
  workspaceId: string;
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
  private earlyAccessEnabled: boolean;

  constructor(dependencies: DesktopAgentsServiceDependencies) {
    this.dependencies = dependencies;
    this.earlyAccessEnabled = dependencies.earlyAccessEnabled ?? false;
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
    this.setSnapshot({
      ...snapshot,
      agents: mapAgentTargetPresentationsToAgents(snapshot.agentTargets, {
        earlyAccessEnabled: this.earlyAccessEnabled
      })
    });
  }

  setEarlyAccessEnabled(enabled: boolean): void {
    if (this.earlyAccessEnabled === enabled) {
      return;
    }
    this.earlyAccessEnabled = enabled;
    this.setSnapshot({
      ...this.snapshot,
      agents: mapAgentTargetPresentationsToAgents(this.snapshot.agentTargets, {
        earlyAccessEnabled: enabled
      })
    });
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
      const [targetResponse, workspaceAgentResponse] = await Promise.all([
        this.dependencies.tuttidClient.listAgentTargets(),
        this.dependencies.tuttidClient.listWorkspaceAgents(
          this.dependencies.workspaceId
        )
      ]);
      if (signal?.aborted || requestSequence !== this.requestSequence) {
        if (requestSequence === this.requestSequence) {
          this.setSnapshot(previousSnapshot);
        }
        return this.snapshot;
      }
      const daemonAgentTargets = mapAgentTargetsToPresentations(
        targetResponse.targets,
        {
          resolveAgentTargetIconUrl: this.dependencies.resolveAgentTargetIconUrl
        }
      );
      const daemonAgentTargetIconUrls = new Map(
        daemonAgentTargets.map((target) => [
          target.agentTargetId,
          target.iconUrl
        ])
      );
      const agentTargets = daemonAgentTargets;
      // Built-in Harness targets and explicit workspace Agents coexist in the
      // AgentGUI directory: built-ins keep their placement and workspace
      // Agents are appended, deduped by agentTargetId.
      const builtinAgents = mapAgentTargetPresentationsToAgents(
        daemonAgentTargets,
        { earlyAccessEnabled: this.earlyAccessEnabled }
      );
      const workspaceAgents = mapWorkspaceAgentsToAgents(
        workspaceAgentResponse.agents,
        {
          isAgentTargetProviderGated:
            this.dependencies.isAgentTargetProviderGated,
          resolveAgentTargetIconUrl: ({ agentTargetId, iconKey, provider }) =>
            daemonAgentTargetIconUrls.get(agentTargetId)?.trim() ||
            this.dependencies.resolveAgentTargetIconUrl?.({
              iconKey,
              provider
            }) ||
            ""
        }
      );
      const agents = dedupeAgentsByAgentTargetId([
        ...builtinAgents,
        ...workspaceAgents
      ]);
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

function dedupeAgentsByAgentTargetId(
  agents: readonly AgentGUIAgent[]
): readonly AgentGUIAgent[] {
  const seenAgentTargetIds = new Set<string>();
  return agents.filter((agent) => {
    if (seenAgentTargetIds.has(agent.agentTargetId)) {
      return false;
    }
    seenAgentTargetIds.add(agent.agentTargetId);
    return true;
  });
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
  return [...targets].sort(compareAgentTargetsForDisplay).map((target) => {
    const isExtension = target.launchRef.type === "agent_extension";
    const iconUrl =
      target.iconUrl?.trim() ||
      (isExtension
        ? ""
        : (options.resolveAgentTargetIconUrl?.({
            iconKey: target.iconKey?.trim() || null,
            provider: target.provider
          }) ?? ""));
    return {
      agentTargetId: target.id,
      createdAtUnixMs: target.createdAtUnixMs,
      enabled: target.enabled === true,
      iconKey: target.iconKey ?? null,
      iconUrl,
      maskIconUrl: target.maskIconUrl?.trim() || null,
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
    };
  });
}

export function mapAgentTargetPresentationsToAgents(
  targets: readonly AgentTargetPresentation[],
  options: { earlyAccessEnabled?: boolean } = {}
): readonly AgentGUIAgent[] {
  return targets
    .filter(
      (target) =>
        target.enabled &&
        (options.earlyAccessEnabled === true ||
          (target.launchRefType !== "agent_extension" &&
            (!isAgentGuiWorkbenchProvider(target.provider) ||
              isAgentGuiWorkbenchProviderVisibleWithEarlyAccess(
                target.provider,
                false
              ))))
    )
    .map((target) => ({
      agentTargetId: target.agentTargetId,
      name: target.name,
      iconUrl: target.iconUrl,
      ...(target.maskIconUrl ? { maskIconUrl: target.maskIconUrl } : {}),
      ...(target.heroImageUrl ? { heroImageUrl: target.heroImageUrl } : {}),
      availability: target.availability,
      provider: target.provider as AgentGUIProvider,
      ...(target.launchRefType === "agent_extension"
        ? { setupKind: "target_runtime" as const }
        : {})
    }));
}

export function mapWorkspaceAgentsToAgents(
  agents: readonly WorkspaceAgent[],
  options: {
    isAgentTargetProviderGated?: (provider: string) => boolean;
    resolveAgentTargetIconUrl?: (identity: {
      agentTargetId: string;
      iconKey: string | null;
      provider: string;
    }) => string;
  } = {}
): readonly AgentGUIAgent[] {
  return agents.flatMap((agent) => {
    const provider = agent.harness.provider;
    if (!provider) {
      return [];
    }
    const availability =
      options.isAgentTargetProviderGated?.(provider) === true
        ? ({ status: "coming_soon" } as const)
        : !agent.harness.available || agent.harness.enabled === false
          ? ({ status: "unavailable" } as const)
          : ({ status: "ready" } as const);
    return [
      {
        agentTargetId: agent.id,
        availability,
        description: agent.description || null,
        iconUrl:
          options.resolveAgentTargetIconUrl?.({
            agentTargetId: agent.harness.agentTargetId,
            iconKey: agent.harness.iconKey?.trim() || null,
            provider
          }) ?? "",
        name: agent.name,
        provider: provider as AgentGUIProvider
      }
    ];
  });
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
