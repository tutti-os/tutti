import type { AgentTarget, TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { AgentGUIAgent, AgentGUIProvider } from "@tutti-os/agent-gui";
import type {
  AgentsSnapshot,
  AgentTargetPresentation,
  IAgentsService
} from "../agentsService.interface.ts";

export interface DesktopAgentsServiceDependencies {
  now?: () => number;
  resolveAgentTargetIconUrl?: (identity: {
    iconKey: string | null;
    provider: string;
  }) => string;
  /** Feature gate: gated providers keep their targets but are forced disabled (coming soon). */
  isAgentTargetProviderGated?: (provider: string) => boolean;
  tuttidClient: Pick<TuttidClient, "listAgentTargets">;
}

const EMPTY_AGENTS_SNAPSHOT: AgentsSnapshot = Object.freeze({
  agents: Object.freeze([]),
  agentTargets: Object.freeze([]),
  capturedAtUnixMs: null
});

export class DesktopAgentsService implements IAgentsService {
  readonly _serviceBrand = undefined;

  private readonly dependencies: DesktopAgentsServiceDependencies;
  private readonly listeners = new Set<() => void>();
  private loadPromise: Promise<AgentsSnapshot> | null = null;
  private requestSequence = 0;
  private snapshot: AgentsSnapshot = EMPTY_AGENTS_SNAPSHOT;

  constructor(dependencies: DesktopAgentsServiceDependencies) {
    this.dependencies = dependencies;
  }

  getSnapshot(): AgentsSnapshot {
    return this.snapshot;
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

  load(signal?: AbortSignal): Promise<AgentsSnapshot> {
    if (!this.loadPromise) {
      this.loadPromise = this.fetchSnapshot(signal).finally(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  refresh(signal?: AbortSignal): Promise<AgentsSnapshot> {
    this.loadPromise = null;
    return this.fetchSnapshot(signal);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async fetchSnapshot(signal?: AbortSignal): Promise<AgentsSnapshot> {
    if (signal?.aborted) {
      return this.snapshot;
    }
    const requestSequence = ++this.requestSequence;
    const response = await this.dependencies.tuttidClient.listAgentTargets();
    if (signal?.aborted || requestSequence !== this.requestSequence) {
      return this.snapshot;
    }
    const daemonAgentTargets = mapAgentTargetsToPresentations(
      response.targets,
      {
        resolveAgentTargetIconUrl: this.dependencies.resolveAgentTargetIconUrl
      }
    );
    const agentTargets = daemonAgentTargets.map((target) =>
      this.dependencies.isAgentTargetProviderGated?.(target.provider) === true
        ? { ...target, enabled: false }
        : target
    );
    const agents = mapAgentTargetPresentationsToAgents(daemonAgentTargets).map(
      (agent) =>
        this.dependencies.isAgentTargetProviderGated?.(agent.provider) === true
          ? { ...agent, availability: { status: "coming_soon" as const } }
          : agent
    );
    const nextSnapshot: AgentsSnapshot = {
      agents,
      agentTargets,
      capturedAtUnixMs: this.dependencies.now?.() ?? Date.now()
    };
    this.snapshot = nextSnapshot;
    this.emit();
    return nextSnapshot;
  }

  private emit(): void {
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
      options.resolveAgentTargetIconUrl?.({
        iconKey: target.iconKey?.trim() || null,
        provider: target.provider
      }) ?? "",
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
      availability: { status: "ready" },
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
